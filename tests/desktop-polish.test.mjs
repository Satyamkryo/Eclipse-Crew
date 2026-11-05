import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { desktopConfig, desktopPaths, legacyTint2rc, seedDesktop } from "../docker/desktop/desktop-config.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOME = `/workspace/homes/${ID}`;
const DOWNLOADS = `/downloads/${ID}`;

test("desktop config seeds the dock, files, terminal, folders and hidden unsafe places", () => {
  const config = desktopConfig(HOME, DOWNLOADS);
  const files = new Map(config.files.map((file) => [file.path, file.content]));
  const tint2 = files.get(`${HOME}/.config/tint2/tint2rc`);
  for (const launcher of ["eclipse-browser.desktop", "eclipse-files.desktop", "eclipse-terminal.desktop"])
    assert.match(tint2, new RegExp(`launcher_item_app = ${HOME.replaceAll("/", "\\/")}/\\.local/share/applications/${launcher}`));
  assert.match(tint2, /panel_items = LTC/);
  assert.match(tint2, /launcher_icon_theme = hicolor/);
  assert.match(tint2, /launcher_icon_theme_override = 1/);
  assert.doesNotMatch(tint2, /^taskbar_font/m);
  assert.match(tint2, /time1_format = %H:%M/);
  // Takeover sends clicks but never hover, so the dock must stay visible.
  assert.match(tint2, /^autohide = 0$/m);
  assert.equal(legacyTint2rc(HOME, DOWNLOADS), tint2.replace("autohide = 0", "autohide = 1"));
  // The desktop Browser icon is gone; only the exact file earlier images seeded is cleaned up.
  assert.equal(files.has(`${HOME}/Desktop/Browser.desktop`), false);
  assert.equal(config.legacyDesktopBrowser.path, `${HOME}/Desktop/Browser.desktop`);
  assert.match(config.legacyDesktopBrowser.content, /Exec=\/opt\/eclipse\/desktop\/desktop-config\/browser-focus\.sh/);
  assert.doesNotMatch(config.legacyDesktopBrowser.content, /NoDisplay/);
  const desktop = files.get(`${HOME}/.config/pcmanfm/default/desktop-items-0.conf`);
  for (const setting of ["wallpaper_mode=0", "show_trash=1", "show_home=1", "show_computer=0", "show_mounts=0", "show_documents=0"])
    assert.match(desktop, new RegExp(setting));
  const volume = files.get(`${HOME}/.config/pcmanfm/default/pcmanfm.conf`);
  for (const setting of ["mount_on_startup=0", "mount_removable=0", "autorun=0"]) assert.match(volume, new RegExp(setting));
  assert.deepEqual(config.links.map((link) => [link.path.slice(HOME.length), link.target]), [
    ["/Desktop/Downloads", DOWNLOADS], ["/Desktop/outbox", `${HOME}/outbox`], ["/Desktop/work", `${HOME}/work`]]);
  for (const directory of config.directories) assert.ok(directory.startsWith(`${HOME}/`));
  assert.ok(!JSON.stringify(config).includes("--no-sandbox"));
  assert.ok(!JSON.stringify(config).includes("getwindowname"));
});

test("desktop paths reject traversal, a peer downloads directory and an unsafe uid", async () => {
  assert.equal(desktopPaths(HOME, DOWNLOADS).desktop, `${HOME}/Desktop`);
  for (const [home, downloads] of [[`${HOME}/../root`, DOWNLOADS], ["/workspace/homes/../root", DOWNLOADS],
    [HOME, `/downloads/${"b".repeat(8)}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`], [`/home/${ID}`, DOWNLOADS]]) {
    assert.throws(() => desktopPaths(home, downloads), (error) => error.message === "invalid_desktop_home" || error.message === "invalid_desktop_downloads");
  }
  for (const uid of [0, 19999, 60000, 1.5]) await assert.rejects(seedDesktop({ home: HOME, downloads: DOWNLOADS, uid }), /invalid_desktop_uid/);
  assert.throws(() => desktopPaths(HOME, DOWNLOADS, "launchers"), /invalid_desktop_launcher/);
});

test("fixed launchers verify kernel identity and never use a window title", async () => {
  const browser = await readFile("docker/desktop/desktop-config/browser-focus.sh", "utf8");
  assert.match(browser, /\/proc\/\$pid\/status/);
  assert.match(browser, /--user-data-dir=\$profile/);
  assert.match(browser, /xdotool search --pid "\$pid"/);
  assert.doesNotMatch(browser, /getwindowname|--name/);
  // A minimized browser is not "visible"; the managed top-level window is picked by WM_STATE.
  assert.doesNotMatch(browser, /--onlyvisible/);
  assert.match(browser, /xprop -id "\$candidate" WM_STATE/);
  // A stopped browser shows fixed guidance; the launcher never starts the browser itself.
  assert.match(browser, /xmessage -center -timeout 8/);
  assert.doesNotMatch(browser, /chrome-linux64|playwright|launch/i);
  const terminal = await readFile("docker/desktop/desktop-config/open-terminal.sh", "utf8");
  assert.match(terminal, /cd "\$\{HOME:\?\}\/work"/);
  assert.match(terminal, /exec xterm/);
  const files = await readFile("docker/desktop/desktop-config/open-files.sh", "utf8");
  assert.match(files, /exec pcmanfm "\$HOME"/);
});

test("worker helper commands are killed with SIGKILL on timeout (pcmanfm traps SIGTERM)", async () => {
  const worker = await readFile("docker/desktop/session-worker.mjs", "utf8");
  assert.match(worker, /const command = \(executable, args, extra = \{\}\) => spawnSync\(executable, args, \{[^}]*timeout: 1000, killSignal: "SIGKILL"/);
});

test("image installs the locked native tools and copies the fixed launchers", async () => {
  const dockerfile = await readFile("docker/desktop/Dockerfile", "utf8");
  assert.match(dockerfile, /COPY desktop-config \.\/desktop-config/);
  assert.match(dockerfile, /chmod 755 desktop-config\/browser-focus\.sh/);
  const lock = JSON.parse(await readFile("docker/desktop/ubuntu-packages.lock.json", "utf8"));
  const pins = new Map(lock.packages.map((entry) => [entry.name, entry.version]));
  assert.equal(pins.get("tint2"), "17.0.1-1.1build2");
  assert.equal(pins.get("pcmanfm"), "1.3.2-4build2");
  assert.equal(pins.get("xterm"), "390-1ubuntu3");
  assert.equal(pins.get("dbus-daemon"), "1.14.10-4ubuntu4.1");
  const worker = await readFile("docker/desktop/session-worker.mjs", "utf8");
  assert.match(worker, /seedDesktop/);
  assert.match(worker, /"--desktop", "--profile=default"/);
  assert.match(worker, /(startChild\("graphics", "tint2"|start\("tint2")/);
  assert.match(worker, /DBUS_SYSTEM_BUS_ADDRESS: "disabled:"/);
  assert.match(worker, /sweepSessionProcesses/);
});
