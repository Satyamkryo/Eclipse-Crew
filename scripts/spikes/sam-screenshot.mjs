import "server-only";
import nextEnv from "@next/env";
import { parseArgs } from "node:util";
import { runSamProbe, SamError, safeSamError } from "./sam-screenshot-core.mjs";

try {
  let values;
  try { ({ values } = parseArgs({ options: { screenshot: { type: "string" }, live: { type: "boolean" }, help: { type: "boolean" } }, strict: true, allowPositionals: false })); }
  catch { throw new SamError("invalid_arguments"); }
  if (values.help) {
    console.log("Usage: npm run spike:sam-screenshot -- --screenshot <safe PNG path> --live");
    console.log("One SAM image request, 30-second timeout, no retries. Configure MODEL_API_KEY privately; select only the safe placeholder screenshot.");
  } else {
    if (!values.live) throw new SamError("live_required");
    if (!values.screenshot) throw new SamError("invalid_arguments");
    try { nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() { throw new SamError("configuration_error"); } }); }
    catch { throw new SamError("configuration_error"); }
    const { summary, runId } = await runSamProbe({ screenshotPath: values.screenshot, apiKey: process.env.MODEL_API_KEY, live: true });
    console.log(JSON.stringify({ ...summary, evidence: `data/spikes/task-008/${runId}/result.json` }));
    if (summary.outcome !== "validated_masks") {
      console.error(safeSamError(new SamError(summary.outcome))); process.exitCode = 1;
    } else console.log("Inspect the masks against the original screenshot; validated geometry alone does not confirm the target.");
  }
} catch (error) { console.error(safeSamError(error)); process.exitCode = 1; }
