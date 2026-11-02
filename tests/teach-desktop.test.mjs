import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess, minimalEnvironment } from '../scripts/spikes/volume-isolation.mjs';
import { validateDesktopTarget, validateWorkspace, SETUP_CAPS } from '../scripts/desktop-agent.mjs';
const OWNER='03600000-0000-4000-8000-000000000000', AGENT='03600000-0000-4000-8000-000000000001';
test('real managed-browser teach capture: masked video, paired inputs, privacy pauses, synthetic audio and scoped cleanup', {timeout:600000}, async()=>{
  const run=randomBytes(8).toString('hex'),project='eclipse036'+run,image=project+'-desktop:qa';
  const directory=path.resolve('data/spikes/task036',run);await mkdir(directory,{recursive:true});
  const report={run,stage:'preflight',outcome:'incomplete',cleanup:'incomplete'};
  const invoke=async(args,input,timeout=30000,extraEnv={})=>{
    const result=await runProcess('docker',args,{input,timeout,env:{...minimalEnvironment(),...extraEnv}});
    assert.ok(!result.timedOut&&!result.oversized,'Docker timed out/output overflow');
    assert.equal(result.status,0,'Docker '+args[0]+' failed at '+report.stage+': '+result.output.slice(-4000));return result.output.trim();
  };
  const configFile=path.join(directory,'compose.json'),envFile=path.join(directory,'empty.env');await writeFile(envFile,'');
  const composeArgs=['compose','--env-file',envFile,'-p',project,'-f',configFile];const secret=randomBytes(32).toString('hex');
  const compose=args=>invoke([...composeArgs,...args],undefined,120000,{TASK036_CONTROL:secret});
  let built=false,created=false,container,home;
  try{
    assert.equal(await invoke(['info','--format','{{.OSType}}']),'linux');report.stage='build';
    await invoke(['build','--label','ai.eclipse.task036.run='+run,'-t',image,'-f','docker/desktop/Dockerfile','docker/desktop'],undefined,240000);built=true;
    const config={services:{desktop:{image,user:'0:0',read_only:true,cap_drop:['ALL'],cap_add:SETUP_CAPS,
      security_opt:['no-new-privileges:true','seccomp='+path.resolve('docker/desktop/seccomp_profile.json')],init:false,shm_size:'128m',
      tmpfs:['/tmp:uid=65534,gid=65534,mode=1777,size=536870912','/run:uid=0,gid=0,mode=755,size=16777216'],
      command:['python3','/opt/eclipse/desktop/bootstrap.py'],environment:{DESKTOP_CONTROL_SECRET:'${TASK036_CONTROL}'},
      volumes:['workspace:/workspace'],networks:['isolated'],healthcheck:{test:['CMD','python3','/opt/eclipse/desktop/bootstrap.py','--admin','health'],interval:'2s',timeout:'15s',retries:20}}},
      volumes:{workspace:{}},networks:{isolated:{internal:true}}};
    await writeFile(configFile,JSON.stringify(config,null,2));report.stage='start';created=true;
    await compose(['up','-d','--wait','--wait-timeout','90']);
    container=await invoke(['ps','-q','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service=desktop']);assert.match(container,/^[a-f0-9]{12,64}$/);
    const [inspected]=JSON.parse(await invoke(['inspect',container]));validateDesktopTarget(inspected,project,JSON.parse(await readFile('docker/desktop/seccomp_profile.json','utf8')));
    validateWorkspace(JSON.parse(await invoke(['volume','inspect',inspected.Mounts[0].Name]))[0],project,inspected.Mounts[0].Name);
    const admin=(args,input,timeout=30000)=>invoke(['exec',...(input?['-i']:[]),'--user','0:0',container,'python3','/opt/eclipse/desktop/bootstrap.py','--admin',...args],input,timeout);
    report.stage='agent';const record=JSON.parse(await admin(['create',OWNER,AGENT]));home=record.home;
    const identity=Object.fromEntries(Object.entries(record).filter(([key])=>!['home','downloads'].includes(key)));
    report.stage='browser';
    const code=`
import assert from 'node:assert/strict';
import {writeFile,readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {startSession,dispatchOperation} from '/opt/eclipse/desktop/session-worker.mjs';
import {TeachCapture} from '/opt/eclipse/desktop/teach-capture.mjs';
import {sanitizedFrame} from '/opt/eclipse/desktop/teach-safety.mjs';
import {control} from '/opt/eclipse/desktop/mock-vendor/control.mjs';
const findings={safeDemo:false,privacy:[],audio:false,ordinaryTakeover:false};
const home=process.env.HOME;let session,recorder;
function ffmpeg(args,input){const result=spawnSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error',...args],{input,env:session.env,maxBuffer:16*1024*1024,timeout:15000});assert.equal(result.status,0,result.stderr?.toString());return result.stdout;}
try {
 const fixture=await control('start');session=await startSession(${JSON.stringify(identity)});
 const page=session.context.pages()[0];await page.goto(fixture.url);await page.locator('table').waitFor();await page.bringToFront();
 await page.setViewportSize({width:1000,height:600});
 recorder=new TeachCapture(session.context,{env:session.env});session.teach=recorder;
 await dispatchOperation(session,'input.key',{key:'Escape'},true);assert.equal(recorder.artifacts.size,0);findings.ordinaryTakeover=true;
 const id=randomUUID();let result=await recorder.command({action:'start',captureId:id,narration:true,timezone:'Asia/Kolkata'});
 assert.equal(result.state,'recording','start: '+JSON.stringify(result));
 // Sentinel remains in a normal editable field and is never made raw screenshot input.
 await page.evaluate(()=>{const input=document.createElement('input');input.id='qa-note';input.value='SECRET_SENTINEL_036';input.style='position:fixed;left:10px;top:10px;width:320px;height:60px;font-size:24px;color:rgb(255,0,255);background:rgb(0,255,0);z-index:999';document.body.append(input);});
 const masked=await sanitizedFrame(session.context,page);await writeFile(home+'/work/masked-shot.png',masked.png);
 const raw=ffmpeg(['-i','pipe:0','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],masked.png);
 for(let y=15;y<60;y++)for(let x=15;x<320;x++){const p=(y*1000+x)*3;assert.ok(raw[p]===0&&raw[p+1]===0&&raw[p+2]===0,'editable sentinel pixels not masked');}
 await delay(450);await page.evaluate(()=>document.querySelector('#qa-note').remove());
 // Use owner-input interception and real X11 input for accepted paired actions.
 const select=page.getByLabel('Invoice month');await select.focus();
 await dispatchOperation(session,'input.key',{key:'ArrowDown'},true);await dispatchOperation(session,'input.key',{key:'ArrowUp'},true);
 const button=page.getByRole('button',{name:'Apply filter'});await button.focus();
 await dispatchOperation(session,'input.key',{key:'Enter'},true);await page.locator('table').waitFor();await delay(200);if(recorder.state==='paused')assert.equal((await recorder.command({action:'resume',captureId:id})).state,'recording');
 // Browser download is an actual target action wrapped by the same capture interceptor.
 const link=page.getByRole('link',{name:'Download PDF'}).first();await link.focus();
 const download=page.waitForEvent('download');await dispatchOperation(session,'input.key',{key:'Enter'},true);const pdf=await download;assert.match(pdf.suggestedFilename(),/^DEMO-/);
 await pdf.saveAs(home+'/work/demo-invoice.pdf');
 // A synthetic non-sensitive narration segment, submitted behind a 2s safety tail.
 if(recorder.state==='paused')assert.equal((await recorder.command({action:'resume',captureId:id})).state,'recording');const audioOffset=Math.ceil(recorder.segmentFloor??0);await delay(3600);assert.equal(recorder.state,'recording',JSON.stringify(recorder.status()));const wav=ffmpeg(['-f','lavfi','-i','sine=frequency=440:sample_rate=24000:duration=0.2','-ac','1','-c:a','pcm_s16le','-f','wav','pipe:1']);
 const audio=await recorder.command({action:'audio',captureId:id,sequence:0,offsetMs:audioOffset,mime:'audio/wav',base64:wav.toString('base64')});assert.equal(audio.segment.durationMs,200);
 const audioBytes=recorder.artifacts.get(audio.segment.hash).bytes;assert.equal(audioBytes.readUInt32LE(4),audioBytes.length-8);assert.equal(audioBytes.readUInt32LE(40),audioBytes.length-44);assert.equal(audioBytes.readUInt32LE(24),24000);
 await assert.rejects(()=>recorder.command({action:'audio',captureId:id,sequence:1,offsetMs:recorder.activeMs()-100,mime:'audio/wav',base64:wav.toString('base64')}));
 await recorder.command({action:'pause',captureId:id});await assert.rejects(()=>recorder.command({action:'audio',captureId:id,sequence:1,offsetMs:0,mime:'audio/wav',base64:wav.toString('base64')}));await delay(500);
 result=await recorder.command({action:'resume',captureId:id});assert.equal(result.state,'recording');await delay(600);
 result=await recorder.command({action:'stop',captureId:id});assert.equal(result.state,'complete',JSON.stringify(result));assert.ok(result.eventCount>=3);
 const manifest=result.manifest;assert.equal(JSON.stringify(result).includes('SECRET_SENTINEL_036'),false);
 for(const event of manifest.events){assert.ok(recorder.artifacts.has(event.beforeHash)&&recorder.artifacts.has(event.afterHash));assert.equal(event.coordinateSpace,'screen');}
 const video=recorder.artifacts.get(manifest.videoHash).bytes;await writeFile(home+'/work/capture.webm',video);await writeFile(home+'/work/narration.wav',audioBytes);
 const decoded=ffmpeg(['-i','pipe:0','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],video);await writeFile(home+'/work/decoded-frame.png',decoded);
 // Decoding all frames proves codec health; count and CFR duration align with active clock.
 const frames=ffmpeg(['-i','pipe:0','-f','framemd5','pipe:1'],video).toString();const count=frames.split(String.fromCharCode(10)).filter(line=>/^0,/.test(line)).length;assert.equal(count,Math.max(1,Math.ceil(manifest.durationMs/200)));
 findings.safeDemo=true;findings.audio=true;findings.frames=count;findings.durationMs=manifest.durationMs;findings.eventCount=manifest.events.length;
 await writeFile(home+'/work/manifest.json',JSON.stringify(manifest,null,2));
 await recorder.command({action:'discard',captureId:id});assert.equal(recorder.artifacts.size,0);
 const surfaces=[['password','<input type="password" value="PASSWORD_SENTINEL">'],['otp','<input autocomplete="one-time-code" value="OTP_SENTINEL">'],['captcha','<div role="group" aria-label="CAPTCHA challenge">not a live captcha</div>'],['iframe','<iframe src="about:blank"></iframe>'],['dialog','<dialog open>private modal</dialog>'],['shadow','<div id="closed-shadow-host"></div>']];
 for(const [kind,html] of surfaces){await page.goto(fixture.url);await page.bringToFront();const captureId=randomUUID();const start=await recorder.command({action:'start',captureId});assert.equal(start.state,'recording',kind+': '+JSON.stringify(start));const prior=recorder.frames;await page.evaluate(({html,kind})=>{document.body.insertAdjacentHTML('beforeend',html);if(kind==='shadow')document.getElementById('closed-shadow-host').attachShadow({mode:'closed'}).innerHTML='<input type="password">';},{html,kind});await recorder.tick();assert.equal(recorder.state,'paused',kind+': '+JSON.stringify(recorder.status()));assert.equal(recorder.frames,prior);findings.privacy.push(kind);recorder.abort();}
 await page.goto('about:blank');const unsupported=await recorder.command({action:'start',captureId:randomUUID()});assert.equal(unsupported.state,'paused');assert.equal(recorder.frames,0);findings.privacy.push('unsupported_scheme');recorder.abort();
 await page.goto(fixture.url);await page.bringToFront();const loss=randomUUID();await recorder.command({action:'start',captureId:loss});const framesBefore=recorder.frames;recorder.abort();await delay(350);assert.equal(recorder.frames,framesBefore);assert.equal(recorder.artifacts.size,0);findings.disconnectAbort=true;
 console.log(JSON.stringify(findings));
} finally {recorder?.abort();await session?.close();await control('stop');}
`;
    const imports=code.match(/^import .+;$/gm).join('\n');
    const diagnostic=imports+'\ntry { '+code.replace(/^import .+;$/gm,'')+' } catch(error) { console.log(JSON.stringify({failure:error.message,code:error.code,stack:error.stack?.split(String.fromCharCode(10)).slice(0,4)}));process.exitCode=1; }';
    const output=await admin(['exec',OWNER,AGENT,'node','--input-type=module','-'],diagnostic,120000);
    report.browser=JSON.parse(output.split(/\r?\n/).findLast(line=>line.startsWith('{"safeDemo"')));
    for(const name of ['masked-shot.png','decoded-frame.png','capture.webm','narration.wav','manifest.json','demo-invoice.pdf'])await invoke(['cp',container+':'+home+'/work/'+name,path.join(directory,name)]);
    report.outcome='passed';report.stage='complete';
  } finally {
    if(created){const ids=(await invoke(['ps','-aq','--filter','label=com.docker.compose.project='+project])).split(/\r?\n/).filter(Boolean);for(const id of ids){const [value]=JSON.parse(await invoke(['inspect',id]));assert.equal(value.Config.Labels['com.docker.compose.project'],project);assert.equal(value.Config.Labels['com.docker.compose.service'],'desktop');}await compose(['down','--volumes','--remove-orphans']);}
    if(built){const [value]=JSON.parse(await invoke(['image','inspect',image]));assert.equal(value.Config.Labels['ai.eclipse.task036.run'],run);await invoke(['image','rm',image]);}
    for(const args of [['ps','-aq'],['volume','ls','-q'],['network','ls','-q']])assert.equal(await invoke([...args,'--filter','label=com.docker.compose.project='+project]),'');
    report.cleanup='complete';await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('TASK-036 evidence: '+directory);
  }
});
