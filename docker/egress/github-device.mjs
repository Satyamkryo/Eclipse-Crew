// TASK-088. The only two GitHub calls the app may make for a GitHub App device sign-in. The host and paths are
// fixed here, so this cannot be used as a general outbound path. The client ID is public; no client secret exists.

export const DEVICE_HOST = "github.com";
export const DEVICE_CODE_PATH = "/login/device/code";
export const DEVICE_TOKEN_PATH = "/login/oauth/access_token";
export const MAX_DEVICE_BODY = 8 * 1024;

const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const DEVICE_CODE = /^[A-Za-z0-9._-]{8,256}$/;
const TOKEN = /^[\x21-\x7e]{8,4096}$/;
const USER_CODE = /^[A-Z0-9-]{4,32}$/;
const VERIFICATION_URI = /^https:\/\/github\.com\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{0,255}$/;
const ERROR = /^[a-z_]{1,64}$/;

export class DeviceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// The app sends one of two operations. `code` starts a device flow; `token` exchanges either the device code
// (first sign-in) or a refresh token (later refreshes). Nothing else is accepted.
export function parseDeviceRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeviceError("invalid_device_request");
  const keys = Object.keys(value);
  if (keys.some((key) => !["operation", "clientId", "deviceCode", "refreshToken"].includes(key))) throw new DeviceError("invalid_device_request");
  if (typeof value.clientId !== "string" || !CLIENT_ID.test(value.clientId)) throw new DeviceError("invalid_device_request");

  if (value.operation === "code") {
    if (keys.length !== 2) throw new DeviceError("invalid_device_request");
    return { operation: "code", path: DEVICE_CODE_PATH,
      form: new URLSearchParams({ client_id: value.clientId }).toString() };
  }
  if (value.operation === "token") {
    const hasDevice = typeof value.deviceCode === "string";
    const hasRefresh = typeof value.refreshToken === "string";
    if (hasDevice === hasRefresh) throw new DeviceError("invalid_device_request");
    if (hasDevice && !DEVICE_CODE.test(value.deviceCode)) throw new DeviceError("invalid_device_request");
    if (hasRefresh && !TOKEN.test(value.refreshToken)) throw new DeviceError("invalid_device_request");
    const form = hasDevice
      ? new URLSearchParams({
        client_id: value.clientId, device_code: value.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      })
      : new URLSearchParams({ client_id: value.clientId, refresh_token: value.refreshToken, grant_type: "refresh_token" });
    return { operation: "token", path: DEVICE_TOKEN_PATH, form: form.toString() };
  }
  throw new DeviceError("invalid_device_request");
}

const boundedString = (value, max = 4096) => typeof value === "string" && value.length >= 1 && value.length <= max ? value : null;
const boundedInt = (value, max) => Number.isInteger(value) && value >= 0 && value <= max ? value : null;

// Only the fields the app needs leave the proxy. An error response carries a fixed code, never the raw body.
export function sanitizeDeviceResponse(operation, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeviceError("invalid_device_response");
  if (operation === "code") {
    const deviceCode = boundedString(value.device_code, 256);
    const userCode = boundedString(value.user_code, 32);
    const verificationUri = boundedString(value.verification_uri, 300);
    const expiresIn = boundedInt(value.expires_in, 86_400);
    const interval = boundedInt(value.interval, 60);
    if (!deviceCode || !userCode || !USER_CODE.test(userCode) || !verificationUri || !VERIFICATION_URI.test(verificationUri) ||
        expiresIn === null || expiresIn < 60 || interval === null || interval < 1) {
      throw new DeviceError("invalid_device_response");
    }
    return { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, expires_in: expiresIn, interval };
  }
  if (typeof value.access_token === "string" && TOKEN.test(value.access_token)) {
    return {
      access_token: value.access_token,
      token_type: boundedString(value.token_type, 32) ?? "bearer",
      scope: boundedString(value.scope, 1024) ?? "",
      refresh_token: typeof value.refresh_token === "string" && TOKEN.test(value.refresh_token) ? value.refresh_token : null,
      expires_in: boundedInt(value.expires_in, 86_400),
      refresh_token_expires_in: boundedInt(value.refresh_token_expires_in, 31_536_000),
    };
  }
  const error = typeof value.error === "string" && ERROR.test(value.error) ? value.error : "invalid_device_response";
  return { error, error_description: boundedString(value.error_description, 300) ?? null };
}

export function deviceTimeoutMs(value = 15_000) {
  return Number.isInteger(value) && value >= 1_000 && value <= 30_000 ? value : 15_000;
}
