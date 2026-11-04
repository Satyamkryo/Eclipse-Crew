import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
const unwrap = (m) => m.default ?? m;
const { TeachControls, CaptureReview } = unwrap(await import("../components/desktop/teach-controls.tsx"));
const { parseTeachCapture, parseTeachCaptureList, privacyPauseText } = unwrap(await import("../lib/teach/client.ts"));
const id = "11111111-1111-4111-8111-111111111111";
const capture = { captureId: id, state: "recording", activeMs: 62000, eventCount: 4, narration: false };
const props = { capture: null, saved: [], busy: false, error: null, narrationAllowed: true, canRecord: true, onAction: async () => {}, onRetryTranscription: async () => {} };
const render = (p) => renderToStaticMarkup(React.createElement(TeachControls, { ...props, ...p }));

test("ordinary takeover has opt-in Record and microphone remains unchecked", () => {
  const html = render({});
  assert.match(html, />Record</); assert.doesNotMatch(html, /Include microphone narration/);
  assert.doesNotMatch(html, /type="checkbox"/); assert.doesNotMatch(html, /audio is sent to Meta/);
  assert.doesNotMatch(html, />Pause</);
});
test("recording controls expose elapsed time, pause, stop and discard accessibly", () => {
  const html = render({ capture });
  assert.match(html, /1:02/); assert.match(html, /4.*events/); assert.match(html, />Pause</); assert.match(html, />Stop</); assert.match(html, />Discard</);
  assert.match(html, /aria-live="polite"/); assert.match(html, /motion-safe:animate-pulse/);
});
test("privacy pause needs explicit resume and never renders an arbitrary server reason", () => {
  const html = render({ capture: { ...capture, state: "paused", reason: "secret-sentinel-password" } });
  assert.match(html, /Needs you/); assert.match(html, />Resume</); assert.doesNotMatch(html, /secret-sentinel/);
  assert.equal(privacyPauseText("untrusted page text"), "Recording paused for privacy. Check the managed browser before resuming.");
});
test("view-only controls are disabled", () => {
  const html = render({ narrationAllowed: false, canRecord: false });
  assert.doesNotMatch(html, /native Meta Main provider/);
  assert.match(html, /disabled=""[^>]*>Record</);
});
test("saved recordings are reopenable with bounded metadata and fail closed on malformed rows", () => {
  const summary = { captureId: id, state: "complete", activeMs: 62000, eventCount: 4, narration: true, narrationStatus: "complete", createdAt: "2026-11-02T10:00:00.000Z" };
  const html = render({ saved: [summary] });
  assert.match(html, /Saved recordings \(1\)/);
  assert.deepEqual(parseTeachCaptureList([summary]), [summary]);
  for (const bad of [[{ ...summary, captureId: "../escape" }], [{ ...summary, state: "recording" }], [{ ...summary, extra: true }], [{ ...summary, createdAt: "secret" }], Array(21).fill(summary)])
    assert.throws(() => parseTeachCaptureList(bad));
});

test("capture responses fail closed for malformed identifiers, state and counters", () => {
  assert.equal(parseTeachCapture(capture).state, "recording");
  for (const mutation of [{captureId:"../outside"}, {state:"unknown"}, {activeMs:-1}, {eventCount:NaN}, {narration: "yes"}]) assert.throws(() => parseTeachCapture({...capture,...mutation}));
});
test("saved capture review plays only manifest-member artifacts and pairs action shots", () => {
  const hash = "a".repeat(64), before = "b".repeat(64), after = "c".repeat(64);
  const html = renderToStaticMarkup(React.createElement(CaptureReview, { captureId: id, value: {
    manifest: { videoHash: hash, events: [{ sequence: 0, offsetMs: 1000, operation: "input.click", beforeHash: before, afterHash: after }] },
    artifacts: [{hash}, {hash:before}, {hash:after}], narrationStatus: "complete",
  }}));
  assert.match(html, /<video/); assert.match(html, /controls=""/); assert.match(html, /Before screenshot/); assert.match(html, /After screenshot/);
  const denied = renderToStaticMarkup(React.createElement(CaptureReview, { captureId:id, value: { manifest:{ videoHash:hash }, artifacts:[] } }));
  assert.doesNotMatch(denied, /<video/); assert.match(denied, /No playable video/);
});
test("transcript review renders escaped timed narration and working/done states do not offer retry", () => {
  const hash = "a".repeat(64);
  const html = renderToStaticMarkup(React.createElement(CaptureReview, { captureId: id, value: {
    manifest: { audio: [{ hash, offsetMs: 1200 }] }, artifacts: [{ hash }], narrationStatus: "complete",
    narrationSegments: [{ turns: [{ startMs: 1200, endMs: 1800, text: "<script>untrusted narration</script>" }] }],
  }}));
  assert.match(html, /Narration transcribed/); assert.match(html, /Untrusted narration transcript/);
  assert.match(html, /1\.2s/); assert.match(html, /&lt;script&gt;untrusted narration/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<audio/);
  for (const narrationStatus of ["working", "complete", "uncertain"]) {
    const controls = render({ capture: { ...capture, state: "complete", narration: true, narrationStatus } });
    assert.doesNotMatch(controls, />Retry transcription</);
  }
  assert.match(render({capture:{...capture,state:"complete",narration:true,narrationStatus:"error"}}), />Retry transcription</);
});
