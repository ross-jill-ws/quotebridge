import { test } from "node:test";
import assert from "node:assert/strict";
import { aboutText, APP_NAME } from "../src/shared/app-identity.js";

test("the app is called QuoteBridge for MetaTrader", () => {
  assert.equal(APP_NAME, "QuoteBridge for MetaTrader");
});

test("the About box names the version, carries the MetaQuotes trademark notice and claims no affiliation (ADR 1)", () => {
  const about = aboutText("1.2.3");
  assert.equal(about.title, "About QuoteBridge for MetaTrader");
  assert.match(about.detail, /^Version 1\.2\.3$/m);
  assert.match(about.detail, /MetaTrader is the registered trademark of MetaQuotes Ltd\./);
  assert.match(about.detail, /not affiliated with or endorsed by MetaQuotes/);
  assert.match(about.detail, /MIT/);
  assert.match(about.detail, /libzmq.*MPL-2\.0/);
});
