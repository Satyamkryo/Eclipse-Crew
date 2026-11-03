import "server-only";

import type { PgBoss } from "pg-boss";
import { z } from "zod";

import type { getDatabase } from "../../db/client";
import { getRoutineQueue } from "../routines/queue";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// TASK-088. Two jobs on the shared pg-boss instance: poll a pending device code at GitHub's interval, and
// refresh a GitHub App token 30 minutes before it expires.
export const DEVICE_POLL_QUEUE = "github.device.poll";
export const GITHUB_REFRESH_QUEUE = "github.refresh";

export const devicePollJobSchema = z.object({ flowId: z.string().uuid() }).strict();
export const githubRefreshJobSchema = z.object({ ownerId: z.string().uuid(), connectionId: z.string().uuid() }).strict();

let ready: Promise<PgBoss> | undefined;
export async function getGithubDeviceQueue(): Promise<PgBoss> {
  ready ??= (async () => {
    const boss = await getRoutineQueue();
    await boss.createQueue(DEVICE_POLL_QUEUE, { policy: "standard", deleteAfterSeconds: 3_600 });
    await boss.createQueue(GITHUB_REFRESH_QUEUE, { policy: "standard", deleteAfterSeconds: 86_400 });
    return boss;
  })().catch((error) => { ready = undefined; throw error; });
  return ready;
}

export async function enqueueDevicePoll(flowId: string, delaySeconds: number): Promise<boolean> {
  const job = devicePollJobSchema.parse({ flowId });
  const boss = await getGithubDeviceQueue();
  const id = await boss.send(DEVICE_POLL_QUEUE, job, {
    startAfter: Math.max(1, Math.floor(delaySeconds)),
    retryLimit: 0, expireInSeconds: 60,
  });
  return id !== null;
}

export async function enqueueConnectionRefresh(ownerId: string, connectionId: string, delaySeconds: number): Promise<boolean> {
  const job = githubRefreshJobSchema.parse({ ownerId, connectionId });
  const boss = await getGithubDeviceQueue();
  const id = await boss.send(GITHUB_REFRESH_QUEUE, job, {
    singletonKey: connectionId, startAfter: Math.max(1, Math.floor(delaySeconds)),
    retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 120,
  });
  return id !== null;
}

// Registered once by startRoutineScheduler. A failed poll or refresh schedules another attempt; it never throws
// into the shared worker.
export async function startGithubDeviceWorkers(boss: PgBoss, database: Database): Promise<void> {
  // Create both queues before registering their workers; pg-boss refuses a worker for a queue that does not exist yet.
  await boss.createQueue(DEVICE_POLL_QUEUE, { policy: "standard", deleteAfterSeconds: 3_600 });
  await boss.createQueue(GITHUB_REFRESH_QUEUE, { policy: "standard", deleteAfterSeconds: 86_400 });
  await boss.work(DEVICE_POLL_QUEUE, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    const parsed = devicePollJobSchema.safeParse(job.data);
    if (!parsed.success) return;
    try {
      const { pollGithubDevice } = await import("./github-device");
      const result = await pollGithubDevice(database, parsed.data.flowId);
      if (result.delay) await enqueueDevicePoll(parsed.data.flowId, result.delay);
    } catch {
      await enqueueDevicePoll(parsed.data.flowId, 10).catch(() => false);
    }
  });
  // The scheduler tick refreshes tokens 30 minutes before expiry. Keeping the next refresh out of the active
  // refresh job avoids a singleton-key collision with the job that is still running.
  await boss.work(GITHUB_REFRESH_QUEUE, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    const parsed = githubRefreshJobSchema.safeParse(job.data);
    if (!parsed.success) return;
    const { refreshGithubConnection } = await import("./github-device");
    await refreshGithubConnection(database, parsed.data.ownerId, parsed.data.connectionId).catch(() => undefined);
  });
}
