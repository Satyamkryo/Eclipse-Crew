// Shared by the server (routing, pricing, validation) and the Models settings UI. No secrets, no I/O.
//
// A "local" model endpoint is one that lives on this computer, the owner's LAN or their Tailscale network:
// Ollama, LM Studio, llama.cpp, vLLM, SGLang or a self-hosted SAM server. Its requests go through the egress
// proxy's local route, which reaches private network addresses only (never the public internet, loopback,
// link-local/metadata or the proxy's own Docker networks). Everything else uses the public HTTPS route.

const LOCAL_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa", ".ts.net"];
const LOCAL_NAMES = new Set(["host.docker.internal", "gateway.docker.internal", "host.containers.internal"]);

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((part) => part <= 255) ? octets : null;
}

// `localhost` inside Docker is the container itself, not the owner's computer. The UI and the save path
// explain this instead of saving an address that can never work.
export function isLoopbackModelUrl(value: string | null | undefined): boolean {
  const host = hostOf(value);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0") return true;
  const octets = ipv4(host);
  return Boolean(octets && (octets[0] === 127 || octets[0] === 0));
}

export function isLocalModelUrl(value: string | null | undefined): boolean {
  const host = hostOf(value);
  if (!host) return false;
  if (isLoopbackModelUrl(value)) return true;
  if (LOCAL_NAMES.has(host) || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const octets = ipv4(host);
  if (octets) {
    const [a, b] = octets;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (host.includes(":")) return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  // A single-label name ("ollama", "my-gpu-box") is a Docker service or LAN hostname, never a public site.
  return !host.includes(".");
}

export type LocalServerPreset = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  hint: string;
};

// Same-computer addresses use host.docker.internal: Eclipse Crew runs inside Docker, so `localhost` would be the
// container. Model ids come from Meta's Muse Glimmer docs (dev.meta.ai/docs/muse-glimmer, read 2026-11-05).
export const LOCAL_SERVER_PRESETS: readonly LocalServerPreset[] = [
  { id: "ollama", label: "Ollama", baseUrl: "http://host.docker.internal:11434/v1", model: "muse-glimmer",
    hint: "Run `ollama run muse-glimmer` on this computer first." },
  { id: "lm-studio", label: "LM Studio", baseUrl: "http://host.docker.internal:1234/v1", model: "",
    hint: "Start the server in LM Studio (Developer → Start server), then pick the model it lists." },
  { id: "llama-cpp", label: "llama.cpp", baseUrl: "http://host.docker.internal:8080/v1", model: "muse-glimmer",
    hint: "Serve with `--host 0.0.0.0 -a muse-glimmer`. If you set --api-key, paste it below." },
  { id: "vllm", label: "vLLM", baseUrl: "http://host.docker.internal:8000/v1", model: "muse-glimmer",
    hint: "Serve with --served-model-name muse-glimmer --enable-auto-tool-choice --tool-call-parser muse_glimmer." },
  { id: "sglang", label: "SGLang", baseUrl: "http://host.docker.internal:30000/v1", model: "muse-glimmer",
    hint: "Serve with --served-model-name muse-glimmer --tool-call-parser muse --host 0.0.0.0." },
  { id: "custom", label: "Another computer (LAN or Tailscale)", baseUrl: "", model: "muse-glimmer",
    hint: "Enter its address, for example http://my-pc.your-tailnet.ts.net:11434/v1. Never expose the port to the internet." },
];

export const LOCAL_SAM_PLACEHOLDER = "http://host.docker.internal:8090/v1";
