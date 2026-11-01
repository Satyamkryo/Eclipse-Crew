import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { requireEncryptionKey } from "../config/server";

const VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DECRYPTION_ERROR = "Unable to decrypt value.";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decode(part: string, { length, allowEmpty = false }: { length?: number; allowEmpty?: boolean } = {}): Buffer {
  if (!(allowEmpty ? /^[A-Za-z0-9_-]*$/ : BASE64URL).test(part)) throw new Error(DECRYPTION_ERROR);
  const bytes = Buffer.from(part, "base64url");
  if ((length !== undefined && bytes.length !== length) || bytes.toString("base64url") !== part) {
    throw new Error(DECRYPTION_ERROR);
  }
  return bytes;
}

function key(): Buffer {
  return Buffer.from(requireEncryptionKey(), "hex");
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string" || !plaintext.isWellFormed()) {
    throw new Error("Plaintext must be a well-formed Unicode string.");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(envelope: string): string {
  const encryptionKey = key();
  try {
    if (typeof envelope !== "string") throw new Error();
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error();
    const nonce = decode(parts[1], { length: NONCE_BYTES });
    const tag = decode(parts[2], { length: TAG_BYTES });
    const ciphertext = decode(parts[3], { allowEmpty: true });
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(DECRYPTION_ERROR);
  }
}
