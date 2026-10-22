// Answers shared by the HTTP server's routes: JSON, and downloads written a chunk at a time.
import type { ServerResponse } from "node:http";

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
}

/**
 * Writes a chunk, waiting for the client to take it: a long download is never held whole. A client that goes away ends
 * the wait too; the caller stops once `res.destroyed`.
 */
export function write(res: ServerResponse, chunk: string | Buffer): Promise<void> {
  return res.write(chunk)
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const done = () => {
          res.off("drain", done).off("close", done);
          resolve();
        };
        res.on("drain", done).on("close", done);
      });
}
