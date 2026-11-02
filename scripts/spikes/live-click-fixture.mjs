import { createServer } from "node:http";

// Self-contained test page for the TASK-007 live-click spike. It mirrors the layout and copy of the
// original placeholder page (black page, 720 px column, "View project status" button) and loads nothing
// external, so the spike no longer depends on the application.
export const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Eclipse Crew</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;background:#000;color:#ededed;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
body{min-height:100vh}
main{width:720px;max-width:100%;margin:0 auto;box-sizing:border-box;padding-top:calc(15vh + 216px)}
h1{margin:0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.02em}
p{margin:18px 0 0;font-size:14px;line-height:20px;color:#a1a1a1}
details{margin-top:32px}
summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;box-sizing:border-box;width:175px;height:32px;padding:0 12px;border:1px solid #242424;border-radius:6px;background:#0a0a0a;color:#ededed;font-size:13px;font-weight:500;cursor:pointer;user-select:none}
summary::-webkit-details-marker{display:none}
summary svg{width:14px;height:14px}
section{margin-top:16px}
h2{margin:0;font-size:16px;line-height:24px;font-weight:600}
section p{margin-top:4px}
</style></head><body><main><h1>Eclipse Crew</h1><p>Your self-hosted AI crew is under construction.</p><details><summary>View project status<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg></summary><section aria-labelledby="status-title"><h2 id="status-title">Project status</h2><p>The application foundation is being built. Accounts, agents, and tools are not available yet.</p></section></details></main></body></html>`;

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
};

export function fixtureResponse(method, pathname) {
  if (method !== "GET") return { status: 405, headers: { Allow: "GET" } };
  if (pathname === "/") return { status: 200, headers: HEADERS, body: FIXTURE_HTML };
  if (pathname === "/favicon.ico") return { status: 204, headers: { "Cache-Control": "no-store" } };
  return { status: 404, headers: { "Cache-Control": "no-store" } };
}

// Loopback only, ephemeral port, GET / only. The caller must close it.
export async function startFixtureServer() {
  const server = createServer((request, response) => {
    let pathname = "";
    try { pathname = new URL(request.url ?? "", "http://fixture.invalid").pathname; } catch { /* 404 below */ }
    const result = fixtureResponse(request.method ?? "", pathname);
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
