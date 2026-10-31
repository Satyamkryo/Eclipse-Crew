import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const CHROMIUM = "/opt/chromium/chrome-linux/chrome";
function version(command, args, pattern, accepted = [0]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024 });
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(pattern);
  if (!accepted.includes(result.status) || !match) {
    const error = Error("tool_execution_failed"); error.tool = command === CHROMIUM ? "chromium" : command; throw error;
  }
  return match[1];
}
export async function checkTools({ supervisor = false } = {}) {
  if (process.arch !== "x64") throw Error("runtime_identity_invalid");
  if (process.getuid?.() === 0) {
    if (!supervisor) throw Error("runtime_identity_invalid");
    const { requireAdmin } = await import("./agent-store.mjs"); await requireAdmin();
    const ready = JSON.parse(await readFile("/run/eclipse/ready.json", "utf8"));
    if (ready.sysAdminDropped !== true) throw Error("runtime_identity_invalid");
  }
  const { chromium } = await import("playwright-core");
  if (typeof chromium.launch !== "function") throw Error("library_unavailable");
  const library = JSON.parse(await readFile(new URL("./node_modules/playwright-core/package.json", import.meta.url), "utf8"));
  if (library.version !== "1.64.1" || process.version !== "v24.22.2") throw Error("runtime_version_invalid");
  const inventory = {
    node: process.version, playwright: library.version,
    chromium: version(CHROMIUM, ["--version"], /^Chromium ([\d.]+)/m),
    openbox: version("openbox", ["--version"], /Openbox ([\d.]+)/),
    xdotool: version("xdotool", ["--version"], /xdotool version ([\d.]+)/),
    ffmpeg: version("ffmpeg", ["-version"], /ffmpeg version ([\w.+:~\-]+)/),
    x11vnc: version("x11vnc", ["-version"], /x11vnc: ([\d.]+)/),
    websockify: version("dpkg-query", ["-W", "-f=${Version}", "websockify"], /^([\w.+:~\-]+)$/m),
    xvfb: version("dpkg-query", ["-W", "-f=${Version}", "xvfb"], /^([\w.+:~\-]+)$/m),
    novnc: version("dpkg-query", ["-W", "-f=${Version}", "novnc"], /^([\w.+:~\-]+)$/m),
  };
  // Xvfb has no conventional --version; execute its help as well as querying dpkg.
  version("Xvfb", ["-help"], /(use:)/, [0]);
  version("websockify", ["--help"], /(Usage:)/);
  await access("/usr/share/novnc/vnc.html"); await access("/usr/share/novnc/core/rfb.js");
  await access("/opt/chromium/chrome-linux/chrome_100_percent.pak");
  await access("/opt/eclipse/desktop/ubuntu-packages.tsv");
  return inventory;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ outcome: "tools_available", versions: await checkTools() })); }
  catch (error) {
    console.error(JSON.stringify({ outcome: "tools_unavailable",
      ...(["chromium", "openbox", "xdotool", "ffmpeg", "x11vnc", "websockify", "Xvfb", "dpkg-query"].includes(error.tool) ? { tool: error.tool } : {}) }));
    process.exitCode = 1;
  }
}
