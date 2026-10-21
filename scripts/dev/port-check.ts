// `npm run dev -- --real` binds the real ports: refuse up front, with a clear message, while
// something else (the installed app, the legacy server) holds one of them.
import { connect, createServer } from "node:net";

export async function realPortsRefusal(ports: { ea: number; http: number }): Promise<string | null> {
  const taken: string[] = [];
  if (await inUse(ports.ea)) taken.push(`EA port ${ports.ea}`);
  if (await inUse(ports.http)) taken.push(`HTTP port ${ports.http}`);
  if (!taken.length) return null;
  return (
    `The ${taken.join(" and the ")} on 127.0.0.1 ${taken.length > 1 ? "are" : "is"} in use by another program.\n` +
    `npm run dev -- --real needs the real ports: quit the installed QuoteBridge (tray > Quit) and stop the legacy server, then try again.`
  );
}

/** A program listening on any address (e.g. 0.0.0.0) accepts a local connection even where a 127.0.0.1 bind might succeed. */
async function inUse(port: number) {
  return !(await canListen(port)) || (await accepts(port));
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

function canListen(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
