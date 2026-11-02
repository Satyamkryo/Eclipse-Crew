import { randomUUID } from "node:crypto";

// TASK-047. Fixed-size event ring for the app poller. Events carry no path or canary text.
// TASK-052. `kind` separates a canary trip from an allowlist refusal; a refused host is the only extra field.
export const MAX_EVENTS = 200;
const HOST = /^[a-z0-9.:[\]-]{1,253}$/;

export function createEventLog({ max = MAX_EVENTS, now = () => new Date() } = {}) {
  const boot = randomUUID();
  let seq = 0;
  const events = [];
  return {
    boot,
    push({ agentId, source, kind = "tripwire", host = null }) {
      seq += 1;
      const event = {
        seq, agentId, source, kind,
        ...(kind === "egress_blocked" && typeof host === "string" && HOST.test(host) ? { host } : {}),
        at: now().toISOString(),
      };
      events.push(event);
      if (events.length > max) events.shift();
      return event;
    },
    after(value) {
      const after = Number.isSafeInteger(value) && value >= 0 ? value : 0;
      return events.filter((event) => event.seq > after);
    },
    all() { return [...events]; },
  };
}
