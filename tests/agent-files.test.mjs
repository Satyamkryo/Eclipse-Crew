import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_WINDOW_CHARS, deliverFile, docxXmlToText, indexDocument, listFiles, readDocument, searchDocument, windowText,
} from "../docker/desktop/file-tools.mjs";
import { createFileServer } from "../docker/desktop/file-server.mjs";

const HAS_UNZIP = existsSync("/usr/bin/unzip");

async function layoutFor() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-files-"));
  const layout = { inbox: { dir: path.join(root, "inbox") }, work: { dir: path.join(root, "work") },
    downloads: { dir: path.join(root, "downloads") }, outbox: { dir: path.join(root, "outbox") } };
  for (const area of Object.values(layout)) await mkdir(area.dir, { recursive: true });
  return { root, layout, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const code = async (promise) => { try { await promise; return "no error"; } catch (error) { return error.code; } };

// A tiny PDF with one text line per page (or an empty page for a "scan"). pdf.js rebuilds a missing xref table.
function makePdf(lines) {
  const objects = [];
  const pageIds = lines.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${lines.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  lines.forEach((line, index) => {
    const stream = line === null ? "" : `BT /F1 18 Tf 72 700 Td ${line.split("\n").map((part, row) => `${row ? "0 -20 Td " : ""}(${part.replace(/[()\\]/g, "")}) Tj`).join(" ")} ET`;
    objects[4 + index * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[5 + index * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let body = "%PDF-1.4\n";
  for (let id = 1; id < objects.length; id++) body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  return Buffer.from(`${body}trailer\n<< /Root 1 0 R /Size ${objects.length} >>\n%%EOF\n`, "latin1");
}
// A stored (uncompressed) ZIP holding the given members, enough for [Content_Types].xml based classification.
function makeZip(members) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(members)) {
    const nameBytes = Buffer.from(name); const data = Buffer.from(text); const crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(header, nameBytes, data); central.push(entry, nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(members).length, 8); end.writeUInt16LE(Object.keys(members).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfJ8AAAAASUVORK5CYII=", "base64");

test("text, markdown, CSV and JSON attachments read as text with the total length", async () => {
  const { layout, cleanup } = await layoutFor();
  try {
    const files = { "notes.txt": "Hello\nworld", "readme.md": "# Title\n\ntext", "table.csv": "a,b\n1,2\n", "data.json": '{"k":[1,2]}' };
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(layout.inbox.dir, name), text);
      const result = await readDocument({ home: "unused", name, layout });
      assert.deepEqual([result.kind, result.format, result.text, result.nextOffset, result.totalChars], ["text", "text", text, null, text.length]);
    }
  } finally { await cleanup(); }
});

test("long documents are read in exact windows of at most 20,000 characters", async () => {
  const { layout, cleanup } = await layoutFor();
  try {
    const text = "abcdefghij".repeat(15_000) + "END"; // 150,003 characters
    await writeFile(path.join(layout.inbox.dir, "big.txt"), text);
    let offset = 0; const parts = [];
    for (let guard = 0; guard < 20; guard++) {
      const result = await readDocument({ home: "unused", name: "big.txt", offset, layout });
      assert.ok(result.text.length <= MAX_WINDOW_CHARS);
      assert.equal(result.offset, offset); assert.equal(result.totalChars, text.length);
      parts.push(result.text);
      if (result.nextOffset === null) break;
      assert.equal(result.nextOffset, offset + result.text.length); offset = result.nextOffset;
    }
    assert.equal(parts.length, 8); assert.equal(parts.join(""), text);
    assert.equal(await code(readDocument({ home: "unused", name: "big.txt", offset: text.length, layout })), "invalid_offset");
    assert.equal(await code(readDocument({ home: "unused", name: "big.txt", offset: -1, layout })), "invalid_offset");
    // A window never splits a surrogate pair.
    const emoji = "a" + "\u{1F600}".repeat(40_000);
    const cut = windowText(emoji, 0);
    assert.ok(cut.nextOffset !== null && cut.nextOffset % 2 === 1 && !/[\ud800-\udbff]$/.test(cut.text));
  } finally { await cleanup(); }
});

test("PDF with a text layer reads; a scan without text, and a corrupt PDF, give fixed codes", async () => {
  const { layout, cleanup } = await layoutFor();
  try {
    await writeFile(path.join(layout.inbox.dir, "a.pdf"), makePdf(["Quarterly revenue grew twelve percent", "Second page text"]));
    const result = await readDocument({ home: "unused", name: "a.pdf", layout });
    assert.equal(result.format, "pdf");
    assert.match(result.text, /Quarterly revenue grew twelve percent/);
    assert.match(result.text, /Second page text/);
    await writeFile(path.join(layout.inbox.dir, "scan.pdf"), makePdf([null]));
    assert.equal(await code(readDocument({ home: "unused", name: "scan.pdf", layout })), "no_text_layer");
    await writeFile(path.join(layout.inbox.dir, "bad.pdf"), "%PDF-1.4\nthis is not a pdf at all");
    assert.equal(await code(readDocument({ home: "unused", name: "bad.pdf", layout })), "document_unreadable");
  } finally { await cleanup(); }
});

test("docx, xlsx and pptx text is extracted with page, sheet and slide markers", { skip: !HAS_UNZIP && "needs /usr/bin/unzip (runs in the desktop container)" }, async () => {
  const { layout, cleanup } = await layoutFor();
  try {
    const xml = '<w:document><w:body><w:p><w:r><w:t>Budget &amp; plan</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r><w:tab/><w:r><w:t>line</w:t></w:r></w:p></w:body></w:document>';
    await writeFile(path.join(layout.inbox.dir, "r.docx"), makeZip({ "[Content_Types].xml": "<Types/>", "word/document.xml": xml }));
    const result = await readDocument({ home: "unused", name: "r.docx", layout });
    assert.equal(result.format, "docx"); assert.equal(result.text, "Budget & plan\nSecond\tline");

    const workbook = '<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Summary" sheetId="2" r:id="rId2"/></sheets></workbook>';
    const shared = '<sst><si><t>Region</t></si><si><t>North</t></si></sst>';
    const sheet1 = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>42</v></c></row></sheetData></worksheet>';
    const sheet2 = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Total revenue</t></is></c></row></sheetData></worksheet>';
    await writeFile(path.join(layout.inbox.dir, "s.xlsx"), makeZip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": workbook,
      "xl/sharedStrings.xml": shared, "xl/worksheets/sheet1.xml": sheet1, "xl/worksheets/sheet2.xml": sheet2 }));
    const book = await readDocument({ home: "unused", name: "s.xlsx", layout });
    assert.equal(book.format, "xlsx");
    assert.match(book.text, /--- sheet "Sales" ---/);
    assert.match(book.text, /Region,North/);
    assert.match(book.text, /42/);
    assert.match(book.text, /--- sheet "Summary" ---/);
    assert.match(book.text, /Total revenue/);
    const sales = await searchDocument({ home: "unused", name: "s.xlsx", query: "North", layout });
    assert.equal(sales.results[0].page, 1);
    const summary = await searchDocument({ home: "unused", name: "s.xlsx", query: "revenue", layout });
    assert.equal(summary.results[0].page, 2);

    const slide1 = '<p:sld><p:cSld><p:spTree><a:t>Welcome</a:t></p:spTree></p:cSld></p:sld>';
    const slide2 = '<p:sld><p:cSld><p:spTree><a:t>Quarterly numbers</a:t></p:spTree></p:cSld></p:sld>';
    const slide3 = '<p:sld><p:cSld><p:spTree><a:t>Renewal deadline is September thirty</a:t></p:spTree></p:cSld></p:sld>';
    await writeFile(path.join(layout.inbox.dir, "d.pptx"), makeZip({ "[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<p:presentation/>",
      "ppt/slides/slide1.xml": slide1, "ppt/slides/slide2.xml": slide2, "ppt/slides/slide3.xml": slide3 }));
    const deck = await readDocument({ home: "unused", name: "d.pptx", layout });
    assert.equal(deck.format, "pptx");
    assert.match(deck.text, /--- slide 1 ---\nWelcome/);
    assert.match(deck.text, /--- slide 2 ---\nQuarterly numbers/);
    const found = await searchDocument({ home: "unused", name: "d.pptx", query: "Quarterly", layout });
    assert.equal(found.results[0].page, 2);
    const renewal = await searchDocument({ home: "unused", name: "d.pptx", query: "Renewal deadline", layout });
    assert.equal(renewal.results[0].page, 3);
    assert.match(renewal.results[0].text, /September thirty/);

    await writeFile(path.join(layout.inbox.dir, "empty.xlsx"), makeZip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<w/>" }));
    assert.equal(await code(readDocument({ home: "unused", name: "empty.xlsx", layout })), "document_unreadable");
    await writeFile(path.join(layout.inbox.dir, "corrupt.docx"), makeZip({ "[Content_Types].xml": "<Types/>", "other.xml": "<x/>" }));
    assert.equal(await code(readDocument({ home: "unused", name: "corrupt.docx", layout })), "document_unreadable");
  } finally { await cleanup(); }
});

test("PDF pages carry page markers; search returns the right page and a usable read offset", async () => {
  const { layout, cleanup } = await layoutFor();
  try {
    await writeFile(path.join(layout.inbox.dir, "long.pdf"), makePdf(["first page alpha", "termination clause applies here", "third page omega"]));
    const read = await readDocument({ home: "unused", name: "long.pdf", layout });
    assert.match(read.text, /--- page 1 ---/);
    assert.match(read.text, /--- page 2 ---/);
    const found = await searchDocument({ home: "unused", name: "long.pdf", query: "termination", layout });
    assert.equal(found.results[0].page, 2);
    const window = await readDocument({ home: "unused", name: "long.pdf", offset: found.results[0].offset, layout });
    assert.ok(window.text.startsWith(found.results[0].text.slice(0, 20)));
    assert.equal(await code(searchDocument({ home: "unused", name: "long.pdf", query: "zebra", layout })), "no_match");
    assert.equal(await code(searchDocument({ home: "unused", name: "long.pdf", query: "the and of", layout })), "no_match");
  } finally { await cleanup(); }
});

test("a 120-page PDF finds a deep clause beyond the initial read window with its page citation", async () => {
  const { layout, cleanup } = await layoutFor();
  try {
    const lines = Array.from({ length: 120 }, (_, index) => index === 96
      ? "Indemnity clause requires thirty days notice"
      : `Routine background page ${index + 1}\n${"ordinary reference material\n".repeat(16)}`);
    await writeFile(path.join(layout.inbox.dir, "contract.pdf"), makePdf(lines));
    const initial = await readDocument({ home: "unused", name: "contract.pdf", layout });
    assert.doesNotMatch(initial.text, /indemnity/);
    const found = await searchDocument({ home: "unused", name: "contract.pdf", query: "indemnity", layout });
    assert.equal(found.results[0].page, 97);
    assert.ok(found.results[0].offset > MAX_WINDOW_CHARS);
    assert.match(found.results[0].text, /thirty days notice/);
    const window = await readDocument({ home: "unused", name: "contract.pdf", offset: found.results[0].offset, layout });
    assert.match(window.text, /Indemnity clause/);
  } finally { await cleanup(); }
});

test("search refuses images and the index cache is reused, rebuilt and capped at 20 files", async () => {
  const { root, layout, cleanup } = await layoutFor();
  const cacheDir = path.join(root, "cache");
  try {
    await writeFile(path.join(layout.inbox.dir, "p.png"), PNG);
    assert.equal(await code(searchDocument({ home: "unused", name: "p.png", query: "pixel", layout, cacheDir })), "unsupported_type");

    const notes = path.join(layout.inbox.dir, "notes.txt");
    await writeFile(notes, "alpha beta");
    assert.equal((await readDocument({ home: "unused", name: "notes.txt", layout, cacheDir })).text, "alpha beta");
    const names = await readdir(cacheDir);
    assert.equal(names.length, 1);
    // A surviving cache is reused rather than re-extracted (the source is unchanged, so the stored text wins).
    const cachedPath = path.join(cacheDir, names[0]);
    const cached = JSON.parse(await readFile(cachedPath, "utf8"));
    assert.equal(cached.text, "alpha beta");
    cached.text = "alpha CACH";
    await writeFile(cachedPath, JSON.stringify(cached));
    assert.equal((await readDocument({ home: "unused", name: "notes.txt", layout, cacheDir })).text, "alpha CACH");
    // A changed file gets a new digest and a fresh index.
    await writeFile(notes, "alpha beta changed");
    assert.match((await readDocument({ home: "unused", name: "notes.txt", layout, cacheDir })).text, /changed/);
    assert.equal((await readdir(cacheDir)).length, 2);

    for (let index = 0; index < 21; index++) {
      await writeFile(path.join(layout.inbox.dir, `n${index}.txt`), `value ${index}`);
      await indexDocument({ home: "unused", name: `n${index}.txt`, layout, cacheDir });
    }
    assert.equal((await readdir(cacheDir)).length, 20);
    const listing = await listFiles({ home: "unused", layout });
    assert.ok(listing.files.every((entry) => !entry.name.startsWith(".")), "the hidden cache is never listed");
    assert.equal(await code(deliverFile({ home: "unused", from: "work", name: ".cache", layout })), "file_not_found");
  } finally { await cleanup(); }
});

test("docx XML conversion keeps paragraphs and decodes entities safely", () => {
  assert.equal(docxXmlToText("<w:p><w:t>A &lt;b&gt; &#65;&#x42; &#0; &#xD800;</w:t></w:p><w:p/><w:p><w:t>C</w:t></w:p>"), "A <b> AB  \nC");
});

test("images read as base64 with their type; other media and oversized images are refused", async () => {
  const { layout, cleanup } = await layoutFor();
  try {
    await writeFile(path.join(layout.inbox.dir, "p.png"), PNG);
    const result = await readDocument({ home: "unused", name: "p.png", layout });
    assert.deepEqual([result.kind, result.mime, result.base64], ["image", "image/png", PNG.toString("base64")]);
    await writeFile(path.join(layout.inbox.dir, "big.png"), Buffer.concat([PNG, Buffer.alloc(4 * 1024 ** 2)]));
    assert.equal(await code(readDocument({ home: "unused", name: "big.png", layout })), "file_too_large");
    await writeFile(path.join(layout.inbox.dir, "c.gif"), Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40)]));
    assert.equal(await code(readDocument({ home: "unused", name: "c.gif", layout })), "unsupported_type");
    await writeFile(path.join(layout.inbox.dir, "song.mp3"), Buffer.concat([Buffer.from("ID3"), Buffer.alloc(40)]));
    assert.equal(await code(readDocument({ home: "unused", name: "song.mp3", layout })), "unsupported_type");
  } finally { await cleanup(); }
});

test("reads refuse traversal, hidden names, symlinks, hard links and missing files", async () => {
  const { root, layout, cleanup } = await layoutFor();
  try {
    await writeFile(path.join(root, "secret.txt"), "outside");
    await writeFile(path.join(layout.inbox.dir, "ok.txt"), "fine");
    for (const name of ["../secret.txt", "..\\secret.txt", "sub/ok.txt", ".hidden", "", "missing.txt", "a\u0000b.txt"])
      assert.equal(await code(readDocument({ home: "unused", name, layout })), "file_not_found", name);
    await link(path.join(layout.inbox.dir, "ok.txt"), path.join(layout.inbox.dir, "twin.txt"));
    assert.equal(await code(readDocument({ home: "unused", name: "twin.txt", layout })), "file_not_found");
    let linked = true; try { await symlink(path.join(root, "secret.txt"), path.join(layout.inbox.dir, "sym.txt")); } catch { linked = false; }
    if (linked) assert.equal(await code(readDocument({ home: "unused", name: "sym.txt", layout })), "file_not_found");
  } finally { await cleanup(); }
});

test("list shows plain regular files from inbox, downloads and work only, at most 50", async () => {
  const { layout, cleanup } = await layoutFor();
  try {
    await writeFile(path.join(layout.inbox.dir, "in.txt"), "x");
    await writeFile(path.join(layout.downloads.dir, "report.pdf"), makePdf(["hi"]));
    await writeFile(path.join(layout.work.dir, "w.csv"), "a,b");
    await writeFile(path.join(layout.outbox.dir, "out.txt"), "not listed");
    await writeFile(path.join(layout.work.dir, ".hidden"), "x");
    await writeFile(path.join(layout.work.dir, "tool.exe"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
    const { files } = await listFiles({ home: "unused", layout });
    const names = files.map((file) => `${file.area}/${file.name}`).sort();
    assert.deepEqual(names, ["downloads/report.pdf", "inbox/in.txt", "work/tool.exe", "work/w.csv"]);
    assert.equal(files.find((file) => file.name === "tool.exe").kind, "blocked");
    for (let index = 0; index < 70; index++) await writeFile(path.join(layout.work.dir, `f${index}.txt`), "x");
    assert.equal((await listFiles({ home: "unused", layout })).files.length, 50);
  } finally { await cleanup(); }
});

test("deliver copies a download or work file to outbox, never overwrites, and keeps the source", async () => {
  const { layout, cleanup } = await layoutFor();
  try {
    const pdf = makePdf(["Hello"]);
    await writeFile(path.join(layout.downloads.dir, "report.pdf"), pdf);
    const first = await deliverFile({ home: "unused", from: "downloads", name: "report.pdf", layout });
    const second = await deliverFile({ home: "unused", from: "downloads", name: "report.pdf", layout });
    assert.deepEqual([first.name, second.name, first.kind, first.size], ["report.pdf", "report (2).pdf", "pdf", pdf.length]);
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(await readFile(path.join(layout.outbox.dir, "report.pdf")), pdf);
    assert.deepEqual(await readFile(path.join(layout.downloads.dir, "report.pdf")), pdf);
    assert.deepEqual((await readdir(layout.outbox.dir)).sort(), ["report (2).pdf", "report.pdf"]);
    await writeFile(path.join(layout.work.dir, "answer.md"), "# done");
    assert.equal((await deliverFile({ home: "unused", from: "work", name: "answer.md", layout })).kind, "text");
  } finally { await cleanup(); }
});

test("deliver refuses scripts, programs, renamed content, other areas and unsafe names", async () => {
  const { root, layout, cleanup } = await layoutFor();
  try {
    await writeFile(path.join(layout.work.dir, "fake.pdf"), "#!/bin/sh\necho hi\n");
    await writeFile(path.join(layout.work.dir, "text.pdf"), "just words, not a pdf");
    await writeFile(path.join(layout.work.dir, "run.sh"), "echo hi\n");
    await writeFile(path.join(layout.work.dir, "app.exe"), Buffer.from("MZ\u0090\u0000"));
    await writeFile(path.join(layout.work.dir, "elf.txt"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
    await writeFile(path.join(layout.work.dir, "empty.txt"), "");
    await writeFile(path.join(layout.inbox.dir, "mine.txt"), "inbox is not a source");
    await writeFile(path.join(root, "outside.txt"), "x");
    for (const [from, name, expected] of [["work", "fake.pdf", "type_blocked"], ["work", "text.pdf", "type_blocked"], ["work", "run.sh", "type_blocked"],
      ["work", "app.exe", "type_blocked"], ["work", "elf.txt", "type_blocked"], ["work", "empty.txt", "file_not_found"], ["inbox", "mine.txt", "file_not_found"],
      ["outbox", "x.txt", "file_not_found"], ["work", "../outside.txt", "file_not_found"], ["work", "nope.txt", "file_not_found"]])
      assert.equal(await code(deliverFile({ home: "unused", from, name, layout })), expected, `${from}/${name}`);
    assert.deepEqual(await readdir(layout.outbox.dir), []);
  } finally { await cleanup(); }
});

test("file tool requests are validated and unknown fields, paths and areas are refused before any launch", async () => {
  const launches = [];
  const secret = "a".repeat(64);
  const server = createFileServer(secret, {
    resolveApp: async () => [{ address: "127.0.0.1" }], inspect: async () => ({ agentId: "x" }),
    launch: (_record, args) => { launches.push(args); throw new Error("must not launch"); },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const OWNER = "11111111-1111-4111-8111-111111111111"; const AGENT = "22222222-2222-4222-8222-222222222222";
  const post = (action, body, extra = {}) => fetch(`http://127.0.0.1:${port}/v1/owners/${OWNER}/agents/${AGENT}/files/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...extra }, body: JSON.stringify(body) });
  try {
    for (const [action, body] of [["read", { name: "../etc/passwd" }], ["read", { name: "a.txt", extra: 1 }], ["read", { name: "a.txt", offset: -1 }],
      ["deliver", { from: "inbox", name: "a.txt" }], ["deliver", { from: "work", name: "dir/a.txt" }], ["list", { all: true }],
      ["search", { name: "a.txt" }], ["search", { name: "a.txt", query: "" }], ["search", { name: "a.txt", query: "x".repeat(201) }],
      ["search", { name: "a.txt", query: "bad\u0001query" }], ["search", { name: "a.txt", query: "ok", extra: 1 }],
      ["search", { name: "../secret.txt", query: "ok" }]]) {
      const response = await post(action, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), { outcome: "error", code: "invalid_request" });
    }
    assert.equal((await post("list", {}, { Authorization: "Bearer wrong" })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/owners/${OWNER}/agents/${AGENT}/files/format`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/owners/${OWNER}/agents/${AGENT}/files/index`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }, body: JSON.stringify({ name: "a.txt" }) })).status, 404,
      "indexing is never reachable over HTTP");
    assert.equal(launches.length, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
