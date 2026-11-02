import "server-only";

export class ConnectionError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
    this.name = "ConnectionError";
  }
}
