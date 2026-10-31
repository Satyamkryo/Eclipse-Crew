import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ORIGINAL_SHA256 = "ab23e2e197a6bd89af344c33a4939b9da458898b8d7b79f495466d088453f94d";
const MARKER = "// Eclipse Crew: pinned noVNC 1.6.0 browser module ESM compatibility.\n";
const names = ["hasScrollbarGutter", "dragThreshold", "isAndroid", "isBlink", "isChrome", "isChromeOS", "isChromium", "isEdge", "isFirefox", "isGecko", "isIOS", "isMac", "isOpera", "isSafari", "isTouchDevice", "isWebKit", "isWindows", "supportsWebCodecsH264Decode", "supportsCursorURIs"];
const prefix = `${MARKER}import * as compatLogging from "./logging.js";\nimport compatBase64 from "../base64.js";\nconst exports = {};\n`;
const previousPrefix = prefix.replace("import compatBase64", "import * as compatBase64");
const suffix = `\nexport { ${names.join(", ")} };\n`;
const hash = (source) => createHash("sha256").update(source).digest("hex");

// The npm artifact contains CommonJS exports with top-level await. Convert only
// that exact pinned file into real ESM; retain the awaited WebCodecs feature test,
// all browser detection, and the original upstream implementation/license.
export function normalizeNoVnc(source) {
  source = source.replaceAll("\r\n", "\n");
  const appliedPrefix = [prefix, previousPrefix].find((value) => source.startsWith(value) && source.endsWith(suffix));
  const original = appliedPrefix
    ? source.slice(appliedPrefix.length, -suffix.length).replace("_interopRequireWildcard(compatLogging)", '_interopRequireWildcard(require("./logging.js"))').replace("_interopRequireDefault(compatBase64)", '_interopRequireDefault(require("../base64.js"))')
    : source;
  if (hash(original) !== ORIGINAL_SHA256) throw Error("Unexpected noVNC browser module; refusing compatibility rewrite.");
  return prefix + original.replace('require("./logging.js")', "compatLogging").replace('require("../base64.js")', "compatBase64") + suffix;
}
export async function prepareNoVnc() {
  const packageUrl = new URL("../node_modules/@novnc/novnc/package.json", import.meta.url);
  if (JSON.parse(await readFile(packageUrl, "utf8")).version !== "1.6.0") throw Error("Unexpected noVNC version.");
  const target = new URL("./lib/util/browser.js", packageUrl);
  const before = await readFile(target, "utf8");
  const after = normalizeNoVnc(before);
  if (before !== after) await writeFile(target, after);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareNoVnc().catch(() => { console.error("Pinned noVNC compatibility preparation failed."); process.exitCode = 1; });
}
