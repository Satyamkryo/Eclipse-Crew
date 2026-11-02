import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../db/client";
import { agents } from "../../db/schema";
import { requireEgressProxySecret } from "../config/server";
import { EGRESS_PROXY_URL } from "../providers/proxy-transport";
import { syncAllAgents } from "../egress/sync";
import { createTripwirePorts, triggerTripwire } from "./tripwire";

// TASK-045. The proxy's policy entries expire after 120 s, so the app refreshes them every minute.
// TASK-047. The proxy's event ring is polled every 3 s; the proxy never calls the app.
// One loop per process; unref'd so they never keep the server alive.

const REFRESH_MS = 60_000;
const POLL_MS = 3_000;

interface LoopState {
  policyTimer?: ReturnType<typeof setInterval>;
  eventTimer?: ReturnType<typeof setInterval>;
  cursor: { boot: string | null; seq: number };
}
type GlobalWithLoops = typeof globalThis & { __eclipseSecurityLoops?: LoopState };

const eventResponse = z.object({
  boot: z.string().uuid(),
  events: z.array(z.object({
    seq: z.number().int().positive(),
    agentId: z.string().uuid(),
    source: z.enum(["proxy_host", "proxy_request"]),
    at: z.string().max(64),
  }).strict()).max(200),
}).strict();

export function ensureSecurityLoops(): void {
  const holder = globalThis as GlobalWithLoops;
  if (holder.__eclipseSecurityLoops) return;
  const state: LoopState = { cursor: { boot: null, seq: 0 } };
  holder.__eclipseSecurityLoops = state;

  let syncing = false;
  const sync = () => {
    if (syncing) return;
    syncing = true;
    void getDatabase().then((database) => syncAllAgents(database)).catch(() => {}).finally(() => { syncing = false; });
  };

  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const secret = requireEgressProxySecret(process.env.EGRESS_PROXY_SECRET);
      const after = state.cursor.boot ? state.cursor.seq : 0;
      const response = await fetch(`${EGRESS_PROXY_URL}/v1/events?after=${after}`, {
        method: "GET", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(5_000),
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!response.ok) return;
      const body = eventResponse.parse(await response.json());
      if (body.boot !== state.cursor.boot) { state.cursor.boot = body.boot; state.cursor.seq = 0; }
      if (!body.events.length) return;
      const database = await getDatabase();
      const trips = createTripwirePorts(database);
      for (const event of body.events) {
        if (event.seq <= state.cursor.seq) continue;
        const owner = await database.select({ ownerId: agents.ownerId }).from(agents)
          .where(eq(agents.id, event.agentId)).limit(1);
        if (owner[0]) {
          await triggerTripwire(trips, {
            ownerId: owner[0].ownerId, agentId: event.agentId, source: event.source, sourceRef: `${body.boot}:${event.seq}`,
          });
        }
        state.cursor.seq = event.seq;
      }
    } catch {
      // A later poll retries. The proxy already refuses the tripped agent even if the app is down.
    } finally {
      polling = false;
    }
  };

  state.policyTimer = setInterval(sync, REFRESH_MS);
  state.policyTimer.unref();
  state.eventTimer = setInterval(() => { void poll(); }, POLL_MS);
  state.eventTimer.unref();
  sync();
  void poll();
}
