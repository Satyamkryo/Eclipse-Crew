import { randomUUID } from "node:crypto";

// TASK-047. Fixed-size event ring for the app poller. Events carry no host, path or canary text.
export const MAX_EVENTS = 200;

export function createEventLog({ max = MAX_EVENTS, now = () => new Date() } = {}) {
  const boot = randomUUID();
  let seq = 0;
  const events = [];
  return {
    boot,
    push({ agentId, source }) {
      seq += 1;
      const event = { seq, agentId, source, at: now().toISOString() };
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
