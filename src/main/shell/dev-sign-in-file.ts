// `npm run dev` only: the run's current one-time sign-in link in a file that only the current user can read, so
// agents sign in without reading the link from the console. Sign-in links are secrets.
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

/** The file's name in the dev run's data folder. */
export const DEV_SIGN_IN_FILE_NAME = "dev-sign-in-link.txt";

const run = promisify(execFile);

export class DevSignInFile {
  private current: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  /** `url` becomes the current link. The previous one is used up first, so at no time do both sign in. */
  set(url: string): Promise<void> {
    return this.serially(async () => {
      if (this.current === undefined) await this.createOwnerOnly();
      else if (this.current !== url) await useUp(this.current);
      await writeFile(this.path, url);
      this.current = url;
    });
  }

  remove(): Promise<void> {
    return this.serially(async () => {
      this.current = undefined;
      await rm(this.path, { force: true });
    });
  }

  private serially(step: () => Promise<void>) {
    const next = this.queue.then(step);
    this.queue = next.catch(() => {});
    return next;
  }

  /** A fresh, empty file whose only access is the current user's, before any link goes into it. */
  private async createOwnerOnly() {
    await rm(this.path, { force: true });
    await writeFile(this.path, "", { mode: 0o600 });
    if (process.platform !== "win32") return;
    // By full path: Git Bash puts a GNU whoami first on PATH.
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const { stdout } = await run(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const sid = stdout.trim().split(",").at(-1)?.replace(/"/g, "");
    if (!sid?.startsWith("S-")) throw Error(`Could not read the current user's SID from whoami: ${stdout}`);
    await run(join(system32, "icacls.exe"), [this.path, "/inheritance:r", "/grant:r", `*${sid}:F`]);
  }
}

/**
 * Exchanges the link's token, so the link no longer signs in. The session it makes stays unused on the server
 * (no cookie ever carries it). A link from a server that has stopped is dead anyway.
 */
async function useUp(url: string) {
  try {
    const res = await fetch(url, { redirect: "manual" });
    await res.body?.cancel();
  } catch {
    // The server that issued it has stopped.
  }
}
