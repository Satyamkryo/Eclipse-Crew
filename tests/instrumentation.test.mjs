import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../instrumentation.ts", import.meta.url), "utf8");

async function setup({ runtime = "nodejs", phase = "", start = async () => {}, importFailure = false } = {}) {
  const logs = [];
  const context = vm.createContext({ process: { env: { NEXT_RUNTIME: runtime, NEXT_PHASE: phase } }, console: { error: (...args) => logs.push(args) } });
  let imports = 0;
  const entry = new vm.SourceTextModule(source, {
    context,
    importModuleDynamically: async () => {
      imports++;
      if (importFailure) throw new Error("sensitive connection detail");
      const scheduler = new vm.SyntheticModule(["startRoutineScheduler"], function () {
        this.setExport("startRoutineScheduler", start);
      }, { context });
      await scheduler.link(() => {});
      await scheduler.evaluate();
      return scheduler;
    },
  });
  await entry.link(() => {});
  await entry.evaluate();
  return { register: entry.namespace.register, logs, imports: () => imports };
}

test("registration continues and logs a safe warning when scheduler startup fails", async () => {
  for (const options of [{ start: async () => { throw new Error("secret"); } }, { importFailure: true }]) {
    const fixture = await setup(options);
    await assert.doesNotReject(fixture.register());
    assert.deepEqual(fixture.logs, [["Routine scheduler failed to start; scheduled routines are paused."]]);
  }
});

test("registration starts the scheduler only in the Node runtime outside production build", async () => {
  let starts = 0;
  const active = await setup({ start: async () => { starts++; } });
  await active.register();
  assert.equal(starts, 1);
  assert.deepEqual(active.logs, []);
  for (const options of [{ runtime: "edge" }, { phase: "phase-production-build" }]) {
    const skipped = await setup(options);
    await skipped.register();
    assert.equal(skipped.imports(), 0);
  }
});
