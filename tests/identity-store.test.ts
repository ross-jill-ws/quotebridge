// Approved seam: identities registered through the public store survive a real database close/reopen.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { openDatabase } from "../src/server/database.js";
import { accountId, marketId, DuckDbIdentityStore, IdentityError, memoryIdentityStore, type IdentityStore } from "../src/server/identity/index.js";

test("known account identity survives restart and deduplicates another terminal or reinstall without finances", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-identities-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  let db = await openDatabase(folder);
  t.after(() => db.checkpointAndClose());
  const account = await db.identities.put({ brokerServer: "Demo-Broker", login: "12345678", label: "Demo account", balance: "999.00", terminal: "old-install" } as Parameters<typeof db.identities.put>[0]);
  assert.equal(account.id, "account-8af79cc78fa9520dc31293d6ba0422ed92264be5614fd118a105c5905cc069bb", "versioned SHA256 identity remains stable across releases");
  assert.equal(account.id, accountId("Demo-Broker", "12345678"));
  await db.checkpointAndClose();
  db = await openDatabase(folder);
  assert.deepEqual(await db.identities.list(), [{ id: account.id, brokerServer: "Demo-Broker", login: "12345678", label: "Demo account" }]);
  await db.identities.put({ brokerServer: "Demo-Broker", login: "12345678", label: "Renamed" });
  assert.deepEqual(await db.identities.list(), [{ ...account, label: "Renamed" }]);
  assert.notEqual(accountId("demo-broker", "12345678"), account.id, "broker spelling is identity, not a label");
  assert.notEqual(accountId("Demo-Broker", "12345679"), account.id);
  assert.match(marketId("Demo-Broker", "EURUSD"), /^market-[a-f0-9]{64}$/);
  assert.notEqual(marketId("Demo-Broker", "EURUSD"), marketId("Demo-Broker", "eurusd"));
  assert.notEqual(marketId("Demo-Broker", "EURUSD"), marketId("demo-broker", "EURUSD"));
});

test("a journal-linked account can be registered without a live terminal, then reopened with its label intact", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-journal-identity-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  let db = await openDatabase(folder);
  t.after(() => db.checkpointAndClose());
  const journalIdentity = { brokerServer: "Journal-Only", login: "87654321", label: "Imported account" };
  const registered = await db.identities.put(journalIdentity);
  await db.checkpointAndClose();
  db = await openDatabase(folder);
  assert.deepEqual(await db.identities.put({ brokerServer: journalIdentity.brokerServer, login: journalIdentity.login }), registered);
  assert.deepEqual(await db.identities.list(), [registered]);
  const cleanFolder = await mkdtemp(join(tmpdir(), "quotebridge-reinstalled-identity-"));
  t.after(() => rm(cleanFolder, { recursive: true, force: true }));
  const reinstalled = await openDatabase(cleanFolder);
  t.after(() => reinstalled.checkpointAndClose());
  assert.deepEqual(await reinstalled.identities.put(journalIdentity), registered, "no random mapping needs to survive reinstall");
});

test("memory and persistent stores share exact identity, label, copy and privacy rules", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-identity-contract-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const db = await openDatabase(folder);
  t.after(() => db.checkpointAndClose());
  for (const store of [memoryIdentityStore(), db.identities] satisfies IdentityStore[]) {
    const row = { brokerServer: "Exact-Broker", login: "12345678", label: "One" };
    const a = await store.put(row);
    row.label = "caller mutation";
    a.label = "return mutation";
    const listed = await store.list();
    assert.equal(listed[0].label, "One");
    listed[0].label = "list mutation";
    assert.equal((await store.put({ brokerServer: row.brokerServer, login: row.login })).label, "One");
    await store.put({ ...row, brokerServer: "exact-broker" });
    assert.equal((await store.list()).length, 2, "exact servers must not merge");
    await store.put({ ...row, label: "" });
    assert.equal((await store.put({ brokerServer: row.brokerServer, login: row.login })).label, "");
    for (const login of ["012345678", "12345678\n", "0", "2147483648"]) {
      await assert.rejects(store.put({ ...row, login }), (error: unknown) => {
        assert.ok(error instanceof IdentityError);
        assert.equal(error.code, "identity");
        assert.ok(!JSON.stringify(error).includes(login));
        assert.ok(!String(error).includes(login));
        assert.equal(error.cause, undefined);
        return true;
      });
    }
    assert.equal((await store.list()).length, 2, "an invalid registration does not poison subsequent reads");
  }
});

test("registration captures identity at the public boundary, not after the caller changes its object", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-identity-copy-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const db = await openDatabase(folder);
  t.after(() => db.checkpointAndClose());
  for (const store of [memoryIdentityStore(), db.identities] satisfies IdentityStore[]) {
    const input = { brokerServer: "Demo-Broker", login: "12345678", label: "Original" };
    const pending = store.put(input);
    input.login = "87654321";
    input.label = "Changed";
    const account = await pending;
    assert.equal(account.login, "12345678");
    assert.equal(account.label, "Original");
    assert.deepEqual(await store.list(), [account]);
  }
});

test("DuckDbIdentityStore constructor exposes only static safe errors when storage fails", async (t) => {
  const instance = await DuckDBInstance.create(":memory:");
  const store = new DuckDbIdentityStore(await instance.connect());
  t.after(() => { store.close(); instance.closeSync(); });
  for (const work of [() => store.put({ brokerServer: "Private-Broker", login: "12345678" }), () => store.list()]) {
    await assert.rejects(work(), (error: unknown) => {
      assert.ok(error instanceof IdentityError);
      assert.equal(error.message, "Account identity could not be read or stored");
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
