import assert from "node:assert/strict";
import { test } from "node:test";

const unwrap = (module) => module.default ?? module;

test("account mutation schemas accept only bounded known fields", async () => {
  const routes = await Promise.all([
    import("../app/api/auth/account/email/route.ts"),
    import("../app/api/auth/account/password/route.ts"),
    import("../app/api/auth/sessions/revoke-others/route.ts"),
  ]);
  const [email, password, sessions] = routes.map(unwrap);

  assert.equal(email.emailSchema.safeParse({ login: "new@example.test", currentPassword: "current" }).success, true);
  assert.equal(email.emailSchema.safeParse({ login: "new@example.test", currentPassword: "current", ownerId: "forged" }).success, false);
  assert.equal(email.emailSchema.safeParse({ login: "not-an-email", currentPassword: "current" }).success, false);
  assert.equal(email.emailSchema.safeParse({ login: "x".repeat(260) + "@example.test", currentPassword: "current" }).success, false);

  assert.equal(password.passwordSchema.safeParse({ currentPassword: "current", newPassword: "replacement" }).success, true);
  assert.equal(password.passwordSchema.safeParse({ currentPassword: "current", newPassword: "short" }).success, false);
  assert.equal(password.passwordSchema.safeParse({ currentPassword: "current", newPassword: "x".repeat(129) }).success, false);
  assert.equal(password.passwordSchema.safeParse({ currentPassword: "current", newPassword: "replacement", sessionRef: "forged" }).success, false);

  assert.equal(sessions.emptySchema.safeParse({}).success, true);
  assert.equal(sessions.emptySchema.safeParse({ ownerId: "forged" }).success, false);
});
