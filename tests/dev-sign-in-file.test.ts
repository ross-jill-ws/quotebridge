// `npm run dev` in a browser tab needs no sign-in; with --app, the dev run hands out a one-time sign-in link for a
// browser through a file only the current user can read.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_SIGN_IN_FILE_NAME, DevSignInFile } from "../src/main/shell/dev-sign-in-file.js";
import { windowUrl } from "../src/main/supervisor/supervisor.js";
import { startServer } from "../src/server/index.js";
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

async function tempFolder(t: TestContext, name: string) {
  const folder = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test("npm run dev prints a dashboard address that opens in a browser without signing in", { timeout: 120_000 }, async (t) => {
  const dataFolder = await tempFolder(t, "quotebridge-dev-open-");
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

  const url = await until("the dashboard address", () => /dashboard: (\S+)/.exec(output)?.[1]).catch((e: Error) => assert.fail(`${e.message}\n${output}`));
  assert.equal(url, `http://127.0.0.1:${env.QUOTEBRIDGE_HTTP_PORT}/`);
  for (const path of ["", "api/state"]) assert.equal((await fetch(url + path)).status, 200, path);
  assert.equal(existsSync(join(dataFolder, DEV_SIGN_IN_FILE_NAME)), false, "no sign-in link to hand out");

  run.stdin.write("q\n");
  assert.equal(await exited, 0, output);
});

test("the sign-in link file holds only the newest one-time link, readable by the current user only, until removed", { timeout: 30_000 }, async (t) => {
  const folder = await tempFolder(t, "quotebridge-dev-sign-in-");
  const server = await startServer({ eaPort: await freePort(), httpPort: await freePort(), windowToken: "window-token-0123456789" });
  t.after(() => server.close());
  const link = (token: string) => {
    server.addWindowToken(token);
    return windowUrl(server.httpOrigin, token);
  };
  const file = new DevSignInFile(join(folder, DEV_SIGN_IN_FILE_NAME));

  const first = link("first-token-0123456789");
  await file.set(first);
  assert.equal(readFileSync(file.path, "utf8"), first);
  if (process.platform === "win32") {
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const acl = execFileSync(join(system32, "icacls.exe"), [file.path], { encoding: "utf8" });
    const grants = acl.replace(file.path, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes(":("));
    const me = execFileSync(join(system32, "whoami.exe"), { encoding: "utf8" }).trim().toLowerCase();
    assert.deepEqual(grants.map((g) => g.slice(0, g.indexOf(":(")).toLowerCase()), [me], `only the current user may read the file:\n${acl}`);
  }

  const second = link("second-token-0123456789");
  await file.set(second);
  assert.equal(readFileSync(file.path, "utf8"), second);
  assert.equal(await signIn(first), 401, "the earlier link no longer signs in");
  assert.equal(await signIn(second), 303);

  await file.remove();
  assert.equal(existsSync(file.path), false);
});
