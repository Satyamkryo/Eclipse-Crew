import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { Portal } from "./portal";
import { MONTHS } from "../../docker/desktop/mock-vendor/fixtures.mjs";

async function main() {
const root = path.resolve(".");
const output = path.join(root, "docker/desktop/mock-vendor/generated");
const source = '@import "tailwindcss" source(none);\n@import "tw-animate-css";\n@source "../scripts/mock-vendor/portal.tsx";\n@source "../components/ui/button.tsx";\n';
const globals = await readFile(path.join(root, "app/globals.css"), "utf8");
const css = await postcss([tailwind({ base: root, optimize: { minify: true } })]).process(
  source + globals.slice(globals.indexOf(":root")) + "\n:root{--font-geist-sans:system-ui;--font-geist-mono:ui-monospace}\n", { from: path.join(root, "app/mock-vendor.css") });
const files = new Map<string, string>([["portal.css", css.css]]);
for (const layout of ["a", "b"] as const) for (const month of MONTHS)
  files.set(`${layout}-${month}.html`, "<!doctype html>" + renderToStaticMarkup(<Portal layout={layout} month={month} />) + "\n");
const check = process.argv.includes("--check");
if (!check) await mkdir(output, { recursive: true });
for (const [name, contents] of files) {
  if (check) {
    if (await readFile(path.join(output, name), "utf8") !== contents) throw Error(`Stale mock portal asset: ${name}`);
  } else await writeFile(path.join(output, name), contents);
}
if (check && (await readdir(output)).sort().join() !== [...files.keys()].sort().join()) throw Error("Unexpected mock portal asset");
console.log(`Mock vendor assets ${check ? "verified" : "generated"}: ${files.size}`);
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
