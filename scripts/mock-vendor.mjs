import { parseArgs } from "node:util";
import { desktopAgent } from "./desktop-agent.mjs";
import { startMockVendor } from "../docker/desktop/mock-vendor/server.mjs";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    owner: { type: "string" }, agent: { type: "string" }, project: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) console.log("npm run mock-vendor -- <start|status|stop> --owner UUID --agent UUID [--project NAME]; npm run mock-vendor:preview");
  else if (positionals.length === 1 && positionals[0] === "preview" && !Object.keys(values).length) {
    const fixture = await startMockVendor(); console.log(JSON.stringify({ mode: "host-preview", url: fixture.url }));
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void fixture.close(); });
  } else {
    if (positionals.length !== 1 || !["start", "status", "stop"].includes(positionals[0])) throw Error("invalid_command");
    if (positionals[0] === "start") {
      // TASK-071: the fixture runs inside the agent session namespace, so Chromium reaches its own loopback.
      process.exitCode = await desktopAgent({ command: "session-fixture", ownerId: values.owner, agentId: values.agent, project: values.project });
    } else {
      console.log(JSON.stringify({ mode: "session-namespace", note: positionals[0] === "stop" ? "Stop or restart the agent session to end the fixture." : "The fixture runs inside the live agent session." }));
    }
  }
} catch { console.error('{"error":"mock_vendor_refused"}'); process.exitCode = 1; }
