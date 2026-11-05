import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { modelErrorResponse } from "@/lib/models/http";
import { checkModelTestRateLimit } from "@/lib/models/rate-limit";
import { localProbeSchema } from "@/lib/models/schema";
import { probeLocalServer } from "@/lib/models/testing";
import { createLocalProxyTransport } from "@/lib/providers/proxy-transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Settings → Models: "Check server" lists an unsaved local server's models; "Detect" tries the known same-computer
// addresses (Ollama, LM Studio, llama.cpp, vLLM, SGLang). Owner-only, CSRF-checked, shares the Test rate limit, and
// every request goes through the egress proxy's private-network route. A pasted key is used once and never stored.
export async function POST(request: Request) {
  try {
    await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const rate = checkModelTestRateLimit();
    if (!rate.allowed) {
      return Response.json({ error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });
    }
    const parsed = localProbeSchema.safeParse(await readBoundedJson(request, 20 * 1024));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    return Response.json(await probeLocalServer(parsed.data, (credential) => {
      try { return createLocalProxyTransport({ credential }); } catch { return null; }
    }));
  } catch (error) {
    return modelErrorResponse(error);
  }
}
