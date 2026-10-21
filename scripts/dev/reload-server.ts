// The dev reload signal for `npm run dev`: a Server-Sent Events stream on its own port (never the
// app's). Dev dashboard bundles subscribe to it (scripts/dashboard-build.ts); production ones do not.
// A second stream carries commands for the app's main process (`npm run dev -- --app`).
import { createServer, type ServerResponse } from "node:http";

export type ReloadServer = {
  /** The event stream pages subscribe to. */
  url: string;
  /** Every open page reloads. */
  reload(): void;
  /** Every open page goes to `url` (a new sign-in link after a server restart). */
  navigate(url: string): void;
  /** The stream the app's main process subscribes to (QUOTEBRIDGE_DEV_CONTROL). */
  controlUrl: string;
  control(command: "restart-server" | "quit"): void;
  close(): Promise<void>;
};

export async function startReloadServer(port: number): Promise<ReloadServer> {
  const pages = new Set<ServerResponse>();
  const apps = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const subscribers = req.url === "/events" ? pages : req.url === "/control" ? apps : undefined;
    if (!subscribers) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      // The page comes from the dashboard's origin, another port.
      "access-control-allow-origin": "*",
    });
    res.flushHeaders();
    subscribers.add(res);
    req.on("close", () => subscribers.delete(res));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const send = (to: Set<ServerResponse>, event: string, data = "") => {
    for (const res of to) res.write(`event: ${event}\ndata: ${data}\n\n`);
  };
  return {
    url: `http://127.0.0.1:${port}/events`,
    reload: () => send(pages, "reload"),
    navigate: (url) => send(pages, "navigate", url),
    controlUrl: `http://127.0.0.1:${port}/control`,
    control: (command) => send(apps, command),
    close: () =>
      new Promise((resolve) => {
        for (const res of [...pages, ...apps]) res.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
