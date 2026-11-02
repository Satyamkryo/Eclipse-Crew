import { readFile, writeFile } from "node:fs/promises";
import { requireAdmin } from "./agent-store.mjs";
import { SessionManager, listenSessions } from "./session-manager.mjs";
import { createController } from "./controller.mjs";
import { createFileServer } from "./file-server.mjs";

try {
  await requireAdmin();
  const parent = await readFile("/proc/1/status", "utf8");
  if (!/^CapEff:\s+00000000000001c3$/m.test(parent) || !/^CapBnd:\s+00000000000001c3$/m.test(parent)) throw Error();
  const secret = process.env.DESKTOP_CONTROL_SECRET;
  if (!secret || !/^[0-9a-f]{64}$/.test(secret)) { console.error('{"outcome":"invalid_secret"}'); process.exit(1); }
  const manager = new SessionManager(); const server = await listenSessions(manager);
  const controller = createController(manager, secret);
  await new Promise((resolve, reject) => controller.listen(4310, "0.0.0.0", resolve).once("error", reject));
  const uploads = createFileServer(secret);
  await new Promise((resolve, reject) => uploads.listen(4311, "0.0.0.0", resolve).once("error", reject));
  await writeFile("/run/eclipse/ready.json", JSON.stringify({ version: 1, administrativeCapabilities: "00000000000001c3", sysAdminDropped: true }), { flag: "wx", mode: 0o600 });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true; server.close(); controller.closeControllerStreams(); controller.close(); uploads.close();
    try { await manager.closeAll(); } catch { process.exitCode = 1; }
  };
  process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
} catch { console.error('{"outcome":"supervisor_refused"}'); process.exitCode = 1; }
