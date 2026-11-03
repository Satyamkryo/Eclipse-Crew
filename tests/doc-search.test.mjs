import assert from "node:assert/strict";
import test from "node:test";

import {
  CHUNK_CHARS, CHUNK_OVERLAP, MAX_QUERY_TERMS, buildIndex, chunkText, searchIndex, tokenize, validateIndex,
} from "../docker/desktop/doc-search.mjs";

const page = (number) => `--- page ${number} ---`;
const SIZE = 1_000;
const sha256 = "a".repeat(64);

function sample() {
  const first = `${page(1)}\nalpha beta gamma delta`;
  const second = `${page(2)}\nThe termination clause applies after thirty days.`;
  const text = `${first}\n\n${second}`;
  const pageStarts = [{ offset: 0, page: 1 }, { offset: first.length + 2, page: 2 }];
  return buildIndex(text, pageStarts);
}

test("an exact term ranks its passage first and carries its page", () => {
  const results = searchIndex(sample(), "termination");
  assert.ok(results.length >= 1);
  assert.match(results[0].text, /termination clause/);
  assert.equal(results[0].page, 2);
  assert.ok(results[0].score > 0);
  assert.ok(results[0].offset > 0);
});

test("chunks overlap, so a sentence crossing a boundary is still findable", () => {
  const filler = "filler ".repeat(300);
  const text = `${filler}crossingboundary phrase ends here ${filler}`;
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  for (let index = 1; index < chunks.length; index++) {
    const previous = chunks[index - 1];
    assert.ok(chunks[index].offset < previous.offset + previous.length, "next chunk starts before the previous one ends");
    assert.ok(previous.offset + previous.length - chunks[index].offset >= CHUNK_OVERLAP);
  }
  const index = buildIndex(text);
  assert.ok(index.chunks.every((chunk) => chunk.length <= CHUNK_CHARS));
  assert.equal(searchIndex(index, "crossingboundary").length, 1);
});

test("a stop-word-only query and a query with no matching term return no passages", () => {
  assert.deepEqual(searchIndex(sample(), "the and of to"), []);
  assert.deepEqual(searchIndex(sample(), "zebra"), []);
  assert.deepEqual(searchIndex(sample(), ""), []);
  assert.deepEqual(searchIndex(sample(), "a"), [], "single-character terms are ignored");
});

test("query length, term count and result count are bounded", () => {
  const words = Array.from({ length: 40 }, (_, index) => `term${index}`).join(" ");
  const index = buildIndex(words);
  assert.ok(tokenize(words).length > MAX_QUERY_TERMS);
  assert.ok(searchIndex(index, words).length <= 5);
  assert.ok(searchIndex(index, "x".repeat(10_000)).length <= 5);
  assert.ok(searchIndex(index, words, 3).length <= 3);
});

test("a hostile long token is bounded and does not stall the tokenizer", () => {
  const started = Date.now();
  const terms = tokenize(`${"A".repeat(200_000)} normal`);
  assert.ok(Date.now() - started < 2_000);
  assert.ok(terms.every((term) => term.length <= 64));
  assert.equal(terms.at(-1), "normal");
});

test("plural stems match, and case and Unicode normalization are applied", () => {
  const index = buildIndex("Invoices for Café accounts");
  assert.equal(searchIndex(index, "invoice").length, 1);
  assert.equal(searchIndex(index, "CAFÉ").length, 1);
  assert.equal(searchIndex(buildIndex("Boxes and watches"), "box").length, 1);
  assert.equal(searchIndex(buildIndex("Boxes and watches"), "watch").length, 1);
});

test("a tampered, stale or oversized index is rejected", () => {
  const index = sample();
  const valid = { ...index, sha256, size: SIZE };
  assert.equal(validateIndex(valid, { sha256, size: SIZE }), valid);
  assert.equal(validateIndex(valid, { sha256: "b".repeat(64), size: SIZE }), null, "another file's index");
  assert.equal(validateIndex(valid, { sha256, size: SIZE + 1 }), null, "a changed file");
  assert.equal(validateIndex({ ...valid, v: 2 }, { sha256, size: SIZE }), null);
  assert.equal(validateIndex({ ...valid, text: "x".repeat(5_000_001) }, { sha256, size: SIZE }), null);
  assert.equal(validateIndex({ ...valid, chunks: [{ offset: 999999, length: 10 }] }, { sha256, size: SIZE }), null);
  assert.equal(validateIndex({ ...valid, postings: [["a"]] }, { sha256, size: SIZE }), null);
  assert.equal(validateIndex(null), null);
  assert.equal(validateIndex({ ...valid, extra: true }, { sha256, size: SIZE }), null, "unknown fields are refused");
});
