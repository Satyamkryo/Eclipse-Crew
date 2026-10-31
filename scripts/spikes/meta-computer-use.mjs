import nextEnv from "@next/env";
import { parseArgs } from "node:util";

let values;
try {
  ({ values } = parseArgs({ options: { screenshot: { type: "string" }, live: { type: "boolean" }, help: { type: "boolean" } }, allowPositionals: false, strict: true }));
} catch {
  console.error("Use --screenshot <safe PNG path> --live. Keys are accepted only through the private environment.");
  process.exitCode = 1;
}

if (values) {
  if (values.help) {
    console.log("Usage: npm run spike:meta-computer-use -- --screenshot <safe PNG path> --live");
    console.log("Only include the non-sensitive placeholder page. Exclude browser chrome, logins, OTPs and personal information. Configure MODEL_API_KEY privately in .env.local.");
  } else {
    let safeError = () => "The probe failed safely; no raw diagnostics were printed.";
    try {
      const core = await import("./meta-computer-use-core.mjs");
      safeError = core.safeError;
      const { ProbeError, runProbe } = core;
      if (!values.live) throw new ProbeError("live_required");
      if (!values.screenshot) throw new ProbeError("invalid_arguments");
      try {
        nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() { throw new ProbeError("configuration_error"); } });
      } catch { throw new ProbeError("configuration_error"); }
      const { summary, runId, reviewFile } = await runProbe({ screenshotPath: values.screenshot, live: true, apiKey: process.env.MODEL_API_KEY });
      console.log(JSON.stringify({ outcome: summary.outcome, model: summary.model, requestCount: summary.requestCount,
        stages: summary.turns.map(({ stage, outcome, usage }) => ({ stage, outcome, usage })), ...(summary.click ? { click: summary.click } : {}),
        ...(summary.usage ? { usage: summary.usage } : {}), ...(summary.incompleteReason ? { incompleteReason: summary.incompleteReason } : {}),
        ...(summary.httpStatus ? { httpStatus: summary.httpStatus } : {}),
        ...(summary.invalidActionReason ? { invalidActionReason: summary.invalidActionReason } : {}),
        ...(summary.replayReason ? { replayReason: summary.replayReason } : {}),
        ...(summary.safetyReview ? { safetyReview: summary.safetyReview } : {}),
        ...(reviewFile ? { review: `data/spikes/task-007/${runId}/${reviewFile}` } : {}),
        ...(["invalid_action", "invalid_response", "observation_requested"].includes(summary.outcome) ? { actionShape: summary.actionShape } : {}),
        evidence: `data/spikes/task-007/${runId}/result.json`, executed: false, targetConfirmed: false }));
      if (summary.outcome !== "validated_click") {
        console.error(safeError(new ProbeError(summary.outcome)));
        process.exitCode = summary.outcome === "safety_review_required" ? 2 : 1;
      } else {
        console.log("Check the returned point against the screenshot. TASK-007 still requires owner confirmation of the target.");
      }
    } catch (error) {
      console.error(safeError(error));
      process.exitCode = 1;
    }
  }
}
