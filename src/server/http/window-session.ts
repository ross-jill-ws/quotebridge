// Window session (ADR 5): main hands the app window a one-time token; the server exchanges it for a session.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const SESSION_COOKIE = "qb_session";

const digest = (value: string) => createHash("sha256").update(value).digest();

export class WindowSessions {
  private readonly tokens: Buffer[] = [];
  private readonly sessions = new Set<string>();

  /** Accepts another one-time token, e.g. for a window opened after a server restart. */
  addToken(token: string) {
    if (token.length < 16) throw Error("Window token too short");
    this.tokens.push(digest(token));
  }

  /** Consumes a token and returns a new session ID, or undefined when the token is unknown or already used. */
  exchange(token: string): string | undefined {
    const candidate = digest(token);
    const index = this.tokens.findIndex((t) => timingSafeEqual(t, candidate));
    if (index < 0) return undefined;
    this.tokens.splice(index, 1);
    const session = randomBytes(32).toString("base64url");
    this.sessions.add(session);
    return session;
  }

  /** The request's session cookie names a live session. */
  authenticated(headers: IncomingHttpHeaders) {
    const values = (headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(SESSION_COOKIE + "="))
      .map((s) => s.slice(SESSION_COOKIE.length + 1));
    return values.length === 1 && this.sessions.has(values[0]);
  }
}
