import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { timezonePromptKey } from "../components/workspace/timezone-notice.tsx";


test("the timezone prompt shows only for a real difference the owner has not kept", () => {
  // Same zone, or the browser reports nothing: no prompt.
  assert.equal(timezonePromptKey("Asia/Kolkata", "Asia/Kolkata", null, null), null);
  assert.equal(timezonePromptKey("Asia/Kolkata", "", null, null), null);
  // Different zone: prompt, keyed by the exact saved/detected pair.
  assert.equal(timezonePromptKey("UTC", "Asia/Kolkata", null, null), "UTC|Asia/Kolkata");
  assert.equal(timezonePromptKey("Asia/Kolkata", "America/New_York", null, null), "Asia/Kolkata|America/New_York");
  // "Keep" on this device, or dismissed in this visit, hides that pair only.
  assert.equal(timezonePromptKey("Asia/Kolkata", "Asia/Dubai", "Asia/Kolkata|Asia/Dubai", null), null);
  assert.equal(timezonePromptKey("Asia/Kolkata", "Asia/Dubai", null, "Asia/Kolkata|Asia/Dubai"), null);
  // A new trip (different detected zone) or a changed saved zone asks again.
  assert.equal(timezonePromptKey("Asia/Kolkata", "Europe/London", "Asia/Kolkata|Asia/Dubai", null), "Asia/Kolkata|Europe/London");
  assert.equal(timezonePromptKey("Asia/Dubai", "Asia/Kolkata", "Asia/Kolkata|Asia/Dubai", null), "Asia/Dubai|Asia/Kolkata");
});

test("the prompt never changes the zone by itself and is in every page's shell", () => {
  const notice = readFileSync("components/workspace/timezone-notice.tsx", "utf8");
  // The only write is the owner's click, through the CSRF-protected account route.
  assert.equal(notice.match(/fetch\(/g)?.length, 1);
  assert.match(notice, /fetch\("\/api\/auth\/account\/timezone"/);
  assert.match(notice, /"x-csrf-token": csrfToken/);
  assert.match(notice, /onClick=\{\(\) => void applyDetected\(\)\}/);
  assert.doesNotMatch(notice, /useEffect\([^)]*applyDetected/);
  // Browser storage is optional: every access is guarded.
  assert.equal(notice.match(/localStorage/g)?.length, 2);
  assert.equal(notice.match(/try \{ (return )?window\.localStorage/g)?.length, 2);
  const shell = readFileSync("components/workspace/app-shell.tsx", "utf8");
  assert.equal(shell.match(/\{timezoneNotice\}/g)?.length, 3, "phone, tablet and desktop layouts");
  assert.match(shell, /owner && csrfToken \? <TimezoneNotice savedZone=\{owner\.timezone\}/);
});
