import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sanitizedFrame, safeEvent, safePage } from './teach-safety.mjs';
const LIMIT = 5 * 1024 * 1024; // Base64 must fit the existing 8 MiB framed channel.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(Error(code), { code });
export class TeachCapture {
  constructor(context, { env, frame = sanitizedFrame, spawnEncoder = spawn, now = () => performance.now() } = {}) {
    this.context = context; this.env = env; this.frame = frame; this.spawn = spawnEncoder; this.now = now;
    this.state = 'aborted'; this.artifacts = new Map(); this.epoch = 0; this.active = 0; this.events = []; this.audio = []; this.total = 0;
  }
  activeMs() { return Math.min(120000, Math.round(this.active + (this.state === 'recording' ? this.now() - this.since : 0))); }
  status() { return { captureId: this.captureId, state: this.state, ...(this.reason ? { reason: this.reason } : {}), activeMs: this.activeMs(), eventCount: this.events.length, narration: !!this.narration }; }
  pause(reason = 'owner_paused') { if (this.state === 'recording') this.active = this.activeMs(); if (['recording','paused'].includes(this.state)) { this.state = 'paused'; this.reason = reason; this.segmentFloor = this.active; ++this.epoch; } return this.status(); }
  abort(reason = 'lease_lost') { this.pause(reason); this.state = 'aborted'; this.reason = reason; ++this.epoch; clearInterval(this.timer); const oldEncoder = this.encoder; this.encoder = null; oldEncoder?.kill('SIGKILL'); this.artifacts.clear(); this.events = []; this.audio = []; this.video = []; this.lastFrame = undefined; this.total = 0; return this.captureId ? this.status() : null; }
  put(bytes, mime, kind) {
    if (bytes.length > LIMIT || this.total + bytes.length > 128 * 1024 * 1024) throw failure('capture_limit');
    const id = hash(bytes); if (!this.artifacts.has(id)) { this.artifacts.set(id, { bytes, mime, kind }); this.total += bytes.length; } return id;
  }
  async shot() {
    const epoch = this.epoch;
    if (this.state !== 'recording') throw failure('capture_paused');
    if (this.activeMs() >= 120000 || this.events.length >= 300) { this.pause('capture_limit'); throw failure('capture_limit'); }
    try {
      const frame = await this.frame(this.context, this.page);
      if (this.state !== 'recording' || epoch !== this.epoch) throw failure('capture_paused');
      this.page = frame.page; this.latestSafeMs = this.activeMs(); return { ...frame, epoch };
    } catch (e) { if (this.state === 'recording') this.pause(['unsupported_surface','unsupported_frames','unsupported_shadow','unknown_focus','sensitive_surface','unsupported_dimensions'].includes(e.message) ? e.message : 'safety_check_failed'); throw failure('capture_paused'); }
  }
  async tick() {
    if (this.busy || this.state !== 'recording') return;
    this.busy = true;
    try { const frame = await this.shot(); if (this.state === 'recording' && frame.epoch === this.epoch) {
      await this.encodeThrough(frame.png, this.activeMs());
    } } catch { /* shot pauses before any frame is committed */ } finally { this.busy = false; }
  }
  async encodeThrough(png, activeMs) {
    // CFR timestamps represent ACTIVE capture time. Missing 200ms slots reuse only
    // an already sanitized in-memory frame; paused wall time contributes no slots.
    const target = Math.min(600, Math.max(1, Math.ceil(activeMs / 200)));
    const epoch = this.epoch;
    while (this.frames < target) {
      if (this.epoch !== epoch || !this.encoder) return;
      const bytes = this.frames === target - 1 ? png : this.lastFrame ?? png;
      const encoder = this.encoder;
      try {
        await new Promise((resolve,reject) => {
          const timer = setTimeout(() => reject(failure('encoder_backpressure')), 500);
          encoder.stdin.write(bytes, error => { clearTimeout(timer); if(error) reject(error); else resolve(); });
          this.frames++;
        });
      } catch { if (this.epoch === epoch) this.fail('encoder_backpressure'); return; }
      if (this.epoch !== epoch) return;
    }
    this.lastFrame = png;
  }
  async start(command) {
    if (['recording','paused','finalizing'].includes(this.state)) throw failure('capture_conflict');
    this.abort('replaced'); this.captureId = command.captureId; this.state = 'recording'; this.reason = undefined; this.active = 0; this.segmentFloor = 0; this.latestSafeMs = 0; this.since = this.now(); this.events = []; this.audio = []; this.video = []; this.videoSize = 0; this.frames = 0; this.lastFrame = undefined; this.narration = !!command.narration; this.timezone = command.timezone ?? 'UTC'; this.capturedAt = new Date().toISOString(); this.page = undefined;
    try { await this.shot(); } catch { return this.status(); }
    this.encoder = this.spawn('ffmpeg', ['-nostdin','-hide_banner','-loglevel','error','-f','image2pipe','-framerate','5','-vcodec','png','-i','pipe:0','-an','-vf','pad=1024:768:0:0:black','-c:v','libvpx','-b:v','200k','-threads','1','-f','webm','pipe:1'], { env: this.env, shell: false, stdio: ['pipe','pipe','ignore'] });
    const encoder = this.encoder;
    this.encoder.stdin.on('error', () => { if (this.encoder === encoder && this.state === 'recording') this.fail('encoder_failed'); });
    this.encoder.on('error', () => { if (this.encoder === encoder) this.fail('encoder_failed'); });
    this.encoder.stdout.on('data', chunk => { if (this.encoder !== encoder) return; if (!['recording','paused','finalizing'].includes(this.state)) return; this.videoSize += chunk.length; if (this.videoSize > LIMIT) this.fail('capture_limit'); else this.video.push(chunk); });
    this.encoderDone = new Promise(resolve => this.encoder.once('close', code => { if (this.encoder === encoder && code !== 0 && ['recording','paused','finalizing'].includes(this.state)) this.fail('encoder_failed'); resolve(code); }));
    this.timer = setInterval(() => { void this.tick(); }, 200); this.timer.unref(); await this.tick(); return this.status();
  }
  fail(reason) { this.abort(reason); this.state = 'failed'; }
  async around(command, run) {
    if (this.state !== 'recording') return run();
    let before; try { before = await this.shot(); } catch { return run(); }
    const result = await run();
    let after; try { after = await this.shot(); } catch { return result; }
    if (before.epoch !== after.epoch || this.state !== 'recording') return result;
    try {
      const beforeHash = this.put(before.png, 'image/png', 'before'); const afterHash = this.put(after.png, 'image/png', 'after');
      this.events.push({ ...safeEvent(command), sequence: this.events.length, offsetMs: this.activeMs(), beforeHash, afterHash, width: after.width, height: after.height, coordinateSpace:'screen', viewportOrigin:after.viewportOrigin ?? null, target: { kind: command.x === undefined ? 'focused-control-redacted' : 'point' } });
      this.lastFrame = after.png;
    } catch { this.fail('capture_limit'); }
    return result;
  }
  async command(command) {
    if (command.action === 'start') return this.start(command);
    if (command.captureId !== this.captureId) throw failure('capture_unavailable');
    if (command.action === 'discard') { this.abort('owner_discarded'); this.state='discarded'; return this.status(); }
    if (command.action === 'status') return this.status();
    if (command.action === 'pause') return this.pause();
    if (command.action === 'resume') {
      if (this.state !== 'paused') throw failure('capture_unavailable');
      if (!this.encoder) { this.state = 'aborted'; return this.start({ ...command, narration:this.narration, timezone:this.timezone }); }
      if (this.encoder.exitCode !== null) throw failure('capture_unavailable');
      try { await safePage(this.context, this.page); } catch { return this.status(); }
      this.state = 'recording'; this.segmentFloor = this.active; this.since = this.now(); this.reason = undefined; ++this.epoch; return this.status();
    }
    if (command.action === 'artifact') {
      const artifact = this.artifacts.get(command.hash);
      if (this.state !== 'complete' || !artifact) throw failure('capture_unavailable');
      return { ...this.status(), base64: artifact.bytes.toString('base64'), artifacts: [{ hash: command.hash, mime: artifact.mime, kind: artifact.kind, bytes: artifact.bytes.length }] };
    }
    if (command.action === 'audio') return this.acceptAudio(command);
    if (command.action !== 'stop' || !['recording','paused'].includes(this.state)) throw failure('capture_unavailable');
    this.pause();
    if (this.encoder && this.lastFrame) await this.encodeThrough(this.lastFrame, this.activeMs());
    if (this.state !== 'paused') return this.status();
    this.state = 'finalizing'; ++this.epoch; clearInterval(this.timer);
    if (!this.encoder || !this.frames) { this.fail('empty_capture'); return this.status(); }
    this.encoder.stdin.end();
    let timeout; const code = await Promise.race([this.encoderDone, new Promise(resolve => { timeout = setTimeout(() => resolve(-1), 3500); })]); clearTimeout(timeout);
    if (code !== 0 || this.state !== 'finalizing') { this.fail('encoder_failed'); return this.status(); }
    try {
      const videoHash = this.put(Buffer.concat(this.video), 'video/webm', 'video'); this.video = [];
      this.manifest = { version: 1, captureId: this.captureId, capturedAt: this.capturedAt, timezone: this.timezone, durationMs: this.activeMs(), videoHash, events: this.events, audio: this.audio, source_tag: 'web', untrusted: true };
      this.state = 'complete'; this.reason = undefined;
      return { ...this.status(), manifest: this.manifest, artifacts: [...this.artifacts].map(([hash,a]) => ({ hash, mime:a.mime, kind:a.kind, bytes:a.bytes.length })) };
    } catch { this.fail('capture_limit'); return this.status(); }
  }
  async acceptAudio(command) {
    const safeThrough = Math.min(this.latestSafeMs ?? 0, this.activeMs()) - 2000;
    if (!this.narration || this.state !== 'recording' || command.sequence !== this.audio.length || command.offsetMs < Math.max(this.segmentFloor ?? 0, (this.audio.at(-1)?.offsetMs ?? 0) + (this.audio.at(-1)?.durationMs ?? 0)) || command.offsetMs > this.activeMs()) throw failure('invalid_audio');
    const epoch = this.epoch; await this.shot(); const bytes = Buffer.from(command.base64, 'base64');
    if (bytes.toString('base64') !== command.base64 || bytes.length > 3 * 1024 * 1024) throw failure('invalid_audio');
    const child = this.spawn('ffmpeg', ['-nostdin','-hide_banner','-loglevel','error','-i','pipe:0','-ac','1','-ar','24000','-c:a','pcm_s16le','-f','s16le','pipe:1'], { env:this.env, shell:false, stdio:['pipe','pipe','ignore'] });
    const chunks=[]; let size=0;
    await new Promise((resolve,reject) => {
      const timer=setTimeout(() => { child.kill('SIGKILL'); reject(failure('invalid_audio')); },2500);
      child.on('error', () => { clearTimeout(timer); reject(failure('invalid_audio')); }); child.stdin.on('error',()=>{});
      child.stdout.on('data', chunk=>{ size+=chunk.length; if(size>480000) child.kill('SIGKILL'); else chunks.push(chunk); });
      child.once('close',code=>{clearTimeout(timer); if (code===0) resolve(); else reject(failure('invalid_audio'));}); child.stdin.end(bytes);
    });
    await this.shot(); if (this.epoch !== epoch || this.state !== 'recording') throw failure('capture_paused');
    const pcm=Buffer.concat(chunks); const durationMs=Math.ceil(pcm.length / 48);
    if (!pcm.length || pcm.length % 2 || durationMs > 10000 || command.offsetMs + durationMs > safeThrough) throw failure('invalid_audio');
    const header=Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36+pcm.length,4); header.write('WAVEfmt ',8); header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22); header.writeUInt32LE(24000,24); header.writeUInt32LE(48000,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34); header.write('data',36); header.writeUInt32LE(pcm.length,40);
    const wav=Buffer.concat([header,pcm]); const audioHash=this.put(wav,'audio/wav','audio');
    const segment={hash:audioHash,sequence:command.sequence,offsetMs:command.offsetMs,durationMs}; this.audio.push(segment);
    return {...this.status(),segment,artifacts:[{hash:audioHash,mime:'audio/wav',kind:'audio',bytes:wav.length}]};
  }
}
