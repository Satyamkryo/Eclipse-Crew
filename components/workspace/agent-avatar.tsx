"use client";

// Voxel bot avatars: 12 owner-supplied DiceBear Voxel Bot SVGs (CC0 1.0),
// served from /avatars/voxel — no network fetch. The stored avatarVariant
// selects the file; the id-hashed seed is only a fallback for rows that
// predate the avatar column. Creation forms assign a random variant that
// the owner can shuffle before saving.
// The SVGs self-animate (blink/lift) with their own prefers-reduced-motion guard.

const VOXEL_FILES = [
  "0a8d1d5ddd.svg",
  "118a3cbed1.svg",
  "22c8c6651f.svg",
  "325b233b71.svg",
  "45e78d3f51.svg",
  "6e49889fc3.svg",
  "8c3e62d36e.svg",
  "9bb50cc069.svg",
  "aa0cee2fb5.svg",
  "af2511e5c0.svg",
  "f3bb830e99.svg",
  "ff2b743967.svg",
] as const;

export const AVATAR_COUNT = VOXEL_FILES.length;

export function avatarVariant(seed: string): number {
  return hashSeed(seed || "?") % VOXEL_FILES.length;
}

// Crypto-random pick, optionally different from the current one so Shuffle
// always visibly changes the preview.
export function randomAvatarVariant(except?: number): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  let next = Number(values[0] % AVATAR_COUNT);
  while (except !== undefined && next === except && AVATAR_COUNT > 1) {
    crypto.getRandomValues(values);
    next = Number(values[0] % AVATAR_COUNT);
  }
  return next;
}

export function AgentAvatar({ seed, variant, size = 32, label }: {
  seed: string; variant?: number; size?: number; animated?: boolean; label?: string;
}) {
  const index = variant !== undefined && Number.isInteger(variant) && variant >= 0 && variant < AVATAR_COUNT
    ? variant
    : avatarVariant(seed);
  const file = VOXEL_FILES[index];
  // The voxel art has transparent margins; bleed it ~12% past the circle so
  // no gap shows at the top. The circle mask + border stay crisp.
  const bleed = Math.ceil(size * 1.14);
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: 9999,
        overflow: "hidden",
        flexShrink: 0,
        background: "#141414",
        border: "1px solid #242424",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- owner-only avatars; the files are hashed SVGs */}
      <img src={`/avatars/voxel/${file}`} alt="" width={bleed} height={bleed}
        draggable={false} style={{ display: "block", width: bleed, height: bleed, maxWidth: "none" }} />
    </span>
  );
}

const DARK = "#0A0A0A";

// Owner avatar in the DiceBear "Initials" style (CC0 1.0, owner-supplied reference): a flat colour fill with the owner's
// real initials in soft dark letters. The letters are computed here, never taken from the reference files. Colours are
// the owner-avatar palette in docs/DESIGN.md; local only, no network fetch.
const BOLD_POP = [
  "#43AA8B", // green
  "#4D96FF", // blue
  "#B57BFF", // purple
  "#FF5D8F", // pink
  "#FFB703", // amber
] as const;

function boldPopInitials(seed: string): string {
  const cleaned = seed.trim().split(/[@\s]+/, 1)[0] ?? "";
  const letters = cleaned.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
  if (letters) return letters;
  return (seed.trim()[0] ?? "A").toUpperCase();
}

export function BoldPopAvatar({ seed, size = 32, label }: {
  seed: string; size?: number; label?: string;
}) {
  const background = BOLD_POP[hashSeed(seed) % BOLD_POP.length];
  const text = boldPopInitials(seed);
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: 9999,
        overflow: "hidden",
        flexShrink: 0,
        background,
        border: "1px solid #242424",
        fontWeight: 400,
        fontSize: Math.round(size * 0.5),
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      {/* DiceBear Initials draws the letters dark at half strength over the fill, so they read as a deeper shade. */}
      <span style={{ color: DARK, opacity: 0.6 }}>{text}</span>
    </span>
  );
}

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}
