// TASK-082. Pure document indexing and search. No I/O: the file tools read and validate the file, pass its text
// here, and store the result as the index. Everything is bounded because documents are hostile input.

export const MAX_QUERY_CHARS = 200;
export const MAX_QUERY_TERMS = 16;
export const CHUNK_CHARS = 1_500;
export const CHUNK_OVERLAP = 300;
export const MAX_INDEX_TEXT = 5_000_000;
export const MAX_INDEX_PAGES = 5_000;
export const MAX_INDEX_CHUNKS = Math.ceil(MAX_INDEX_TEXT / (CHUNK_CHARS - CHUNK_OVERLAP)) + 2;
export const MAX_RESULTS = 5;
export const MAX_RESULT_CHARS = CHUNK_CHARS;
const MAX_TERM_CHARS = 64;

const STOP = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does", "for", "from", "had", "has",
  "have", "he", "her", "here", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "no", "not", "of", "on",
  "or", "our", "she", "should", "so", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

const WORD = /[\p{L}\p{N}]+/gu;

// NFKC, lower case, letters and digits only. Stop words are dropped and a trailing plural s/es is removed. The regex is
// linear and each token is cut to 64 characters, so a hostile megabyte-long token costs the same as any other text.
export function tokenize(text) {
  const terms = [];
  if (typeof text !== "string" || text.length === 0) return terms;
  const source = text.length > MAX_INDEX_TEXT ? text.slice(0, MAX_INDEX_TEXT) : text;
  for (const match of source.normalize("NFKC").toLowerCase().matchAll(WORD)) {
    let term = match[0];
    if (term.length > MAX_TERM_CHARS) term = term.slice(0, MAX_TERM_CHARS);
    if (term.length < 2 || STOP.has(term)) continue;
    if (term.endsWith("ies") && term.length > 4) term = `${term.slice(0, -3)}y`;
    else if (/(?:s|x|z|ch|sh)es$/.test(term)) term = term.slice(0, -2);
    else if (term.endsWith("s") && !term.endsWith("ss") && term.length > 2) term = term.slice(0, -1);
    if (term.length >= 2) terms.push(term);
  }
  return terms;
}

// About 1,500 characters per chunk with 300 characters of overlap, cut at whitespace where possible, so a sentence that
// crosses a boundary is still found. A chunk never crosses a page, sheet or slide marker, so the page at its start is
// the page of everything in it. Offsets index the extracted text, the same text read_document windows use.
export function chunkText(text, pageStarts = []) {
  const chunks = [];
  if (typeof text !== "string" || text.length === 0) return chunks;
  const source = text.length > MAX_INDEX_TEXT ? text.slice(0, MAX_INDEX_TEXT) : text;
  const boundaries = (Array.isArray(pageStarts) ? pageStarts : [])
    .map((item) => item?.offset)
    .filter((offset) => Number.isSafeInteger(offset) && offset > 0 && offset < source.length)
    .sort((left, right) => left - right);
  const boundaryAfter = (from) => boundaries.find((offset) => offset > from) ?? source.length;
  let start = 0;
  while (start < source.length && chunks.length < MAX_INDEX_CHUNKS) {
    const segmentEnd = boundaryAfter(start);
    let end = Math.min(segmentEnd, start + CHUNK_CHARS);
    if (end < segmentEnd) {
      let cut = end;
      while (cut > start + 1 && !/\s/.test(source[cut - 1])) cut--;
      if (cut > start + 1) end = cut;
    } else end = segmentEnd;
    chunks.push({ offset: start, length: end - start });
    if (end >= source.length) break;
    start = end >= segmentEnd ? end : Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

// The stored index: the extracted text (with page markers), where each page/sheet/slide starts, its chunks and an
// inverted postings list. BM25 needs only these counts, so no vector database is involved.
export function buildIndex(text, pageStarts = []) {
  const source = typeof text === "string" ? text.slice(0, MAX_INDEX_TEXT) : "";
  const pages = pageStarts
    .filter((item) => Number.isSafeInteger(item?.offset) && item.offset >= 0 && item.offset <= source.length && Number.isSafeInteger(item?.page) && item.page >= 1)
    .slice(0, MAX_INDEX_PAGES)
    .map(({ offset, page }) => ({ offset, page }))
    .sort((left, right) => left.offset - right.offset || left.page - right.page);
  const chunks = chunkText(source, pages);
  const lengths = [];
  const postings = new Map();
  chunks.forEach((chunk, index) => {
    const tokens = tokenize(source.slice(chunk.offset, chunk.offset + chunk.length));
    lengths.push(tokens.length);
    const counts = new Map();
    for (const term of tokens) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, tf] of counts) {
      let list = postings.get(term);
      if (!list) postings.set(term, list = []);
      list.push([index, tf]);
    }
  });
  const avgdl = lengths.length ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0;
  return {
    v: 1,
    text: source,
    totalChars: source.length,
    pageStarts: pages,
    chunks,
    lengths,
    postings: [...postings.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    avgdl,
    truncated: typeof text === "string" && text.length > MAX_INDEX_TEXT,
  };
}

// BM25 (k1 = 1.2, b = 0.75) over the chunks. Returns the best passages by score, then offset, each with the page,
// sheet or slide number at its start. At most 16 unique query terms and 5 results.
export function searchIndex(index, query, limit = MAX_RESULTS) {
  if (!index || typeof index.text !== "string" || !Array.isArray(index.chunks) || !Array.isArray(index.postings)) return [];
  const raw = typeof query === "string" ? query : "";
  const terms = [...new Set(tokenize(raw.slice(0, MAX_QUERY_CHARS)))].slice(0, MAX_QUERY_TERMS);
  if (!terms.length) return [];
  const total = index.chunks.length;
  if (total === 0) return [];
  const avgdl = Number.isFinite(index.avgdl) && index.avgdl > 0 ? index.avgdl : 1;
  const dictionary = new Map(index.postings);
  const scores = new Map();
  for (const term of terms) {
    const list = dictionary.get(term);
    if (!list || !Array.isArray(list) || list.length === 0) continue;
    const df = list.length;
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
    for (const entry of list) {
      const [chunk, tf] = entry;
      if (!Number.isSafeInteger(chunk) || !Number.isSafeInteger(tf) || chunk < 0 || chunk >= total || tf < 1) continue;
      const length = index.lengths[chunk];
      if (!Number.isInteger(length) || length < 0) continue;
      const score = idf * ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (length / avgdl))));
      scores.set(chunk, (scores.get(chunk) ?? 0) + score);
    }
  }
  if (scores.size === 0) return [];
  const cap = Math.max(1, Math.min(MAX_RESULTS, Number.isSafeInteger(limit) ? limit : MAX_RESULTS));
  return [...scores.entries()]
    .map(([chunk, score]) => ({ chunk, score }))
    .sort((left, right) => right.score - left.score || index.chunks[left.chunk].offset - index.chunks[right.chunk].offset)
    .slice(0, cap)
    .map(({ chunk, score }) => {
      const { offset, length } = index.chunks[chunk];
      return {
        offset,
        page: pageAt(index.pageStarts, offset),
        text: index.text.slice(offset, offset + Math.min(length, MAX_RESULT_CHARS)),
        score: Number(score.toFixed(6)),
      };
    });
}

function pageAt(pageStarts, offset) {
  if (!Array.isArray(pageStarts) || pageStarts.length === 0) return null;
  let page = null;
  for (const item of pageStarts) {
    if (!item || typeof item.offset !== "number" || item.offset > offset) break;
    page = item.page;
  }
  return page;
}

const isCount = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const INDEX_KEYS = new Set(["v", "text", "totalChars", "pageStarts", "chunks", "lengths", "postings", "avgdl", "truncated", "sha256", "size", "format"]);
const itemKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

// Rejects a tampered, oversized or stale index. The caller passes the current file's digest and size; both must match.
export function validateIndex(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !INDEX_KEYS.has(key))) return null;
  if (value.v !== 1 || typeof value.text !== "string" || value.text.length > MAX_INDEX_TEXT) return null;
  if (!isCount(value.totalChars, MAX_INDEX_TEXT)) return null;
  if (expected.sha256 !== undefined && value.sha256 !== expected.sha256) return null;
  if (expected.size !== undefined && value.size !== expected.size) return null;
  if (!Array.isArray(value.pageStarts) || value.pageStarts.length > MAX_INDEX_PAGES) return null;
  if (!value.pageStarts.every((item) => item && itemKeys(item, ["offset", "page"]) && isCount(item.offset, value.text.length) && isCount(item.page, 1_000_000) && item.page >= 1)) return null;
  if (!Array.isArray(value.chunks) || value.chunks.length > MAX_INDEX_CHUNKS) return null;
  if (!value.chunks.every((item) => item && itemKeys(item, ["offset", "length"]) && isCount(item.offset, value.text.length) && isCount(item.length, CHUNK_CHARS) && item.offset + item.length <= value.text.length)) return null;
  if (!Array.isArray(value.lengths) || value.lengths.length !== value.chunks.length) return null;
  if (!value.lengths.every((item) => isCount(item, 1_000_000))) return null;
  if (!Array.isArray(value.postings) || value.postings.length > MAX_INDEX_CHUNKS * 8) return null;
  if (!value.postings.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[0].length >= 2 && entry[0].length <= MAX_TERM_CHARS &&
    Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].length <= value.chunks.length &&
    entry[1].every((pair) => Array.isArray(pair) && pair.length === 2 && isCount(pair[0], value.chunks.length - 1) && isCount(pair[1], 1_000_000) && pair[1] >= 1))) return null;
  if (typeof value.avgdl !== "number" || !Number.isFinite(value.avgdl) || value.avgdl < 0 || value.avgdl > 1_000_000) return null;
  if (typeof value.truncated !== "boolean") return null;
  return value;
}
