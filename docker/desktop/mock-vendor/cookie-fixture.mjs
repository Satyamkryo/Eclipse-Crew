import { createServer } from "node:http";

const PORT = 18765;
const SEEDS = new Set(["A", "B"]);

export async function startCookieFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const value = url.searchParams.get("value");
    let script = "";
    if (request.method === "GET" && url.pathname === "/drop") script = 'document.cookie="gone=; Max-Age=0; SameSite=Strict";';
    else if (request.method === "GET" && SEEDS.has(value)) {
      if (url.pathname === "/seed") script = 'localStorage.setItem("fixture",' + JSON.stringify(value) + ');document.cookie="fixture=' + value + '; Max-Age=3600; SameSite=Strict";document.cookie="sess=' + value + '; SameSite=Strict";document.cookie="gone=' + value + '; SameSite=Strict";';
      else if (url.pathname === "/late") script = 'document.cookie="late=' + value + '; SameSite=Strict";';
      else if (url.pathname === "/crash") script = 'document.cookie="crashc=' + value + '; SameSite=Strict";';
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end('<!doctype html><script>' + script + 'document.title="Fixture "+localStorage.getItem("fixture")+" Cookie "+document.cookie;</script>');
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 5000; server.maxConnections = 16;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(PORT, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${PORT}/`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
