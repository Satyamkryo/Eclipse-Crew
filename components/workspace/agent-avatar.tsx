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

// Avatars are styled with classes only. The CSP has no 'unsafe-inline' for styles, so inline style attributes are
// dropped from server-rendered HTML: avatars then lost their box and fill until React re-rendered them on the client.
// Sizes are a fixed table so Tailwind sees every class.
const SIZE_CLASS: Record<number, string> = {
  24: "size-6 text-xs",
  32: "size-8 text-base",
  36: "size-9 text-lg",
  40: "size-10 text-xl",
  44: "size-11 text-[22px]",
  48: "size-12 text-2xl",
  56: "size-14 text-[28px]",
};
const sizeClass = (size: number) => SIZE_CLASS[size] ?? SIZE_CLASS[32];
const AVATAR_BOX = "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-md border border-border";

export function AgentAvatar({ seed, variant, size = 32, label }: {
  seed: string; variant?: number; size?: number; animated?: boolean; label?: string;
}) {
  const index = variant !== undefined && Number.isInteger(variant) && variant >= 0 && variant < AVATAR_COUNT
    ? variant
    : avatarVariant(seed);
  const file = VOXEL_FILES[index];
  return (
    <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}
      className={`${AVATAR_BOX} bg-surface-hover ${sizeClass(size)}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- owner-only avatars; the files are hashed SVGs */}
      <img src={`/avatars/voxel/${file}`} alt="" width={size} height={size} draggable={false}
        className="block size-full max-w-none object-cover" />
    </span>
  );
}

// Owner avatar in the DiceBear "Initials" style (CC0 1.0, owner-supplied reference): a flat colour fill with the owner's
// real initials in soft dark letters. The letters are computed here, never taken from the reference files. Colours are
// the owner-avatar palette in docs/DESIGN.md; local only, no network fetch.
const BOLD_POP = [
  "bg-[#43AA8B]", // green
  "bg-[#4D96FF]", // blue
  "bg-[#B57BFF]", // purple
  "bg-[#FF5D8F]", // pink
  "bg-[#FFB703]", // amber
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
    <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}
      className={`${AVATAR_BOX} font-normal leading-none ${background} ${sizeClass(size)}`}>
      {/* DiceBear Initials draws the letters dark at half strength over the fill, so they read as a deeper shade. */}
      <span className="text-[#0A0A0A] opacity-60">{text}</span>
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
