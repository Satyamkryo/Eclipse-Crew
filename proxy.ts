import { NextRequest, NextResponse } from "next/server";
import { requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { requireAppOrigin } from "@/lib/config/server";

const PUBLIC_PATHS = new Set(["/login", "/setup", "/api/auth/login", "/api/auth/setup", "/api/health"]);
export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const csp = ["default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-inline'" : ""}`,
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`, "img-src 'self' blob: data:", "font-src 'self'",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  headers.delete("x-owner-id");
  let response: NextResponse;
  const pathname = request.nextUrl.pathname;
  const publicPath = PUBLIC_PATHS.has(pathname) || pathname.startsWith("/_next/") || pathname === "/favicon.ico";
  try {
    if (!publicPath) await requireOwnerRequest(request, { mutation: ["POST", "PUT", "DELETE", "PATCH"].includes(request.method) });
    response = NextResponse.next({ request: { headers } });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 503;
    if (status === 401 && !pathname.startsWith("/api/")) response = NextResponse.redirect(new URL("/login", requireAppOrigin()));
    else response = NextResponse.json({ error: error instanceof RequestError ? error.code : "service_unavailable" }, { status });
  }
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  if (!isDev && new URL(requireAppOrigin()).protocol === "https:") response.headers.set("Strict-Transport-Security", "max-age=31536000");
  return response;
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
