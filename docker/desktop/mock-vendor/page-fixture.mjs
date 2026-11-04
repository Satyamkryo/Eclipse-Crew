import { createServer } from "node:http";

// Test-only A/B page for the desktop primitive probes (screenshots, page listing, sensitive-field denial).
// Runs inside the agent's own network namespace (TASK-071), so the agent's Chromium reaches it on its loopback.
const PORT = 18766;

export async function startPageFixture() {
  const server = createServer((request, response) => {
    const a = request.url === "/A";
    const label = a ? "Audit A" : "Audit B";
    const color = a ? "240,20,20" : "20,20,240";
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end('<!doctype html><title>' + label + '</title><body data-label="' + label + '" style="background:rgb(' + color + ');margin:30px">' +
      '<textarea oninput="document.title=document.body.dataset.label+String.fromCharCode(32)+this.value" style="width:400px;height:90px"></textarea>' +
      '<input id="sensitive-password" type="password"><input id="sensitive-code" autocomplete="one-time-code"></body>');
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 5000; server.maxConnections = 16;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(PORT, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${PORT}/`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
