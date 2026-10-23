// Window session (ADR 5): main hands the app window a one-time token; the server exchanges it for a session.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/**
 * The session cookie's name for the HTTP server on this port. Browsers do not separate cookies by port, so
 * QuoteBridge servers on different ports (installed app, dev runs) would otherwise replace each other's session.
 */
export const sessionCookie = (port: number) => `qb_session_${port}`;

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Who a session is: the app window (trusted, ADR 5), or a remote browser, which may not manage what only the window owns. */
export type SessionKind = "window" | "remote";

export class WindowSessions {
  private readonly tokens: { digest: Buffer; kind: SessionKind }[] = [];
  private readonly sessions = new Map<string, SessionKind>();

  /** `open`: every request counts as signed in (`npm run dev` in a browser tab; see ServerConfig.openDashboard). */
  constructor(private readonly options: { open?: boolean } = {}) {}

  /**
   * Accepts another one-time token, e.g. for a window opened after a server restart; `kind` "remote" for a remote
   * browser's sign-in.
   */
  addToken(token: string, kind: SessionKind = "window") {
    if (token.length < 16) throw Error("Window token too short");
    this.tokens.push({ digest: digest(token), kind });
  }

  /** Consumes a token and returns a new session ID, or undefined when the token is unknown or already used. */
  exchange(token: string): string | undefined {
    const candidate = digest(token);
    const index = this.tokens.findIndex((t) => timingSafeEqual(t.digest, candidate));
    if (index < 0) return undefined;
    const [{ kind }] = this.tokens.splice(index, 1);
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(session, kind);
    return session;
  }

  /** The request's session cookie (named by `sessionCookie`) names a live session. */
  authenticated(headers: IncomingHttpHeaders, cookie: string) {
    return this.kind(headers, cookie) !== undefined;
  }

  /** Whose session the request's cookie names; undefined without one. An open dashboard (a dev run) is the window's. */
  kind(headers: IncomingHttpHeaders, cookie: string): SessionKind | undefined {
    if (this.options.open) return "window";
    const values = (headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(cookie + "="))
      .map((s) => s.slice(cookie.length + 1));
    return values.length === 1 ? this.sessions.get(values[0]) : undefined;
  }
}
