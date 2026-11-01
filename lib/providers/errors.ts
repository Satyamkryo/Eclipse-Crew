import "server-only";

export type ProviderErrorCode =
  | "invalid_config"
  | "invalid_request"
  | "authentication_failed"
  | "permission_denied"
  | "not_found"
  | "rate_limited"
  | "invalid_request_rejected"
  | "provider_unavailable"
  | "http_error"
  | "network_error"
  | "timeout"
  | "response_too_large"
  | "invalid_response"
  | "invalid_continuation"
  | "tool_calling_unsupported"
  | "tool_calling_unknown";

const messages: Record<ProviderErrorCode, string> = {
  invalid_config: "The provider configuration is invalid.",
  invalid_request: "The provider request is invalid.",
  authentication_failed: "The provider rejected authentication.",
  permission_denied: "The provider denied access.",
  not_found: "The provider resource was not found.",
  rate_limited: "The provider rate limit was reached.",
  invalid_request_rejected: "The provider rejected the request.",
  provider_unavailable: "The provider is unavailable.",
  http_error: "The provider returned an HTTP error.",
  network_error: "The provider request failed.",
  timeout: "The provider request exceeded its time limit.",
  response_too_large: "The provider response exceeded the size limit.",
  invalid_response: "The provider response was invalid.",
  invalid_continuation: "The provider continuation data is invalid.",
  tool_calling_unsupported: "This model does not support tool calling and cannot run an agent.",
  tool_calling_unknown: "This model's tool-calling support could not be verified.",
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(code: ProviderErrorCode, status?: number) {
    super(messages[code]);
    this.name = "ProviderError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export function providerHttpError(status: number): ProviderError {
  if (status === 400) return new ProviderError("invalid_request_rejected", status);
  if (status === 401) return new ProviderError("authentication_failed", status);
  if (status === 403) return new ProviderError("permission_denied", status);
  if (status === 404) return new ProviderError("not_found", status);
  if (status === 429) return new ProviderError("rate_limited", status);
  if (status >= 500) return new ProviderError("provider_unavailable", status);
  return new ProviderError("http_error", status);
}
