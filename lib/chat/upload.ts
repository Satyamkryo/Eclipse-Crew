import { chatMessageResponseSchema, type ChatMessage } from "./schema";

// Browser side of chat attachments. The server decides what is accepted; this only gives early, plain feedback.
export class UploadError extends Error {
  constructor(public code: string, public status = 0) { super(code); }
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024; let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 10 ? Math.round(size) : Math.round(size * 10) / 10} ${units[unit]}`;
}

// Chat attachments are limited to documents, images, audio, video and text. The server still applies its own blocklist.
const DOC_EXTENSIONS = ["pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "tsv", "ppt", "pptx", "odp", "epub"];
const TEXT_EXTENSIONS = ["txt", "md", "markdown", "json", "yaml", "yml", "xml", "log", "html", "htm", "css", "srt", "vtt"];
const MEDIA_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "avif", "tif", "tiff",
  "mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "opus", "weba", "mp4", "mov", "webm", "mkv", "avi", "m4v", "ogv"];
const ALLOWED_EXTENSIONS = new Set([...DOC_EXTENSIONS, ...TEXT_EXTENSIONS, ...MEDIA_EXTENSIONS]);
export const ATTACHMENT_ACCEPT = ["image/*", "audio/*", "video/*", "text/*", ...[...ALLOWED_EXTENSIONS].map((ext) => `.${ext}`)].join(",");

export function isSupportedAttachment(file: { name: string; type?: string }): boolean {
  if (file.type && /^(image|audio|video|text)\//.test(file.type)) return true;
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  return ALLOWED_EXTENSIONS.has(ext);
}

export function precheckFile(file: { name: string; size: number; type?: string }, maxBytes?: number): UploadError | null {
  if (maxBytes !== undefined && file.size > maxBytes) return new UploadError("file_too_large");
  if (encodeURIComponent(file.name).length > 3072) return new UploadError("name_invalid");
  if (!isSupportedAttachment(file)) return new UploadError("type_unsupported");
  if (file.size < 1) return new UploadError("empty_file");
  return null;
}

export function uploadErrorMessage(code: string, maxBytes?: number): string {
  switch (code) {
    case "file_too_large": return maxBytes ? `This file is over the ${formatBytes(maxBytes)} limit.` : "This file is over the size limit.";
    case "type_unsupported": return "This file type isn't supported. Attach documents, images, audio, video or text.";
    case "type_blocked": return "This file type isn't accepted. Programs, scripts and documents with macros are blocked.";
    case "name_invalid": return "This file name isn't valid. Rename the file and try again.";
    case "empty_file": return "This file is empty.";
    case "incomplete_upload": return "The upload didn't finish. Try again.";
    case "upload_busy": return "Another upload is running. Try again in a moment.";
    case "agent_paused": return "This agent is paused. Resume it from Settings, then try again.";
    case "agent_not_found":
    case "agent_unavailable": return "This agent is unavailable or does not belong to your account.";
    case "cancelled": return "Upload cancelled.";
    default: return "Couldn't upload this file. Try again.";
  }
}

export type UploadHandle = { promise: Promise<ChatMessage>; cancel: () => void };

// One raw request per file (no multipart), so progress is real and the server never buffers the whole body.
export function uploadFile(agentId: string, csrfToken: string, file: File, onProgress: (loaded: number) => void): UploadHandle {
  const request = new XMLHttpRequest();
  const promise = new Promise<ChatMessage>((resolve, reject) => {
    request.open("POST", `/api/agents/${encodeURIComponent(agentId)}/files`);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.setRequestHeader("x-csrf-token", csrfToken);
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded); };
    request.onabort = () => reject(new UploadError("cancelled"));
    request.onerror = () => reject(new UploadError("network"));
    request.ontimeout = () => reject(new UploadError("network"));
    request.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(request.responseText); } catch { /* not JSON */ }
      if (request.status === 201) {
        const parsed = chatMessageResponseSchema.safeParse(body);
        if (parsed.success) return resolve(parsed.data.message);
        return reject(new UploadError("invalid_response", request.status));
      }
      const code = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "failed";
      reject(new UploadError(code, request.status));
    };
    request.send(file);
  });
  return { promise, cancel: () => request.abort() };
}
