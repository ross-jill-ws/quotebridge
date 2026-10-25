// Calls to the app's HTTP API from the dashboard. The window session cookie goes along automatically.

/** Sends a JSON body; resolves with the parsed answer (undefined when empty), rejects with the server's message otherwise. */
export async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return answer<T>(res);
}

/** Sends a ZIP as the body; resolves and rejects as post does. */
export async function postZip<T = unknown>(path: string, zip: Blob): Promise<T> {
  return answer<T>(await fetch(path, { method: "POST", headers: { "content-type": "application/zip" }, body: zip }));
}

/** GETs JSON; rejects with the server's message on an error status. */
export async function get<T>(path: string): Promise<T> {
  return answer<T>(await fetch(path, { cache: "no-store" }));
}

/** Thrown for an error answer; `status` is the HTTP status; `notAvailable`: an indicator package disabled or gone. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly notAvailable = false,
  ) {
    super(message);
  }
}

async function answer<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (res.ok) return body as T;
  const { error, notAvailable } = (body ?? {}) as { error?: unknown; notAvailable?: unknown };
  // REST v1 answers { error: { code, message, details } }; the dashboard's own routes { error: "message" }.
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    throw new ApiError((error as { message: string }).message, res.status);
  }
  throw new ApiError(typeof error === "string" ? error : `The app answered ${res.status}.`, res.status, notAvailable === true);
}

/** A REST v1 answer's envelope: `{ data, meta }`. */
export type Envelope<T> = { data: T; meta: Record<string, unknown> };

/** Every item of a cursor-paged REST v1 collection, following `meta.nextCursor` (500 a page). */
export async function getAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Envelope<T[]> = await get(`${path}${path.includes("?") ? "&" : "?"}limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    items.push(...page.data);
    cursor = (page.meta.nextCursor as string | null | undefined) ?? null;
  } while (cursor);
  return items;
}

/** Whether this page's window session still works. Rejects when the server cannot be reached. */
export async function sessionValid(): Promise<boolean> {
  const res = await fetch("/api/state", { cache: "no-store" });
  return res.status !== 401;
}
