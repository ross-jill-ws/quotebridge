// Free TCP ports for tests that start servers on ports chosen up front.
//
// Asking the OS for port 0 and closing it again is racy on Windows: a just-closed port is often
// handed straight back to the next bind to port 0, in another test file running in parallel or in
// this process (two calls in a row can return the same port). The server then fails to start with
// port-in-use. So ports come from outside the OS's dynamic (ephemeral) range, which neither port-0
// binds nor outgoing connections use, and each port is claimed for the life of this test process
// with an exclusive named pipe (Windows) or abstract socket (Linux), so no other test process picks it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";

/** Ports never handed out: the user's legacy server listens there. */
const RESERVED = new Set([3000, 5555]);
const LOWEST = 1024;
const HIGHEST = 65535;
/** Prefer ports above the usual development servers when the dynamic range leaves room there. */
const PREFERRED_LOWEST = 20000;

let candidates: number[] | undefined;
let next = 0;
/** Claim servers, held (unref'd) until the process exits. */
const claims: Server[] = [];

/** A free TCP port on 127.0.0.1, distinct from every other port this run of the tests has handed out. */
export async function freePort(): Promise<number> {
  candidates ??= candidatePorts();
  for (let tried = 0; tried < candidates.length; tried++) {
    const port = candidates[next++ % candidates.length];
    if (!(await claim(port))) continue;
    if (await canListen(port)) return port;
  }
  throw Error("No free TCP port found outside the dynamic port range");
}

/** Every allowed port outside the dynamic range, starting at a random point so parallel processes rarely contend. */
function candidatePorts(): number[] {
  const [dynamicLow, dynamicHigh] = dynamicPortRange();
  const outside = (low: number) => {
    const ports: number[] = [];
    for (let p = low; p <= HIGHEST; p++) if ((p < dynamicLow || p > dynamicHigh) && !RESERVED.has(p)) ports.push(p);
    return ports;
  };
  const preferred = outside(PREFERRED_LOWEST);
  const ports = preferred.length >= 1000 ? preferred : outside(LOWEST);
  const start = Math.floor(Math.random() * ports.length);
  return [...ports.slice(start), ...ports.slice(0, start)];
}

/** The OS range for port-0 binds and outgoing connections (inclusive). */
function dynamicPortRange(): [number, number] {
  try {
    if (process.platform === "win32") {
      // "Start Port : 49152" / "Number of Ports : 16384" (labels are localised; the numbers come in this order).
      const [start, count] = (execFileSync("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"], { encoding: "utf8" }).match(/\d+/g) ?? []).map(Number);
      if (start > 0 && count > 0) return [start, start + count - 1];
    } else if (process.platform === "linux") {
      const [low, high] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
      if (low > 0 && high >= low) return [low, high];
    }
  } catch {
    // Fall back to the IANA range below.
  }
  return [49152, 65535];
}

/** Claims the port for this process; false when another test process holds it. Released when the process exits. */
function claim(port: number): Promise<boolean> {
  const name = `quotebridge-test-port-${port}`;
  const path = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `\0${name}`;
  const server = createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(path, () => {
      server.unref();
      claims.push(server);
      resolve(true);
    });
  });
}

/** Free on 127.0.0.1 and on ::1, where the HTTP server binds too (a computer without IPv6 has no ::1 to hold). */
async function canListen(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    const probe = createServer();
    const free = await new Promise<boolean>((resolve) => {
      probe.once("error", (e: NodeJS.ErrnoException) => resolve(host === "::1" && (e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT")));
      probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}
