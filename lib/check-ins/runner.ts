import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agents, checkIns, owner, runs } from "../../db/schema";
import { shellResultSchema } from "../agent/shell-port";
import { appendAgentCard } from "../chat/data";
import {
  browserSnapshotText, changedLines, isInWindow, kindLabel, looksLikeLogin, parseProbeOutput, planNextCheck, probeCommand, wakeTask,
  type CheckInKind, type CheckInStatus, type CheckInVia,
} from "./logic";
import type { CheckInRow } from "./store";

type Database = Awaited<ReturnType<typeof getDatabase>>;
const MAX_DUE_PER_TICK = 12;
const PROBE_CONCURRENCY = 3;
// A claimed check-in is pushed forward first, so a crash mid-probe never makes the next tick probe it twice at once.
const CLAIM_LEASE_MS = 10 * 60_000;

export class ProbeError extends Error {
  constructor(public code: "unreachable" | "busy" | "unavailable" | "login") { super(code); }
}

export interface CheckInDeps {
  probe(agentId: string, ownerId: string, url: string, via: CheckInVia): Promise<{ fingerprint: string; snapshot: string }>;
  post(ownerId: string, agentId: string, text: string): Promise<void>;
  wake(ownerId: string, agentId: string, task: string, label: string): void;
  random?: () => number;
}

const failureCode = (error: unknown) => (error as { code?: string })?.code ?? (error instanceof Error ? error.message : "");

// Fetch mode: the command runs as the agent in its own sandbox (no graphics). curl leaves through the agent's egress
// relay, so the agent's website allowlist, the private-address block and the tripwire apply. No model is called.
export async function sandboxProbe(agentId: string, ownerId: string, url: string) {
  const { createAgentLifecycle } = await import("../agent/runtime");
  const { desktopCommand } = await import("../desktop/client");
  let generation: string | undefined;
  try {
    generation = (await createAgentLifecycle(agentId, ownerId).ensureSandbox()).generation ?? undefined;
  } catch { throw new ProbeError("unavailable"); }
  if (!generation) throw new ProbeError("unavailable");
  let raw: unknown;
  try {
    raw = await desktopCommand(agentId, ownerId, generation, "shell.run", { command: probeCommand(url), timeout: 30 });
  } catch (error) {
    throw new ProbeError(["shell_busy", "takeover_active"].includes(failureCode(error)) ? "busy" : "unavailable");
  }
  const result = shellResultSchema.safeParse(raw);
  if (!result.success || result.data.exit !== 0 || result.data.timedOut) throw new ProbeError("unreachable");
  const parsed = parseProbeOutput(result.data.stdout);
  if (parsed.kind === "login") throw new ProbeError("login");
  if (parsed.kind !== "ok") throw new ProbeError("unreachable");
  return { fingerprint: parsed.fingerprint, snapshot: parsed.snapshot };
}

// Browser mode: the agent's own Chromium opens the page, so cookies from a login the owner completed during takeover
// are used. It never runs while the agent is working or the owner has taken over, never types, and never sees a
// password field (the snapshot omits them). The same egress allowlist applies to the browser.
export async function browserProbe(database: Database, agentId: string, ownerId: string, url: string) {
  const { isAgentBusy } = await import("../agent/step-loop");
  if (isAgentBusy(agentId)) throw new ProbeError("busy");
  const [live] = await database.select({ id: runs.id }).from(runs).where(and(
    eq(runs.ownerId, ownerId), eq(runs.agentId, agentId), isNull(runs.signature), gt(runs.heartbeatAt, new Date(Date.now() - 90_000)),
  )).limit(1);
  if (live) throw new ProbeError("busy");
  const { createAgentLifecycle } = await import("../agent/runtime");
  const { desktopCommand, pageSnapshotResult } = await import("../desktop/client");
  let generation: string | undefined;
  try {
    generation = (await createAgentLifecycle(agentId, ownerId).ensureBrowser()).generation ?? undefined;
  } catch { throw new ProbeError("unavailable"); }
  if (!generation) throw new ProbeError("unavailable");
  let page;
  try {
    await desktopCommand(agentId, ownerId, generation, "browser.navigate", { url });
    page = pageSnapshotResult.parse(await desktopCommand(agentId, ownerId, generation, "page.snapshot", {}));
  } catch (error) {
    const code = failureCode(error);
    throw new ProbeError(["takeover_active", "agent_busy", "capture_blocked_during_takeover"].includes(code) ? "busy" : "unreachable");
  }
  if (looksLikeLogin(url, page)) throw new ProbeError("login");
  const snapshot = browserSnapshotText(page);
  return { fingerprint: createHash("sha256").update(snapshot).digest("hex"), snapshot };
}

export function productionDeps(database: Database): CheckInDeps {
  return {
    probe: (agentId, ownerId, url, via) => via === "browser" ? browserProbe(database, agentId, ownerId, url) : sandboxProbe(agentId, ownerId, url),
    async post(ownerId, agentId, text) {
      await appendAgentCard(database, ownerId, agentId, { card: { type: "message", text }, sourceTag: "system" });
    },
    wake(ownerId, agentId, task, label) {
      void import("../agent/chat-run").then(({ startChatRun }) => {
        startChatRun(database, ownerId, agentId, task, { trigger: "schedule", label });
      }).catch(() => undefined);
    },
  };
}

function timeIn(at: Date, timeZone: string): string {
  try { return at.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }); } catch { return at.toISOString().slice(11, 16) + " UTC"; }
}

export type CheckInOutcome = { status: CheckInStatus; nextCheckAt: Date; alerted: boolean; woke: boolean };

// One check: guard → cheap probe → compare fingerprint → (changed) alert and/or wake → schedule the next check.
export async function processCheckIn(database: Database, row: CheckInRow, deps: CheckInDeps, now = new Date(), options: { force?: boolean } = {}): Promise<CheckInOutcome> {
  const kind = row.kind as CheckInKind;
  const label = `${kindLabel(kind)} · ${row.name}`;
  const plan = (quietStreak: number) => planNextCheck({
    now, timeZone: row.timezone, windowStart: row.windowStart, windowEnd: row.windowEnd,
    intervalMinutes: row.intervalMinutes, quietStreak, random: deps.random?.(),
  });
  const save = async (values: Partial<typeof checkIns.$inferInsert>) => {
    await database.update(checkIns).set({ ...values, updatedAt: now })
      .where(and(eq(checkIns.ownerId, row.ownerId), eq(checkIns.id, row.id)));
  };

  const [agent] = await database.select({ status: agents.status, attention: agents.attentionReason, crew: owner.crewStoppedAt })
    .from(agents).innerJoin(owner, eq(owner.id, agents.ownerId))
    .where(and(eq(agents.ownerId, row.ownerId), eq(agents.id, row.agentId))).limit(1);
  // A paused agent, stopped crew or security stop is never probed, and outside its hours a check-in sleeps (Check now
  // overrides only the hours).
  if (!agent || agent.status !== "active" || agent.crew || agent.attention === "security_stop" || (!options.force && !isInWindow(now, row.timezone, row.windowStart, row.windowEnd))) {
    const nextCheckAt = plan(row.quietStreak);
    await save({ lastStatus: "skipped", nextCheckAt });
    return { status: "skipped", nextCheckAt, alerted: false, woke: false };
  }

  let probe: { fingerprint: string; snapshot: string };
  try {
    probe = await deps.probe(row.agentId, row.ownerId, row.url, row.via as CheckInVia);
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : "unavailable";
    if (code === "login") {
      // A login wall: the owner signs in during takeover (the agent never types credentials), and from then on the
      // check reads the page through the agent's own browser, which keeps that login. The baseline restarts there.
      const nextCheckAt = plan(row.quietStreak);
      const alerted = row.lastStatus !== "needs_login";
      if (alerted) {
        await deps.post(row.ownerId, row.agentId, `${label}: ${row.url} needs you to sign in. Open this agent's Desktop, press Take over, sign in to the site, then press Hand back and Check now in the Routines tab. From now on this check uses the agent's browser, which keeps your login. The agent never types your password.`).catch(() => undefined);
      }
      await save({ lastStatus: "needs_login", lastCheckedAt: now, nextCheckAt,
        ...(row.via === "fetch" ? { via: "browser", fingerprint: null, snapshot: null, quietStreak: 0 } : {}) });
      return { status: "needs_login", nextCheckAt, alerted, woke: false };
    }
    const status: CheckInStatus = code === "busy" ? "skipped" : "failed";
    const nextCheckAt = plan(row.quietStreak);
    // Say it once per outage, not on every retry.
    let alerted = false;
    if (status === "failed" && row.lastStatus !== "failed") {
      await deps.post(row.ownerId, row.agentId, code === "unreachable"
        ? `${label}: couldn't read ${row.url}. Check that the site is in this agent's website list and loads without a login. I'll keep trying.`
        : `${label}: the agent's sandbox wasn't available for the check. I'll try again at the next interval.`).catch(() => undefined);
      alerted = true;
    }
    await save({ lastStatus: status, lastCheckedAt: now, nextCheckAt });
    return { status, nextCheckAt, alerted, woke: false };
  }

  if (!row.fingerprint) {
    const nextCheckAt = plan(0);
    await save({ fingerprint: probe.fingerprint, snapshot: probe.snapshot, quietStreak: 0, lastStatus: "first", lastCheckedAt: now, nextCheckAt });
    return { status: "first", nextCheckAt, alerted: false, woke: false };
  }
  if (row.fingerprint === probe.fingerprint) {
    const quietStreak = row.quietStreak + 1;
    const nextCheckAt = plan(quietStreak);
    await save({ quietStreak, lastStatus: "unchanged", lastCheckedAt: now, nextCheckAt });
    return { status: "unchanged", nextCheckAt, alerted: false, woke: false };
  }

  const { added, removed } = changedLines(row.snapshot, probe.snapshot);
  const nextCheckAt = plan(0);
  const alertNow = kind === "sundance" || row.urgent;
  await save({
    fingerprint: probe.fingerprint, snapshot: probe.snapshot, quietStreak: 0, lastStatus: "changed",
    lastCheckedAt: now, lastChangedAt: now, nextCheckAt,
    ...(alertNow ? {} : { pendingChanges: row.pendingChanges + 1 }),
  });
  const when = timeIn(now, row.timezone);
  if (alertNow) {
    await deps.post(row.ownerId, row.agentId, row.goal
      ? `${label}: ${row.url} changed at ${when} (${added} lines added, ${removed} removed). Starting the task: ${row.goal}`
      : `${label}: ${row.url} changed at ${when} (${added} lines added, ${removed} removed).`).catch(() => undefined);
  }
  // The agent wakes only on a change, with the owner's goal as its task. Moondance does this quietly overnight.
  if (row.goal) deps.wake(row.ownerId, row.agentId, wakeTask({ name: row.name, url: row.url, goal: row.goal, added, removed }), label.slice(0, 120));
  return { status: "changed", nextCheckAt, alerted: alertNow, woke: Boolean(row.goal) };
}

// Moondance stays silent overnight; once its window closes, one morning card sums up what changed.
export async function deliverMorningReports(database: Database, ownerId: string, deps: CheckInDeps, now = new Date()): Promise<number> {
  const rows = await database.select().from(checkIns).where(and(
    eq(checkIns.ownerId, ownerId), eq(checkIns.kind, "moondance"), gt(checkIns.pendingChanges, 0),
  )).limit(50);
  let sent = 0;
  for (const row of rows) {
    if (isInWindow(now, row.timezone, row.windowStart, row.windowEnd)) continue;
    const [claimed] = await database.update(checkIns).set({ pendingChanges: 0, updatedAt: now }).where(and(
      eq(checkIns.ownerId, ownerId), eq(checkIns.id, row.id), eq(checkIns.pendingChanges, row.pendingChanges),
    )).returning({ id: checkIns.id });
    if (!claimed) continue;
    const times = row.pendingChanges === 1 ? "once" : `${row.pendingChanges} times`;
    const last = row.lastChangedAt ? `, last at ${timeIn(row.lastChangedAt, row.timezone)}` : "";
    await deps.post(ownerId, row.agentId, `Moondance · ${row.name}: overnight, ${row.url} changed ${times}${last}.${row.goal ? " The agent handled each change; see its replies above." : ""}`).catch(() => undefined);
    sent += 1;
  }
  return sent;
}

export async function tickCheckIns(database: Database, deps: CheckInDeps = productionDeps(database), now = new Date()): Promise<{ checked: number; reports: number }> {
  const owners = await database.select({ id: owner.id, crewStoppedAt: owner.crewStoppedAt }).from(owner);
  let checked = 0;
  let reports = 0;
  for (const current of owners) {
    // TASK-092. One owner never stops the others: a failing owner is skipped, the tick continues.
    try {
    if (current.crewStoppedAt) continue;
    reports += await deliverMorningReports(database, current.id, deps, now).catch(() => 0);
    const due = await database.select({ id: checkIns.id }).from(checkIns).where(and(
      eq(checkIns.ownerId, current.id), eq(checkIns.active, true), lte(checkIns.nextCheckAt, now),
    )).orderBy(asc(checkIns.nextCheckAt)).limit(MAX_DUE_PER_TICK);
    const claimed: CheckInRow[] = [];
    for (const candidate of due) {
      const row = await database.transaction(async (tx) => {
        const [locked] = await tx.select().from(checkIns).where(and(
          eq(checkIns.ownerId, current.id), eq(checkIns.id, candidate.id), eq(checkIns.active, true), lte(checkIns.nextCheckAt, now),
        )).limit(1).for("update", { skipLocked: true });
        if (!locked) return null;
        await tx.update(checkIns).set({ nextCheckAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
          .where(and(eq(checkIns.ownerId, current.id), eq(checkIns.id, locked.id)));
        return locked;
      }).catch(() => null);
      if (row) claimed.push(row);
    }
    for (let i = 0; i < claimed.length; i += PROBE_CONCURRENCY) {
      const batch = claimed.slice(i, i + PROBE_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((row) => processCheckIn(database, row, deps, now)));
      checked += results.filter((result) => result.status === "fulfilled").length;
    }
    } catch {
      console.error("Check-in tick skipped one owner.");
    }
  }
  return { checked, reports };
}

let tickRunning = false;
export function startCheckInTick(database: Database): void {
  if (tickRunning) return;
  tickRunning = true;
  void tickCheckIns(database)
    .catch(() => console.error("Check-in tick failed."))
    .finally(() => { tickRunning = false; });
}

// "Check now" from the panel: same path, outside the minute tick. The lease stops the tick picking it up meanwhile.
export async function checkNow(database: Database, row: CheckInRow, deps: CheckInDeps = productionDeps(database), now = new Date()): Promise<CheckInOutcome> {
  await database.update(checkIns).set({ nextCheckAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
    .where(and(eq(checkIns.ownerId, row.ownerId), eq(checkIns.id, row.id)));
  return processCheckIn(database, row, deps, now, { force: true });
}
