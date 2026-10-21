import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_NAME } from "../src/shared/app-identity.js";

test("the app is called QuoteBridge for MetaTrader", () => {
  assert.equal(APP_NAME, "QuoteBridge for MetaTrader");
});
