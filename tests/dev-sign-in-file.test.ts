// `npm run dev` hands agents its one-time sign-in link through a file only the current user can read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_SIGN_IN_FILE_NAME } from "../src/main/shell/dev-sign-in-file.js";
import { freePort } from "./free-port.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Waits until `read` returns something, or fails after `timeoutMs`. */
async function until<T>(what: string, read: () => T | undefined, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Opens a sign-in link the way a browser does: 303 with a session cookie, or 401 once it is used up. */
async function signIn(url: string) {
  const res = await fetch(url, { redirect: "manual" });
  await res.body?.cancel();
  return res.status;
}

test("a dev run keeps its current one-time sign-in link in an owner-only file, and removes it when it stops", { timeout: 120_000 }, async (t) => {
  const dataFolder = await mkdtemp(join(tmpdir(), "quotebridge-dev-sign-in-"));
  t.after(() => rm(dataFolder, { recursive: true, force: true }));
  const file = join(dataFolder, DEV_SIGN_IN_FILE_NAME);
  const env = {
    ...process.env,
    QUOTEBRIDGE_DATA_FOLDER: dataFolder,
    QUOTEBRIDGE_EA_PORT: String(await freePort()),
    QUOTEBRIDGE_HTTP_PORT: String(await freePort()),
    QUOTEBRIDGE_DEV_RELOAD_PORT: String(await freePort()),
  };
  const run = spawn(process.execPath, ["--import", "tsx", join(root, "scripts", "dev", "dev.ts")], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  run.stdout.on("data", (chunk) => (output += chunk));
  run.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => run.once("exit", resolve));
  t.after(() => {
    if (run.exitCode === null) run.kill();
    return exited;
  });
  const link = () => (existsSync(file) ? readFileSync(file, "utf8") || undefined : undefined);

  const first = await until("the first sign-in link", link).catch((e: Error) => assert.fail(`${e.message}\n${output}`));
  assert.match(first, /^http:\/\/127\.0\.0\.1:\d+\/session\?token=[\w-]+$/);
  if (process.platform === "win32") {
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const acl = execFileSync(join(system32, "icacls.exe"), [file], { encoding: "utf8" });
    const grants = acl.replace(file, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes(":("));
    const me = execFileSync(join(system32, "whoami.exe"), { encoding: "utf8" }).trim().toLowerCase();
    assert.deepEqual(grants.map((g) => g.slice(0, g.indexOf(":(")).toLowerCase()), [me], `only the current user may read the file:\n${acl}`);
  }

  run.stdin.write("\n");
  const second = await until("a new sign-in link", () => (link() !== first ? link() : undefined));
  assert.equal(await signIn(first), 401, "the earlier link no longer signs in");
  assert.equal(await signIn(second), 303);

  run.stdin.write("q\n");
  assert.equal(await exited, 0, output);
  assert.equal(existsSync(file), false, "the file is gone after the run stops");
});
