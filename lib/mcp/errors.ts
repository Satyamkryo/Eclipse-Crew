import "server-only";

export class McpError extends Error {
  constructor(public readonly code: string, public readonly status = 502) {
    super(code);
    this.name = "McpError";
  }
}
