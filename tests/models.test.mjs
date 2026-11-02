import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { checkModelTestRateLimit, resetModelTestRateLimit } from "../lib/models/rate-limit.ts";
import {
  mainModelSettingsSchema,
  samModelSettingsSchema,
  testModelSchema,
} from "../lib/models/schema.ts";
import {
  readModelSettings,
  saveMainSettings,
  saveSamSettings,
} from "../lib/models/service.ts";
import { testSavedRole } from "../lib/models/testing.ts";

const KEY = "0123456789abcdef".repeat(4);
const CANARY = "sk-live-CANARY-provider-secret-1234";
const originalEncryptionKey = process.env.ENCRYPTION_KEY;

async function withEncryptionKey(operation) {
  process.env.ENCRYPTION_KEY = KEY;
  try {
    return await operation();
  } finally {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  }
}

function provider(overrides = {}) {
  return {
    id: randomUUID(),
    kind: "meta",
    baseUrl: null,
    encryptedKey: null,
    keyHint: null,
    ...overrides,
  };
}

function role(roleName, providerRecord, overrides = {}) {
  return {
    role: roleName,
    providerId: providerRecord?.id ?? null,
    provider: providerRecord,
    model: roleName === "main" ? "muse-spark-1.3" : "sam-3.1",
    useMainKey: false,
    mode: roleName === "main" ? "active" : "meta",
    routing: "fixed",
    hardModel: null,
    ...overrides,
  };
}

class MemoryStore {
  constructor(main = null, sam = null) {
    this.main = main;
    this.sam = sam;
  }

  async load() {
    return structuredClone({ main: this.main, sam: this.sam });
  }

  async saveMain(ownerId, input) {
    assert.equal(ownerId, "owner");
    const previous = this.main?.provider;
    const stored = provider({
      id: previous?.id ?? randomUUID(),
      kind: input.kind,
      baseUrl: input.baseUrl,
      encryptedKey: input.clearKey ? null : input.encryptedKey ?? previous?.encryptedKey ?? null,
      keyHint: input.clearKey ? null : input.keyHint ?? previous?.keyHint ?? null,
    });
    this.main = role("main", stored, { model: input.model, routing: input.routing, hardModel: input.hardModel });
    if (this.sam?.useMainKey) {
      this.sam.providerId = stored.id;
      this.sam.provider = stored;
    }
  }

  async saveSam(ownerId, input) {
    assert.equal(ownerId, "owner");
    if (input.mode === "off") {
      this.sam = null;
      return;
    }
    if (input.useMainKey) {
      assert.ok(this.main?.provider);
      this.sam = role("sam", this.main.provider, { useMainKey: true });
      return;
    }
    const previous = this.sam && !this.sam.useMainKey ? this.sam.provider : undefined;
    const stored = provider({
      id: previous?.id ?? randomUUID(),
      kind: "meta",
      encryptedKey: input.encryptedKey ?? previous?.encryptedKey ?? null,
      keyHint: input.keyHint ?? previous?.keyHint ?? null,
    });
    this.sam = role("sam", stored, { useMainKey: false });
  }
}

async function expectCode(code, operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.name, "ModelSettingsError");
    assert.equal(error.code, code);
    return true;
  });
}

test("empty model settings expose a safe required Main AI and SAM off", async () => {
  const settings = await readModelSettings(new MemoryStore(), "owner");
  assert.deepEqual(settings, {
    main: {
      configured: false,
      kind: "meta",
      baseUrl: null,
      model: "muse-spark-1.3",
      hasKey: false,
      keyHint: null,
      routing: "fixed",
      hardModel: null,
    },
    sam: {
      configured: false,
      mode: "off",
      useMainKey: false,
      hasKey: false,
      keyHint: null,
      canUseMainKey: false,
    },
  });
});

test("Main AI saves an encrypted key and returns only its last-four hint", async () => {
  await withEncryptionKey(async () => {
    const store = new MemoryStore();
    const settings = await saveMainSettings(store, "owner", {
      kind: "meta",
      model: "muse-spark-1.3",
      apiKey: CANARY,
    });
    assert.equal(settings.main.configured, true);
    assert.equal(settings.main.hasKey, true);
    assert.equal(settings.main.keyHint, "••••1234");
    assert.match(store.main.provider.encryptedKey, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.notEqual(store.main.provider.encryptedKey, CANARY);
    const serialized = JSON.stringify(settings);
    assert.ok(!serialized.includes(CANARY));
    assert.ok(!serialized.includes(store.main.provider.encryptedKey));
  });
});

test("short keys are fully masked instead of exposed by the hint", async () => {
  await withEncryptionKey(async () => {
    const store = new MemoryStore();
    const settings = await saveMainSettings(store, "owner", {
      kind: "meta", model: "muse-spark-1.3", apiKey: "abc",
    });
    assert.equal(settings.main.keyHint, "••••");
    assert.ok(!JSON.stringify(settings).includes("abc"));
  });
});

test("Main AI requires a key and validates compatible base URLs", async () => {
  const store = new MemoryStore();
  await withEncryptionKey(async () => {
    await expectCode("key_required", () => saveMainSettings(store, "owner", {
      kind: "meta", model: "muse-spark-1.3",
    }));

    await expectCode("invalid_input", () => saveMainSettings(store, "owner", {
      kind: "openai-compatible", model: "muse-glimmer", baseUrl: "https://user:CANARY@example.test/v1",
    }));

    const settings = await saveMainSettings(store, "owner", {
      kind: "openai-compatible",
      model: "muse-glimmer",
      baseUrl: "http://host.docker.internal:11434/v1/",
    });
    assert.equal(settings.main.baseUrl, "http://host.docker.internal:11434/v1");
    assert.equal(settings.main.hasKey, false);
  });
});

test("changing to Meta requires a Meta key instead of reusing another provider's key", async () => {
  await withEncryptionKey(async () => {
    const store = new MemoryStore();
    await saveMainSettings(store, "owner", {
      kind: "openai-compatible", model: "muse-glimmer", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "local-key",
    });
    await expectCode("key_required", () => saveMainSettings(store, "owner", {
      kind: "meta", model: "muse-spark-1.3",
    }));
  });
});

test("changing away from Meta clears the previous provider key", async () => {
  await withEncryptionKey(async () => {
    const store = new MemoryStore();
    await saveMainSettings(store, "owner", { kind: "meta", model: "muse-spark-1.3", apiKey: CANARY });
    const settings = await saveMainSettings(store, "owner", {
      kind: "openai-compatible", model: "muse-glimmer", baseUrl: "http://127.0.0.1:11434/v1",
    });
    assert.equal(settings.main.hasKey, false);
    assert.equal(settings.main.keyHint, null);
    assert.equal(store.main.provider.encryptedKey, null);
    assert.equal(store.main.provider.keyHint, null);
  });
});

test("the store rejects a Main provider change when SAM acquired same-key concurrently", async () => {
  const { createModelSettingsStore } = await import("../lib/models/data.ts").then((module) => module.default ?? module);
  const calls = { updates: 0, selects: 0 };
  const transaction = {
    async execute() { return { rows: [] }; },
    select() {
      const index = calls.selects++;
      const rows = index === 0
        ? [{ providerId: "main-provider" }]
        : index === 1
          ? [{ useMainKey: true }]
          : [{ kind: "meta" }];
      const builder = {
        from() { return builder; },
        where() { return builder; },
        async limit() { return rows; },
      };
      return builder;
    },
    update() {
      calls.updates++;
      const builder = {
        set() { return builder; },
        async where() { return []; },
      };
      return builder;
    },
    insert() {
      const builder = {
        values() { return builder; },
        async onConflictDoUpdate() { return []; },
      };
      return builder;
    },
    async delete() { return []; },
  };
  const database = { async transaction(operation) { return operation(transaction); } };
  const dataStore = createModelSettingsStore(database);
  const facade = {
    async load() {
      return {
        main: role("main", provider({ id: "main-provider", encryptedKey: "v1.key", keyHint: "••••1234" })),
        sam: null,
      };
    },
    saveMain: dataStore.saveMain,
    saveSam: dataStore.saveSam,
  };
  await expectCode("sam_depends_on_main_key", () => saveMainSettings(facade, "owner", {
    kind: "openai-compatible",
    model: "muse-glimmer",
    baseUrl: "http://127.0.0.1:11434/v1",
  }));
  assert.equal(calls.updates, 0);
});

test("SAM same-key reuses the Main provider without duplicating ciphertext", async () => {
  await withEncryptionKey(async () => {
    const store = new MemoryStore();
    await saveMainSettings(store, "owner", { kind: "meta", model: "muse-spark-1.3", apiKey: CANARY });
    const settings = await saveSamSettings(store, "owner", { mode: "meta", useMainKey: true });
    assert.equal(store.sam.useMainKey, true);
    assert.equal(store.sam.providerId, store.main.providerId);
    assert.equal(store.sam.provider.encryptedKey, store.main.provider.encryptedKey);
    assert.equal(settings.sam.canUseMainKey, true);
    assert.equal(settings.sam.hasKey, true);
    assert.equal(settings.sam.keyHint, "••••1234");
  });
});

test("SAM can use its own key or switch off", async () => {
  await withEncryptionKey(async () => {
    const store = new MemoryStore();
    await saveMainSettings(store, "owner", { kind: "meta", model: "muse-spark-1.3", apiKey: CANARY });
    await expectCode("key_required", () => saveSamSettings(store, "owner", { mode: "meta", useMainKey: false }));
    const separate = await saveSamSettings(store, "owner", {
      mode: "meta", useMainKey: false, apiKey: "sam-secret-9876",
    });
    assert.equal(store.sam.providerId === store.main.providerId, false);
    assert.equal(separate.sam.keyHint, "••••9876");
    const off = await saveSamSettings(store, "owner", { mode: "off", useMainKey: false });
    assert.equal(off.sam.mode, "off");
    assert.equal(store.sam, null);
  });
});

test("Main cannot change provider while SAM depends on its key", async () => {
  await withEncryptionKey(async () => {
    const store = new MemoryStore();
    await saveMainSettings(store, "owner", { kind: "meta", model: "muse-spark-1.3", apiKey: CANARY });
    await saveSamSettings(store, "owner", { mode: "meta", useMainKey: true });
    await expectCode("sam_depends_on_main_key", () => saveMainSettings(store, "owner", {
      kind: "openai-compatible", model: "muse-glimmer", baseUrl: "http://127.0.0.1:11434/v1",
    }));
    assert.equal(store.main.provider.kind, "meta");
  });
});

test("mocked Main AI Test lists bounded models and latency without credentials", async () => {
  await withEncryptionKey(async () => {
    const store = new MemoryStore();
    await saveMainSettings(store, "owner", { kind: "meta", model: "muse-spark-1.3", apiKey: CANARY });
    const calls = [];
    const transport = async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return Response.json({
        data: [
          { id: "muse-spark-1.3", context_length: 1_048_576 },
          { id: "muse-wonder-1.0" },
        ],
      });
    };
    const result = await testSavedRole(store, "owner", "main", transport);
    assert.deepEqual(result.models, [
      { id: "muse-spark-1.3", contextTokens: 1_048_576 },
      { id: "muse-wonder-1.0", contextTokens: null },
    ]);
    assert.equal(Number.isInteger(result.latencyMs) && result.latencyMs >= 0, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.meta.ai/v1/models");
    assert.equal(calls[0].headers.has("authorization"), false);
    assert.equal(calls[0].headers.has("proxy-authorization"), false);
    assert.ok(!JSON.stringify(result).includes(CANARY));
  });
});

test("Test fails closed without authenticated transport or a configured role", async () => {
  const store = new MemoryStore();
  await expectCode("authenticated_transport_unavailable", () => testSavedRole(store, "owner", "main"));
  await expectCode("role_not_configured", () => testSavedRole(store, "owner", "sam", async () => Response.json({ data: [] })));
});

test("provider Test failures are mapped to a safe error", async () => {
  await withEncryptionKey(async () => {
    const store = new MemoryStore();
    await saveMainSettings(store, "owner", { kind: "meta", model: "muse-spark-1.3", apiKey: CANARY });
    await expectCode("provider_test_failed", () => testSavedRole(
      store, "owner", "main", async () => Response.json({ unexpected: "CANARY" }),
    ));
  });
});

test("model Test has an independent bounded owner-wide rate limit", () => {
  resetModelTestRateLimit();
  const start = 1_000_000;
  for (let index = 0; index < 5; index++) assert.equal(checkModelTestRateLimit(start + index).allowed, true);
  const blocked = checkModelTestRateLimit(start + 5);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 60);
  assert.equal(checkModelTestRateLimit(start + 60_001).allowed, true);
  resetModelTestRateLimit();
});

test("model settings schemas reject unknown fields and invalid combinations", () => {
  assert.equal(mainModelSettingsSchema.safeParse({
    kind: "meta", model: "muse-spark-1.3", apiKey: CANARY, unknown: true,
  }).success, false);
  assert.equal(mainModelSettingsSchema.safeParse({
    kind: "openai-compatible", model: "muse-glimmer",
  }).success, false);
  assert.equal(samModelSettingsSchema.safeParse({
    mode: "off", useMainKey: true,
  }).success, false);
  assert.equal(samModelSettingsSchema.safeParse({
    mode: "meta", useMainKey: true, apiKey: CANARY,
  }).success, false);
  assert.equal(testModelSchema.safeParse({ role: "voice" }).success, false);
});

test("routing is Fixed by default; Auto needs a hard-step model and it round-trips without leaking the key", async () => {
  await withEncryptionKey(async () => {
    const store = new MemoryStore();
    const fixed = await saveMainSettings(store, "owner", { kind: "meta", model: "muse-spark-1.3-contributor", apiKey: CANARY });
    assert.deepEqual([fixed.main.routing, fixed.main.hardModel], ["fixed", null]);

    const auto = await saveMainSettings(store, "owner", { kind: "meta", model: "muse-spark-1.3-contributor", routing: "auto", hardModel: "muse-wonder-1.0" });
    assert.deepEqual([auto.main.routing, auto.main.hardModel, auto.main.hasKey], ["auto", "muse-wonder-1.0", true]);
    assert.ok(!JSON.stringify(auto).includes(CANARY));

    const back = await saveMainSettings(store, "owner", { kind: "meta", model: "muse-spark-1.3-contributor" });
    assert.deepEqual([back.main.routing, back.main.hardModel], ["fixed", null]);
  });
});

test("routing input is validated: auto needs hardModel, fixed rejects it, ids are safe, unknown fields fail", () => {
  const base = { kind: "meta", model: "muse-spark-1.3-contributor" };
  assert.equal(mainModelSettingsSchema.safeParse(base).data.routing, "fixed");
  assert.equal(mainModelSettingsSchema.safeParse({ ...base, routing: "auto", hardModel: "muse-wonder-1.0" }).success, true);
  for (const bad of [
    { routing: "auto" }, { routing: "fixed", hardModel: "muse-wonder-1.0" }, { routing: "sometimes" },
    { routing: "auto", hardModel: "bad model" }, { routing: "auto", hardModel: "" }, { routing: "auto", hardModel: "a".repeat(201) },
    { routing: "auto", hardModel: "x", extra: 1 },
  ]) assert.equal(mainModelSettingsSchema.safeParse({ ...base, ...bad }).success, false, JSON.stringify(bad));
});