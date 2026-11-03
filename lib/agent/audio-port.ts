import "server-only";

import type { getDatabase } from "../../db/client";
import { transcribeAgentAudio } from "../audio/service";
import { AudioError } from "../audio/transcribe";
import type { RunCostSink } from "../costs/types";
import type { DesktopPort } from "./desktop-port";

export type HearingResult = {
  text: string; noSpeech: boolean; durationMs: number; model: string; sha256: string; bytes: number;
};
export interface AudioPort {
  // Listens to this agent's private speaker for 1-30 seconds and returns bounded, untrusted text.
  hear(seconds: number, key?: string): Promise<HearingResult>;
}

// TASK-079. Capture through the guarded desktop controller, then transcribe through the fixed ASR proxy.
// Raw audio lives only in this call; the model and the database see metadata and text.
export function createAudioPort(options: {
  database: Awaited<ReturnType<typeof getDatabase>>;
  ownerId: string; agentId: string;
  desktop: DesktopPort; costs?: RunCostSink;
}): AudioPort {
  const { database, ownerId, agentId, desktop, costs } = options;
  return {
    async hear(seconds, key) {
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new AudioError("invalid_audio");
      if (!costs) throw new AudioError("cost_unavailable");
      if (!desktop.captureAudio) throw new AudioError("audio_unavailable");
      await desktop.ensureBrowser?.();
      const capture = await desktop.captureAudio(seconds);
      return transcribeAgentAudio({ database, ownerId, agentId, costs, key,
        wav: Buffer.from(capture.base64, "base64") });
    },
  };
}
