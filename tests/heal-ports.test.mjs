import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("repair preparation forwards heal metadata and preserves owner and agent", async () => {
  const source = await readFile(new URL("../lib/heal/ports.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = [];
  const database = {};
  const stubs = {
    "server-only": {},
    "../agent/chat-run": { createChatRunPorts: (db) => {
      assert.equal(db, database);
      return { prepare: async (...args) => { calls.push(args); return { ok: false, reason: "unavailable" }; } };
    } },
    "../agent/step-loop": { runTask: () => {} },
    "../chat/data": { appendAgentCard: () => {}, appendOutboxFiles: () => {} },
    "../receipts/store": { loadRunExport: () => {} },
    "./heal": { maybeHeal: () => {} },
  };
  const entry = new vm.SourceTextModule(compiled);
  await entry.link((specifier) => {
    assert.ok(Object.hasOwn(stubs, specifier), `unexpected import ${specifier}`);
    const exports = stubs[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    });
  });
  await entry.evaluate();
  const ports = entry.namespace.createHealPorts(database);
  assert.deepEqual(await ports.prepare("owner", "agent"), { ok: false, reason: "unavailable" });
  assert.deepEqual(calls, [["owner", "agent", { meta: { trigger: "heal", label: "Self-heal repair" } }]]);
});
