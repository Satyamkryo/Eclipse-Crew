import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BROWSER_EXECUTABLE, BROWSER_VERSION } from "./browser-build.mjs";

export const CHROMIUM = BROWSER_EXECUTABLE;
// The image records the CPU it was built for; the runtime must be the same CPU. This is
// an internal consistency check, not evidence that a CPU is not emulated.
export const NODE_ARCH = { amd64: "x64", arm64: "arm64" };
export function expectedNodeArch(imageArch) {
  if (!Object.hasOwn(NODE_ARCH, imageArch)) throw Error("runtime_identity_invalid");
  return NODE_ARCH[imageArch];
}
async function verifyImageArch() {
  let imageArch;
  try { imageArch = (await readFile("/opt/eclipse/desktop/image-arch", "utf8")).trim(); } catch { throw Error("runtime_identity_invalid"); }
  if (expectedNodeArch(imageArch) !== process.arch) throw Error("runtime_identity_invalid");
  return imageArch;
}
function version(command, args, pattern, accepted = [0]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024 });
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(pattern);
  if (!accepted.includes(result.status) || !match) {
    const error = Error("tool_execution_failed"); error.tool = command === CHROMIUM ? "chromium" : command; throw error;
  }
  return match[1];
}
export async function checkTools({ supervisor = false } = {}) {
  await verifyImageArch();
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
  const chromiumVersion = version(CHROMIUM, ["--version"], /(?:Google Chrome for Testing|Google Chrome|Chromium) ([\d.]+)/m);
  if (chromiumVersion !== BROWSER_VERSION) throw Error("runtime_version_invalid");
  const inventory = {
    node: process.version, playwright: library.version,
    chromium: chromiumVersion,
    openbox: version("openbox", ["--version"], /Openbox ([\d.]+)/),
    xdotool: version("xdotool", ["--version"], /xdotool version ([\d.]+)/),
    ffmpeg: version("ffmpeg", ["-version"], /ffmpeg version ([\w.+:~\-]+)/),
    x11vnc: version("x11vnc", ["-version"], /x11vnc: ([\d.]+)/),
    websockify: version("dpkg-query", ["-W", "-f=${Version}", "websockify"], /^([\w.+:~\-]+)$/m),
    xvfb: version("dpkg-query", ["-W", "-f=${Version}", "xvfb"], /^([\w.+:~\-]+)$/m),
    novnc: version("dpkg-query", ["-W", "-f=${Version}", "novnc"], /^([\w.+:~\-]+)$/m),
    // TASK-071: the namespace helper needs python3 and util-linux.
    git: version("git", ["--version"], /^git version ([\w.+:~\-]+)$/m),
    python: version("python3", ["--version"], /Python ([\d.]+)/),
    unshare: version("unshare", ["--version"], /unshare from util-linux ([\d.]+)/),
    setpriv: version("setpriv", ["--version"], /setpriv from util-linux ([\d.]+)/),
    dbus: version("dbus-daemon", ["--version"], /D-Bus Message Bus Daemon ([\d.]+)/),
    tint2: version("dpkg-query", ["-W", "-f=${Version}", "tint2"], /^([\w.+:~\-]+)$/m),
    pcmanfm: version("dpkg-query", ["-W", "-f=${Version}", "pcmanfm"], /^([\w.+:~\-]+)$/m),
    xterm: version("dpkg-query", ["-W", "-f=${Version}", "xterm"], /^([\w.+:~\-]+)$/m),
    pulseaudio: version("dpkg-query", ["-W", "-f=${Version}", "pulseaudio"], /^([\w.+:~\-]+)$/m),
    pulseaudioUtils: version("dpkg-query", ["-W", "-f=${Version}", "pulseaudio-utils"], /^([\w.+:~\-]+)$/m),
    // TASK-087: tools a dev agent needs on a real project.
    ripgrep: version("rg", ["--version"], /^ripgrep ([\d.]+)/m),
    jq: version("jq", ["--version"], /^jq-([\w.-]+)/m),
    patch: version("patch", ["--version"], /^GNU patch ([\d.]+)/m),
    procps: version("dpkg-query", ["-W", "-f=${Version}", "procps"], /^([\w.+:~\-]+)$/m),
    zip: version("dpkg-query", ["-W", "-f=${Version}", "zip"], /^([\w.+:~\-]+)$/m),
    file: version("file", ["--version"], /^file-([\d.]+)/m),
    pythonVenv: version("python3", ["-m", "venv", "-h"], /usage: venv/i, [0]),
    pythonPip: version("python3", ["-m", "pip", "--version"], /pip ([\d.]+)/),
  };
  // Xvfb has no conventional --version; execute its help as well as querying dpkg.
  version("Xvfb", ["-help"], /(use:)/, [0]);
  version("websockify", ["--help"], /(Usage:)/);
  await access("/usr/share/novnc/vnc.html"); await access("/usr/share/novnc/core/rfb.js");
  await access("/opt/chrome-for-testing/chrome-linux64/chrome_100_percent.pak");
  await access("/opt/eclipse/desktop/ubuntu-packages.tsv");
  await access("/opt/eclipse/desktop/netns-enter.py");
  for (const file of ["browser-focus.sh", "open-files.sh", "open-terminal.sh"]) await access(`/opt/eclipse/desktop/desktop-config/${file}`);
  for (const tool of ["/usr/bin/dbus-daemon", "/usr/bin/tint2", "/usr/bin/pcmanfm", "/usr/bin/xterm", "/usr/bin/pulseaudio", "/usr/bin/pactl"]) await access(tool);
  // TASK-079: the installed ffmpeg must actually provide the pulse input.
  version("ffmpeg", ["-hide_banner", "-h", "demuxer=pulse"], /pulse/, [0]);
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
