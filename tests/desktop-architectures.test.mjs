import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { validateEntry, validateManifest, TARGETS } from "../docker/desktop/fetch-packages.mjs";
import { loadBrowserLock, validateBrowserEntry, validateBrowserLock, downloadBrowser } from "../docker/desktop/browser-build.mjs";
import { expectedNodeArch } from "../docker/desktop/check-tools.mjs";
import { buildManifest, lockSummary, manifestBytes, parsePackageList, parsePrintUris, applyAptCacheHashes, requireNativeArchitecture } from "../scripts/resolve-package-lock.mjs";
import { classify, matrix, MATRIX } from "../scripts/acceptance/arm64.mjs";

const FIXTURES = "tests/fixtures/kernel-v6.8";
const FIXTURE_SHA256 = {
  "unistd.h": "2807c5c2e1ad8128b37438f81cf9776b52fb664b48d93e2ea8edb06846eda90d",
  "syscall_64.tbl": "4c30abea9a4b69f3409bea7a0c910a8c8feb9a44b22a448b5c82f2bfdd8249c8",
  "audit.h": "db86160b09c1ef7c1ac2dd59a9d6b5d19a8494739dd8d78fc0464e8bc8ad8f55",
  "elf-em.h": "e72cca577a97d1fccc7f4e5d37b39b401a527a97f02e589255c247b63cb227d2",
};
const KILL = 0x80000000;
const ALLOW = 0x7FFF0000;
const EPERM = 0x00050000 | 1;
const ENOSYS = 0x00050000 | 38;
const AUDIT_ARCH_X86_64 = 0xC000003E;
const AUDIT_ARCH_AARCH64 = 0xC00000B7;

const DENIED = [
  ["lookup_dcookie", 18, 212],
  ["umount2", 39, 166],
  ["mount", 40, 165],
  ["quotactl", 60, 179],
  ["syslog", 116, 103],
  ["sethostname", 161, 170],
  ["setdomainname", 162, 171],
  ["perf_event_open", 241, 298],
  ["fanotify_init", 262, 300],
  ["name_to_handle_at", 264, 303],
  ["bpf", 280, 321],
  ["open_tree", 428, 428],
  ["move_mount", 429, 429],
  ["fsopen", 430, 430],
  ["fsconfig", 431, 431],
  ["fsmount", 432, 432],
  ["fspick", 433, 433],
  ["mount_setattr", 442, 442],
];

function parseSyscallTable(text) {
  const map = new Map();
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const columns = line.trim().split(/\s+/);
    if (columns.length < 3 || !/^\d+$/.test(columns[0]) || !["common", "64"].includes(columns[1])) continue;
    if (!map.has(columns[2])) map.set(columns[2], +columns[0]);
  }
  return map;
}

function parseArmSyscalls(text) {
  const map = new Map();
  for (const match of text.matchAll(/^#define __NR_([a-z0-9_]+)\s+(\d+)\s*$/gm)) map.set(match[1], +match[2]);
  return map;
}

function pythonDictionary(source, name) {
  const start = source.indexOf(`${name} = {`);
  assert.notEqual(start, -1, `${name} missing`);
  return source.slice(start, source.indexOf("\n}", start));
}

function instructionsFor(source, machine) {
  const body = pythonDictionary(source, "DENIED_SYSCALLS");
  const numbers = new RegExp(`"${machine}":\\s*\\[([^\\]]+)\\]`).exec(body);
  assert.ok(numbers, `${machine} denylist missing`);
  const denied = numbers[1].split(",").map((value) => Number(value.trim()));
  const arch = machine === "x86_64" ? AUDIT_ARCH_X86_64 : AUDIT_ARCH_AARCH64;
  const instructions = [[0x20, 0, 0, 4], [0x15, 1, 0, arch], [0x06, 0, 0, KILL], [0x20, 0, 0, 0]];
  if (machine === "x86_64") instructions.push([0x35, 0, 1, 0x40000000], [0x06, 0, 0, ENOSYS]);
  for (const number of denied) instructions.push([0x15, 0, 1, number], [0x06, 0, 0, EPERM]);
  instructions.push([0x06, 0, 0, ALLOW]);
  return instructions;
}

function evaluate(instructions, { arch, nr }) {
  let pc = 0; let accumulator = 0;
  for (let steps = 0; steps < 256; steps++) {
    const [code, jt, jf, value] = instructions[pc];
    if (code === 0x20) { accumulator = value === 4 ? arch : nr; pc++; }
    else if (code === 0x15) pc += (accumulator === value ? jt : jf) + 1;
    else if (code === 0x35) pc += (accumulator >= value ? jt : jf) + 1;
    else if (code === 0x06) return value;
    else throw Error("unexpected_bpf_instruction");
  }
  throw Error("bpf_instruction_limit");
}

test("kernel v6.8 fixtures match their pinned hashes and deny the same 18 calls per ABI", async () => {
  const texts = {};
  for (const [file, digest] of Object.entries(FIXTURE_SHA256)) {
    const bytes = await readFile(path.join(FIXTURES, file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, file);
    texts[file] = bytes.toString("utf8");
  }
  assert.match(texts["audit.h"], /#define AUDIT_ARCH_AARCH64\s+\(EM_AARCH64\|__AUDIT_ARCH_64BIT\|__AUDIT_ARCH_LE\)/);
  assert.match(texts["audit.h"], /#define AUDIT_ARCH_X86_64\s+\(EM_X86_64\|__AUDIT_ARCH_64BIT\|__AUDIT_ARCH_LE\)/);
  const em = (name) => +new RegExp(`#define ${name}\\s+(\\d+)`).exec(texts["elf-em.h"])[1];
  const bit64 = Number(/__AUDIT_ARCH_64BIT\s+(0x[0-9a-f]+)/i.exec(texts["audit.h"])[1]);
  const little = Number(/__AUDIT_ARCH_LE\s+(0x[0-9a-f]+)/i.exec(texts["audit.h"])[1]);
  assert.equal((em("EM_AARCH64") | bit64 | little) >>> 0, AUDIT_ARCH_AARCH64);
  assert.equal((em("EM_X86_64") | bit64 | little) >>> 0, AUDIT_ARCH_X86_64);

  const arm = parseArmSyscalls(texts["unistd.h"]);
  const x86 = parseSyscallTable(texts["syscall_64.tbl"]);
  assert.equal(DENIED.length, 18);
  for (const [name, armNumber, x86Number] of DENIED) {
    assert.equal(arm.get(name), armNumber, `${name} aarch64`);
    assert.equal(x86.get(name), x86Number, `${name} x86_64`);
  }

  const bootstrap = await readFile("docker/desktop/bootstrap.py", "utf8");
  assert.equal(Number(/"x86_64":\s+(0x[0-9A-Fa-f]+)/.exec(pythonDictionary(bootstrap, "AUDIT_ARCH"))[1]), AUDIT_ARCH_X86_64);
  assert.equal(Number(/"aarch64":\s+(0x[0-9A-Fa-f]+)/.exec(pythonDictionary(bootstrap, "AUDIT_ARCH"))[1]), AUDIT_ARCH_AARCH64);
  const deniedBody = pythonDictionary(bootstrap, "DENIED_SYSCALLS");
  assert.deepEqual(/"aarch64":\s*\[([^\]]+)\]/.exec(deniedBody)[1].split(",").map((value) => +value.trim()).sort((a, b) => a - b), DENIED.map((row) => row[1]).sort((a, b) => a - b));
  assert.deepEqual(/"x86_64":\s*\[([^\]]+)\]/.exec(deniedBody)[1].split(",").map((value) => +value.trim()).sort((a, b) => a - b), DENIED.map((row) => row[2]).sort((a, b) => a - b));
  const images = pythonDictionary(bootstrap, "IMAGE_ARCH");
  assert.match(images, /"x86_64":\s*"amd64"/);
  assert.match(images, /"aarch64":\s*"arm64"/);
});

test("emitted seccomp programs kill foreign ABIs, deny every mapped call and keep required calls", async () => {
  const source = await readFile("docker/desktop/bootstrap.py", "utf8");
  const x86 = instructionsFor(source, "x86_64");
  const arm = instructionsFor(source, "aarch64");
  assert.equal(evaluate(x86, { arch: AUDIT_ARCH_X86_64, nr: 0 }), ALLOW);
  assert.equal(evaluate(x86, { arch: AUDIT_ARCH_X86_64, nr: 0x40000027 }), ENOSYS);
  assert.equal(evaluate(x86, { arch: AUDIT_ARCH_AARCH64, nr: 0 }), KILL);
  assert.equal(evaluate(arm, { arch: AUDIT_ARCH_AARCH64, nr: 63 }), ALLOW);
  assert.equal(evaluate(arm, { arch: AUDIT_ARCH_X86_64, nr: 63 }), KILL);
  // aarch64 has no x32 ABI; a value in that range is not an x32 call and is not ENOSYS.
  assert.equal(evaluate(arm, { arch: AUDIT_ARCH_AARCH64, nr: 0x40000027 }), ALLOW);
  assert.equal(x86.some((row) => row[0] === 0x35), true);
  assert.equal(arm.some((row) => row[0] === 0x35), false);
  for (const [name, armNumber, x86Number] of DENIED) {
    assert.equal(evaluate(arm, { arch: AUDIT_ARCH_AARCH64, nr: armNumber }), EPERM, name);
    assert.equal(evaluate(x86, { arch: AUDIT_ARCH_X86_64, nr: x86Number }), EPERM, name);
  }
  // clone/setns/unshare stay allowed after the filter so Chromium can create its namespace.
  for (const number of [220, 268, 97]) assert.notEqual(evaluate(arm, { arch: AUDIT_ARCH_AARCH64, nr: number }), EPERM);
});

const ARM_URIS = [
  "'http://ports.ubuntu.com/ubuntu-ports/pool/main/p/python3.12/libpython3.12-minimal_3.12.3-1ubuntu0.17_arm64.deb' libpython3.12-minimal_3.12.3-1ubuntu0.17_arm64.deb 838536 MD5Sum:3c10fde9438466b6aa7d660e6a179cc7",
  "'http://ports.ubuntu.com/ubuntu-ports/pool/universe/n/novnc/python3-novnc_1.3.0-2_all.deb' python3-novnc_1%3a1.3.0-2_all.deb 12826 MD5Sum:71729c44a945d374647420c60d8e524cb85c12598524534fdb9036fafe952901",
  "'http://ports.ubuntu.com/ubuntu-ports/pool/main/d/duktape/libduktape207_2.7.0+tests-0ubuntu3_arm64.deb' libduktape207_2.7.0+tests-0ubuntu3_arm64.deb 12345 MD5Sum:00000000000000000000000000000000",
].join("\n");

test("resolver parses apt output for the selected CPU and refuses wrong hosts, ABIs and entries", () => {
  const spec = { architecture: "arm64", ...TARGETS.arm64 };
  const entries = parsePrintUris(ARM_URIS, spec);
  assert.deepEqual(entries.map((entry) => entry.name), ["libduktape207", "libpython3.12-minimal", "python3-novnc"]);
  const novnc = entries.find((entry) => entry.name === "python3-novnc");
  assert.equal(novnc.version, "1:1.3.0-2");
  assert.equal(novnc.filename, "python3-novnc_1:1.3.0-2_all.deb");
  assert.equal(novnc.url, "https://ports.ubuntu.com/ubuntu-ports/pool/universe/n/novnc/python3-novnc_1.3.0-2_all.deb");
  assert.equal(entries.find((entry) => entry.name === "libduktape207").url.includes("%"), false);

  assert.throws(() => parsePrintUris(ARM_URIS.replaceAll("ports.ubuntu.com/ubuntu-ports", "archive.ubuntu.com/ubuntu"), spec), /invalid_package_source/);
  assert.throws(() => parsePrintUris(ARM_URIS.replaceAll("libduktape207_2.7.0+tests-0ubuntu3_arm64.deb", "libduktape207_2.7.0+tests-0ubuntu3_amd64.deb"), spec), /wrong_package_architecture/);
  assert.throws(() => parsePrintUris(ARM_URIS.replace("/python3.12/", "/%2f/"), spec), /invalid_package_source/);
  assert.throws(() => parsePrintUris(`${ARM_URIS}\n${ARM_URIS.split("\n")[0]}`, spec), /duplicate_package/);
  assert.throws(() => parsePrintUris(ARM_URIS.replace("12826 MD5Sum", "0 MD5Sum"), spec), /invalid_package_entry/);
  assert.throws(() => parsePrintUris("", spec), /no_packages_resolved/);

  assert.throws(() => parsePrintUris(ARM_URIS, { architecture: "riscv64", ...TARGETS.arm64 }), /unsupported_target_architecture/);

  assert.deepEqual(parsePackageList("# comment\nxvfb\n  git  # tools\n\n"), ["xvfb", "git"]);
  assert.throws(() => parsePackageList("git\ngit"), /duplicate_package_root/);
  assert.throws(() => parsePackageList("Bad Name"), /invalid_package_root/);
  assert.throws(() => parsePackageList("# only\n"), /empty_package_roots/);
});

test("apt-cache SHA-256 values are joined only when name, version, ABI, filename and size agree", () => {
  const entries = parsePrintUris(ARM_URIS, { architecture: "arm64", ...TARGETS.arm64 });
  const show = [
    "Package: python3-novnc", "Version: 1:1.3.0-2", "Architecture: all",
    "Filename: pool/universe/n/novnc/python3-novnc_1.3.0-2_all.deb", "Size: 12826",
    "SHA256: 71729c44a945d374647420c60d8e524cb85c12598524534fdb9036fafe952901", "",
    "Package: libduktape207", "Version: 2.7.0+tests-0ubuntu3", "Architecture: arm64",
    "Filename: pool/main/d/duktape/libduktape207_2.7.0+tests-0ubuntu3_arm64.deb", "Size: 12345",
    "SHA256: 1111111111111111111111111111111111111111111111111111111111111111", "",
    "Package: libpython3.12-minimal", "Version: 3.12.3-1ubuntu0.17", "Architecture: arm64",
    "Filename: pool/main/p/python3.12/libpython3.12-minimal_3.12.3-1ubuntu0.17_arm64.deb", "Size: 838536",
    "SHA256: 2222222222222222222222222222222222222222222222222222222222222222", "",
  ].join("\n");
  const hashed = applyAptCacheHashes(show, entries);
  assert.equal(hashed.find((entry) => entry.name === "python3-novnc").sha256, "71729c44a945d374647420c60d8e524cb85c12598524534fdb9036fafe952901");
  assert.throws(() => applyAptCacheHashes(show.replace("Size: 12826", "Size: 1"), entries), /metadata_size_mismatch_python3-novnc/);
  assert.throws(() => applyAptCacheHashes(show.replace("SHA256: 7172", "SHA256: ffff").split("Package: python3-novnc")[0], entries), /metadata_hash_missing/);

  const manifest = buildManifest("arm64", hashed, "fixture");
  const bytes = manifestBytes(manifest);
  assert.deepEqual(lockSummary(manifest, bytes), { architecture: "arm64", count: 3, bytes: 863707,
    sha256: createHash("sha256").update(bytes).digest("hex") });

  const answer = (value) => () => ({ status: 0, stdout: value });
  requireNativeArchitecture("amd64", answer("x86_64\n"));
  requireNativeArchitecture("arm64", answer("aarch64\n"));
  assert.throws(() => requireNativeArchitecture("arm64", answer("x86_64\n")), /native_architecture_required/);
  assert.throws(() => requireNativeArchitecture("amd64", answer("arm64\n")), /native_architecture_required/);
  assert.throws(() => requireNativeArchitecture("amd64", () => ({ status: 1, stdout: "" })), /docker_unavailable/);
});

const ARM_ENTRY = {
  name: "libbsd0", version: "0.12.1-1build1.1", architecture: "arm64",
  filename: "libbsd0_0.12.1-1build1.1_arm64.deb",
  url: "https://ports.ubuntu.com/ubuntu-ports/pool/main/libb/libbsd/libbsd0_0.12.1-1build1.1_arm64.deb",
  bytes: 41238, sha256: "f3857b0863ac5cfd4263e9bf6cfb1d4be88d5321e4070d5bc2b62b0949e6c86f",
};

test("package locks stay per CPU and every wrong target, host or ABI fails closed", async () => {
  const amd64 = await readFile("docker/desktop/ubuntu-packages.lock.json");
  const manifest = validateManifest(amd64);
  assert.equal(manifest.packages.length, 445);
  assert.throws(() => validateManifest(amd64, "riscv64"), /unsupported_target_architecture/);
  const arm64 = await readFile("docker/desktop/ubuntu-packages.arm64.lock.json");
  const armManifest = validateManifest(arm64, "arm64");
  assert.equal(armManifest.packages.length, 442);
  assert.equal(armManifest.packages.reduce((total, entry) => total + entry.bytes, 0), 242101668);
  assert.throws(() => validateManifest(amd64, "arm64"), /package_manifest_hash_mismatch/);
  assert.throws(() => validateManifest(arm64, "amd64"), /package_manifest_hash_mismatch/);
  assert.throws(() => validateManifest(Buffer.from("{}"), "arm64"), /package_manifest_hash_mismatch/);
  const tampered = structuredClone(armManifest);
  tampered.packages[0].sha256 = "0".repeat(64);
  assert.throws(() => validateManifest(manifestBytes(tampered), "arm64"), /package_manifest_hash_mismatch/);
  validateEntry(ARM_ENTRY, "arm64");
  assert.throws(() => validateEntry(ARM_ENTRY, "amd64"), /invalid_package_entry/);
  assert.throws(() => validateEntry({ ...ARM_ENTRY, architecture: "amd64" }, "arm64"), /invalid_package_entry/);
  assert.throws(() => validateEntry({ ...ARM_ENTRY, url: "https://archive.ubuntu.com/ubuntu/pool/main/libb/libbsd/libbsd0_0.12.1-1build1.1_arm64.deb" }, "arm64"), /invalid_package_source/);
  assert.throws(() => validateEntry({ ...ARM_ENTRY, url: "https://ports.ubuntu.com/ubuntu-ports/pool/main/libb/libbsd%2f..%2fx.deb" }, "arm64"), /invalid_package_source/);
  assert.throws(() => validateEntry({ ...constEntry(manifest), url: "https://ports.ubuntu.com/ubuntu-ports/pool/main/a/adduser/adduser_3.137ubuntu1_all.deb" }, "amd64"), /invalid_package_source/);
});

function constEntry(manifest) {
  return manifest.packages[0];
}

test("browser pins cover both CPUs, reject cross-platform URLs and refuse a missing ARM row", async () => {
  const lock = await loadBrowserLock();
  assert.equal(lock.browsers.arm64.version, "156.0.8078.80");
  assert.equal(lock.browsers.arm64.bytes, 200722708);
  assert.equal(lock.browsers.arm64.sha256, "1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724");
  assert.equal(lock.browsers.arm64.url, "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/linux-arm64/chrome-linux-arm64.zip");
  assert.equal(lock.browsers.amd64.bytes, 201329937);
  assert.equal(lock.browsers.amd64.sha256, "b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7");
  assert.throws(() => validateBrowserEntry({ ...lock.browsers.arm64, url: lock.browsers.arm64.url.replace("linux-arm64", "linux64") }, "arm64"), /invalid_browser_source/);
  assert.throws(() => validateBrowserEntry(lock.browsers.amd64, "arm64"), /invalid_browser_source/);
  assert.throws(() => validateBrowserEntry(lock.browsers.arm64, "amd64"), /invalid_browser_source/);
  assert.throws(() => validateBrowserEntry(lock.browsers.arm64, "riscv64"), /unsupported_target_architecture/);
  for (const mutate of [
    (value) => { value.browsers.arm64 = null; },
    (value) => { delete value.browsers.arm64; },
    (value) => { value.browsers.arm64.version = "156.0.8078.4"; },
    (value) => { value.browsers.arm64.url = "https://example.com/x.zip"; },
  ]) { const copy = structuredClone(lock); mutate(copy); assert.throws(() => validateBrowserLock(copy)); }
  const bytes = Buffer.from("synthetic arm64 chrome");
  await assert.rejects(() => downloadBrowser({ ...lock.browsers.arm64, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    path.join(tmpdir(), "eclipse-arm64-unused.zip"), { target: "arm64", fetchImpl: async () => { throw Error("offline"); } }));
});

test("CLI selections are explicit and the Dockerfile records and matches the CPU", async () => {
  const dockerfile = await readFile("docker/desktop/Dockerfile", "utf8");
  assert.match(dockerfile, /Eclipse Crew supports x86-64 \(amd64\) and 64-bit ARM \(arm64\); this machine is \$\{TARGETARCH:-unknown\}\./);
  assert.match(dockerfile, /amd64\|arm64/);
  assert.doesNotMatch(dockerfile, /test "\$TARGETARCH" = amd64/);
  assert.match(dockerfile, /printf '%s\\n' "\$TARGETARCH" > \/opt\/eclipse\/desktop\/image-arch/);
  assert.match(dockerfile, /node-v24\.22\.2-linux-arm64\.tar\.xz/);
  assert.match(dockerfile, /eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8/);
  assert.match(dockerfile, /48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75/);
  assert.match(dockerfile, /directory=chrome-linux-arm64/);
  assert.match(dockerfile, /mv "\/tmp\/chrome-extract\/\$directory" \/opt\/chrome-for-testing\/chrome-linux64/);
  assert.match(dockerfile, /TARGETARCH="\$TARGETARCH" node browser-build\.mjs fetch/);
  assert.match(dockerfile, /COPY ubuntu-packages\*\.lock\.json fetch-packages\.mjs/);

  const env = { ...process.env }; delete env.TARGETARCH;
  const cli = spawnSync(process.execPath, ["docker/desktop/browser-build.mjs", "fetch", path.join(process.cwd(), "data", "unused.zip")], { env, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /unsupported_target_architecture/);

  assert.equal(expectedNodeArch("amd64"), "x64");
  assert.equal(expectedNodeArch("arm64"), "arm64");
  assert.throws(() => expectedNodeArch("riscv64"), /runtime_identity_invalid/);
  assert.throws(() => expectedNodeArch(undefined), /runtime_identity_invalid/);
});

test("native acceptance preflight refuses an amd64 host and never claims a matrix result as native", () => {
  assert.deepEqual(classify({ machine: "x86_64", daemonArch: "x86_64" }),
    { outcome: "refused", reasons: ["host_not_arm64", "daemon_not_arm64"] });
  assert.equal(classify({ machine: "aarch64", daemonArch: "aarch64" }).outcome, "native_arm64_ready");
  assert.deepEqual(classify({ machine: "aarch64", daemonArch: "aarch64", imageArch: "amd64", imageMarker: "amd64" }),
    { outcome: "refused", reasons: ["image_not_arm64", "image_marker_not_arm64"] });
  const report = matrix(["native_build=pass"]);
  assert.equal(report.claimedNative, false);
  assert.equal(report.statuses.native_build, "pass");
  assert.equal(report.statuses.agent_users, "not_run");
  assert.equal(Object.keys(report.statuses).length, MATRIX.length);
  assert.throws(() => matrix(["unknown=pass"]), /unknown_matrix_step/);
  assert.throws(() => matrix(["native_build=maybe"]), /invalid_matrix_status/);
});
