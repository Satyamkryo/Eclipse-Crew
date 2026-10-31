import { spawn } from "node:child_process";
import { randomBytes, createCipheriv } from "node:crypto";
import { lstat, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";

export function wsVncPorts(uid) {
  if (!Number.isInteger(uid) || uid < 20000 || uid > 59999) throw Error("vnc_uid_invalid");
  return { vncPort: 5950 + uid - 20000 };
}
/** Traditional VNC reverses the bits of each of the eight password bytes. */
export function vncChallengeResponse(password, challenge) {
  if (typeof password !== "string" || !/^[A-Za-z0-9+/]{8}$/.test(password) || !Buffer.isBuffer(challenge) || challenge.length !== 16)
    throw Error("invalid_vnc_auth");
  const key = Buffer.from(password, "ascii").map((byte) => {
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) { reversed = (reversed << 1) | (byte & 1); byte >>= 1; }
    return reversed;
  });
  // DES-EDE with three identical keys is DES, supported by current OpenSSL builds.
  const cipher = createCipheriv("des-ede3", Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}
function authenticatePort(port, password, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = Buffer.alloc(0), state = "version", settled = false;
    const finish = (error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(Error("vnc_authentication_failed")); else resolve();
    };
    const abort = () => finish(true);
    const timer = setTimeout(() => finish(true), 1500);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { finish(true); return; }
    socket.once("error", () => finish(true)); socket.once("end", () => finish(true)); socket.once("close", () => finish(true));
    socket.on("data", (chunk) => {
      try {
        data = Buffer.concat([data, chunk]); if (data.length > 4096) return finish(true);
        while (!settled) {
          if (state === "version") {
            if (data.length < 12) return;
            if (data.subarray(0, 12).toString("ascii") !== "RFB 003.008\n") return finish(true);
            data = data.subarray(12); state = "security"; socket.write("RFB 003.008\n");
          } else if (state === "security") {
            if (!data.length || data.length < data[0] + 1) return;
            const count = data[0]; if (count === 0 || !data.subarray(1, count + 1).includes(2)) return finish(true);
            data = data.subarray(count + 1); state = "challenge"; socket.write(Buffer.from([2]));
          } else if (state === "challenge") {
            if (data.length < 16) return;
            const response = vncChallengeResponse(password, data.subarray(0, 16)); data = data.subarray(16);
            state = "result"; socket.write(response);
          } else {
            if (data.length < 4) return;
            finish(data.readUInt32BE() !== 0);
          }
        }
      } catch { finish(true); }
    });
  });
}
export async function startVnc({ directory, display, onFailure = () => {}, signal }) {
  const uid = process.getuid();
  if (typeof directory !== "string" || !new RegExp(`^/tmp/ec-${uid}-[a-zA-Z0-9]{6}$`).test(directory) ||
    display !== uid - 20000 + 100) throw Error("vnc_session_invalid");
  const st = await lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o777) !== 0o700) throw Error("vnc_session_invalid");
  const { vncPort } = wsVncPorts(uid);
  const password = randomBytes(6).toString("base64");
  const passwordFile = `${directory}/vnc-auth`;
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: directory, DISPLAY: `:${display}`,
    XAUTHORITY: `${directory}/Xauthority`, XDG_RUNTIME_DIR: `${directory}/runtime`, LANG: "C.UTF-8" };
  let vncProc, closed = false, ready = false;
  const close = async () => {
    if (closed) return; closed = true;
    if (vncProc) {
      try { vncProc.kill("SIGTERM"); } catch { /* already stopped */ }
      for (let i = 0; i < 10 && vncProc.exitCode === null && vncProc.signalCode === null; i++) await delay(50);
      if (vncProc.exitCode === null && vncProc.signalCode === null) { try { vncProc.kill("SIGKILL"); } catch { /* already stopped */ } }
      for (let i = 0; i < 10 && vncProc.exitCode === null && vncProc.signalCode === null; i++) await delay(50);
    }
    await rm(passwordFile, { force: true });
  };
  try {
    if (signal?.aborted) throw Error("vnc_start_cancelled");
    // x11vnc's documented passwdfile transport avoids exposing the password in
    // process arguments. rm: removes the private tmpfs file immediately on read.
    await writeFile(passwordFile, `${password}\n`, { flag: "wx", mode: 0o600 });
    vncProc = spawn("x11vnc", ["-display", `:${display}`, "-auth", `${directory}/Xauthority`, "-passwdfile", `rm:${passwordFile}`,
      "-localhost", "-rfbport", String(vncPort), "-viewonly", "-nosel", "-shared", "-forever", "-noxdamage", "-quiet"], { env, stdio: "ignore", shell: false });
    let failed = false;
    vncProc.once("error", () => { failed = true; if (ready && !closed) onFailure(); });
    vncProc.once("exit", () => { failed = true; if (ready && !closed) onFailure(); });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw Error("vnc_start_cancelled");
      if (failed || vncProc.exitCode !== null || vncProc.signalCode !== null) throw Error("vnc_start_failed");
      try { await authenticatePort(vncPort, password, signal); ready = true; break; } catch { await delay(100, undefined, { signal }); }
    }
    if (!ready || failed || signal?.aborted) throw Error("vnc_authentication_failed");
    return { vncPort, password, vncProc, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}
