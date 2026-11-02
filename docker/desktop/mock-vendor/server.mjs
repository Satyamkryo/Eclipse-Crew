import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { MONTHS, INVOICES, invoicePdf } from "./fixtures.mjs";

const querySchema = z.object({ month: z.enum(MONTHS).optional(), notice: z.enum(["switched", "reset"]).optional() }).strict();
const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("layout"), layout: z.enum(["a", "b"]), month: z.enum(MONTHS) }).strict(),
  z.object({ action: z.literal("reset") }).strict(),
]);
const tokenMatches = (value, token) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" };

export async function startMockVendor() {
  const assets = new Map();
  for (const layout of ["a", "b"]) for (const month of MONTHS)
    assets.set(`${layout}-${month}`, await readFile(new URL(`./generated/${layout}-${month}.html`, import.meta.url), "utf8"));
  const css = await readFile(new URL("./generated/portal.css", import.meta.url));
  const client = await readFile(new URL("./client.js", import.meta.url));
  const token = randomBytes(32).toString("hex");
  let layout = "a"; let origin; let active = 0;
  const server = createServer(async (request, response) => {
    let counted = false;
    const send = (status, type, body, extra = {}) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { ...HEADERS, "Content-Type": type, ...extra }); response.end(body);
    };
    const json = (status, code) => send(status, "application/json", JSON.stringify({ error: code }));
    try {
      if (active >= 12) { json(429, "too_many_requests"); return; }
      active++; counted = true;
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) { json(403, "origin_refused"); return; }
      if (request.headers["transfer-encoding"] && request.headers["content-length"]) { json(400, "invalid_request"); return; }
      if (!request.url?.startsWith("/") || request.url.startsWith("//")) { json(400, "invalid_request"); return; }
      const url = new URL(request.url, origin);
      const params = Object.fromEntries(url.searchParams);
      if ([...url.searchParams.keys()].length !== Object.keys(params).length) { json(400, "invalid_query"); return; }
      if (request.method === "POST" && url.pathname === "/__demo/control") {
        if (url.search || request.headers.origin !== origin || !tokenMatches(request.headers["x-demo-csrf"], token)) { json(403, "control_refused"); return; }
        if (request.headers["content-type"] !== "application/json") { json(415, "json_required"); return; }
        const declared = request.headers["content-length"];
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1024)) { json(413, "body_too_large"); return; }
        let body = ""; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024) { json(413, "body_too_large"); request.resume(); return; }
          body += chunk.toString("utf8");
        }
        let value;
        try {
          value = controlSchema.parse(JSON.parse(body));
          // The schema permits only a flat object of enum strings. Decode key
          // escapes as well, so duplicate JSON fields cannot be silently lost.
          const keys = [...body.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map((match) => JSON.parse(match[1]));
          if (new Set(keys).size !== keys.length) throw Error("duplicate_field");
        } catch { json(400, "invalid_control"); return; }
        layout = value.action === "reset" ? "a" : value.layout;
        const month = value.action === "reset" ? "2026-10" : value.month;
        send(200, "application/json", JSON.stringify({ path: `/?month=${month}&notice=${value.action === "reset" ? "reset" : "switched"}` })); return;
      }
      if (request.method !== "GET") { send(405, "application/json", '{"error":"method_not_allowed"}', { Allow: url.pathname === "/__demo/control" ? "POST" : "GET" }); return; }
      if (url.pathname === "/") {
        const parsed = querySchema.safeParse(params);
        if (!parsed.success) { json(400, "invalid_query"); return; }
        const { month = "2026-10", notice } = parsed.data;
        const message = notice === "reset" ? "Demo reset to layout A and October 2026." : notice === "switched" ? `Layout ${layout.toUpperCase()} is ready. Invoice data is unchanged.` : "";
        send(200, "text/html; charset=utf-8", assets.get(`${layout}-${month}`).replace("__DEMO_CSRF__", token).replace("__DEMO_NOTICE__", message)); return;
      }
      if (url.search) { json(400, "invalid_query"); return; }
      if (url.pathname === "/portal.css") { send(200, "text/css; charset=utf-8", css); return; }
      if (url.pathname === "/client.js") { send(200, "text/javascript; charset=utf-8", client); return; }
      if (url.pathname === "/favicon.ico") { send(204, "image/x-icon", ""); return; }
      const match = /^\/invoices\/(DEMO-\d{4})\.pdf$/.exec(url.pathname);
      const id = z.enum(INVOICES.map((invoice) => invoice.id)).safeParse(match?.[1]);
      if (match && id.success) {
        send(200, "application/pdf", invoicePdf(INVOICES.find((invoice) => invoice.id === id.data)), {
          "Content-Disposition": `attachment; filename="${id.data}.pdf"`, "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'" }); return;
      }
      send(404, "text/html; charset=utf-8", '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Document not found</title><link rel="stylesheet" href="/portal.css"></head><body class="p-6 text-sm"><h1 class="text-2xl font-semibold">Document not found</h1><p class="mt-4">Choose an invoice from the portal and try again.</p><a class="mt-4 inline-block underline underline-offset-4" href="/">Return to invoices</a></body></html>');
    } catch { json(500, "fixture_unavailable"); }
    finally { if (counted) active--; }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 5000; server.maxConnections = 16;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: `${origin}/`, origin, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
