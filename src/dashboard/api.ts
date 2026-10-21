// Calls to the app's HTTP API from the dashboard. The window session cookie goes along automatically.

/** Sends a JSON body; resolves on success, rejects with the server's message otherwise. */
export async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  const message = await res
    .json()
    .then((b: { error?: unknown }) => (typeof b.error === "string" ? b.error : undefined))
    .catch(() => undefined);
  throw Error(message ?? `The app answered ${res.status}.`);
}

/** Whether this page's window session still works. Rejects when the server cannot be reached. */
export async function sessionValid(): Promise<boolean> {
  const res = await fetch("/api/state", { cache: "no-store" });
  return res.status !== 401;
}
