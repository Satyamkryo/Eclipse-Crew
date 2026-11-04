import assert from "node:assert/strict";
import test from "node:test";

const unwrap = (module) => module.default ?? module;

test("the timezone route needs the owner session and only real IANA zones are accepted", async () => {
  const route = unwrap(await import("../app/api/auth/account/timezone/route.ts"));
  const response = await route.POST(new Request("http://127.0.0.1:3000/api/auth/account/timezone", {
    method: "POST", headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
    body: JSON.stringify({ timezone: "Asia/Kolkata" }),
  }));
  assert.equal(response.status, 401);
  const { resolveTimezone } = unwrap(await import("../lib/time/clock.ts"));
  for (const zone of ["Asia/Kolkata", "America/New_York", "Europe/London", "UTC"]) assert.equal(resolveTimezone(zone), zone);
  for (const bad of ["Mars/Base", "", "../etc", "x".repeat(65), 42]) assert.equal(resolveTimezone(bad), null, String(bad));
});
