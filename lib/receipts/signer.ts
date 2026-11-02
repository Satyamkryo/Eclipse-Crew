import "server-only";

import type { KeyObject } from "node:crypto";

import { requireReceiptSigningKey } from "../config/server";
import { deriveKeys } from "./chain.mjs";

// The install's receipt identity. The seed comes from RECEIPT_SIGNING_KEY and stays inside this module: callers get
// the public key, its fingerprint and a function that signs, never the seed or the private key object.
export interface ReceiptSigner {
  keyId: string;
  publicKey: string;
  privateKey: KeyObject;
}

// Throws when the key is missing or malformed, so the caller can refuse to start a run.
export function loadReceiptSigner(seed: unknown = process.env.RECEIPT_SIGNING_KEY): ReceiptSigner {
  const keys = deriveKeys(requireReceiptSigningKey(seed));
  return { keyId: keys.keyId, publicKey: keys.publicKey, privateKey: keys.privateKey };
}
