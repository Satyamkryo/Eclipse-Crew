"use client";

import { useState } from "react";

// Inline media from the preview route (image/audio/video only). A failed load quietly falls back to the metadata line.
export function MediaPreview({ src, kind, name }: { src: string; kind: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || (kind !== "image" && kind !== "video" && kind !== "audio")) return null;
  const onError = () => setFailed(true);
  if (kind === "image") {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="mt-3 block w-fit rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {/* eslint-disable-next-line @next/next/no-img-element -- owner-scoped, uncached file; next/image would proxy it */}
        <img src={src} alt={name} loading="lazy" onError={onError} className="max-h-80 max-w-full rounded-md border border-border object-contain" />
      </a>
    );
  }
  if (kind === "video") return <video src={src} controls preload="metadata" onError={onError} aria-label={name} className="mt-3 max-h-80 max-w-full rounded-md border border-border" />;
  return <audio src={src} controls preload="metadata" onError={onError} aria-label={name} className="mt-3 w-full max-w-sm" />;
}
