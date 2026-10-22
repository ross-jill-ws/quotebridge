// The clock module: a broker server's clock rule, its offset at any moment and conversions both ways.
import assert from "node:assert/strict";
import { test } from "node:test";
import { brokerSummers, brokerToUtc, describeRule, inferRule, offsetAtBroker, offsetAtUtc, utcToBroker, type ClockRule } from "../src/shared/clock.js";

const MINUTE = 60_000;
const utc = (iso: string) => Date.parse(`${iso}Z`);

const US2 = { winterOffsetMinutes: 120, dst: "us" } as const;
const EU2 = { winterOffsetMinutes: 120, dst: "eu" } as const;

test("US daylight saving switches at 02:00 New York time on the second Sunday of March and the first of November", () => {
  // 07:00 UTC in March (02:00 EST), 06:00 UTC in November (02:00 EDT).
  const switches: [string, string][] = [
    ["2024-03-10", "2024-11-03"],
    ["2025-03-09", "2025-11-02"],
    ["2026-03-08", "2026-11-01"],
    ["2027-03-14", "2027-11-07"],
  ];
  for (const [spring, autumn] of switches) {
    assert.equal(offsetAtUtc(US2, utc(`${spring}T07:00:00`) - 1), 120, spring);
    assert.equal(offsetAtUtc(US2, utc(`${spring}T07:00:00`)), 180, spring);
    assert.equal(offsetAtUtc(US2, utc(`${autumn}T06:00:00`) - 1), 180, autumn);
    assert.equal(offsetAtUtc(US2, utc(`${autumn}T06:00:00`)), 120, autumn);
  }
});

test("EU daylight saving switches at 01:00 UTC on the last Sundays of March and October", () => {
  const switches: [string, string][] = [
    ["2024-03-31", "2024-10-27"],
    ["2025-03-30", "2025-10-26"],
    ["2026-03-29", "2026-10-25"],
    ["2027-03-28", "2027-10-31"],
  ];
  for (const [spring, autumn] of switches) {
    assert.equal(offsetAtUtc(EU2, utc(`${spring}T01:00:00`) - 1), 120, spring);
    assert.equal(offsetAtUtc(EU2, utc(`${spring}T01:00:00`)), 180, spring);
    assert.equal(offsetAtUtc(EU2, utc(`${autumn}T01:00:00`) - 1), 180, autumn);
    assert.equal(offsetAtUtc(EU2, utc(`${autumn}T01:00:00`)), 120, autumn);
  }
});

test("a rule without daylight saving keeps its offset all year, east and west of UTC", () => {
  const india = { winterOffsetMinutes: 330, dst: "none" } as const;
  const west = { winterOffsetMinutes: -210, dst: "none" } as const;
  for (const iso of ["2026-01-15T12:00:00", "2026-07-15T12:00:00"]) {
    assert.equal(offsetAtUtc(india, utc(iso)), 330);
    assert.equal(offsetAtUtc(west, utc(iso)), -210);
    assert.equal(utcToBroker(india, utc(iso)), utc(iso) + 330 * MINUTE);
    assert.equal(brokerToUtc(west, utc(iso)), utc(iso) + 210 * MINUTE);
  }
});

test("a rule west of UTC with US dates: New York itself", () => {
  const newYork = { winterOffsetMinutes: -300, dst: "us" } as const;
  assert.equal(offsetAtUtc(newYork, utc("2026-01-15T12:00:00")), -300);
  assert.equal(offsetAtUtc(newYork, utc("2026-07-15T12:00:00")), -240);
  // 02:00 local on 8 March 2026 is 07:00 UTC; local clocks jump to 03:00.
  assert.equal(utcToBroker(newYork, utc("2026-03-08T07:00:00")), utc("2026-03-08T03:00:00"));
  assert.equal(brokerToUtc(newYork, utc("2026-03-08T01:59:00")), utc("2026-03-08T06:59:00"));
  assert.equal(brokerToUtc(newYork, utc("2026-03-08T03:00:00")), utc("2026-03-08T07:00:00"));
});

test("broker and UTC times convert both ways in winter and summer", () => {
  for (const iso of ["2026-01-15T12:34:56", "2026-07-15T12:34:56", "2025-12-31T23:59:59"]) {
    for (const rule of [US2, EU2]) {
      assert.equal(brokerToUtc(rule, utcToBroker(rule, utc(iso))), utc(iso), `${iso} ${rule.dst}`);
    }
  }
  assert.equal(utcToBroker(US2, utc("2026-01-15T22:00:00")), utc("2026-01-16T00:00:00"));
  assert.equal(utcToBroker(US2, utc("2026-07-15T21:00:00")), utc("2026-07-16T00:00:00"));
  assert.equal(offsetAtBroker(US2, utc("2026-07-16T00:00:00")), 180);
});

test("broker times in the skipped hour and the repeated hour resolve to the earlier offset", () => {
  // US, GMT+2 winter: the switch at 07:00 UTC is 09:00 broker time, which jumps to 10:00.
  const skipped = utc("2026-03-08T09:30:00");
  assert.equal(offsetAtBroker(US2, skipped), 120);
  assert.equal(brokerToUtc(US2, skipped), utc("2026-03-08T07:30:00"));
  // In November 09:00 broker time (06:00 UTC) falls back to 08:00: 08:00–09:00 happens twice.
  const repeated = utc("2026-11-01T08:30:00");
  assert.equal(offsetAtBroker(US2, repeated), 180);
  assert.equal(brokerToUtc(US2, repeated), utc("2026-11-01T05:30:00"));
  // Either side of the special hours, the plain offsets.
  assert.equal(offsetAtBroker(US2, utc("2026-03-08T08:59:00")), 120);
  assert.equal(offsetAtBroker(US2, utc("2026-03-08T10:00:00")), 180);
  assert.equal(offsetAtBroker(US2, utc("2026-11-01T07:59:00")), 180);
  assert.equal(offsetAtBroker(US2, utc("2026-11-01T09:00:00")), 120);
  // EU, GMT+2 winter: 01:00 UTC is 03:00 broker time in March (skipped to 04:00), 04:00 in October (back to 03:00).
  assert.equal(offsetAtBroker(EU2, utc("2026-03-29T03:15:00")), 120);
  assert.equal(offsetAtBroker(EU2, utc("2026-10-25T03:15:00")), 180);
  assert.equal(brokerToUtc(EU2, utc("2026-10-25T03:15:00")), utc("2026-10-25T00:15:00"));
  assert.equal(brokerToUtc(EU2, utc("2026-10-25T04:15:00")), utc("2026-10-25T02:15:00"));
});

test("the first observed offset sets the rule: +2 or +3 means GMT+2 on US dates, anything else is fixed", () => {
  assert.deepEqual(inferRule(120), US2);
  assert.deepEqual(inferRule(180), US2);
  assert.deepEqual(inferRule(0), { winterOffsetMinutes: 0, dst: "none" } satisfies ClockRule);
  assert.deepEqual(inferRule(330), { winterOffsetMinutes: 330, dst: "none" });
  assert.deepEqual(inferRule(-300), { winterOffsetMinutes: -300, dst: "none" });
});

test("a rule reads as the Terminals panel shows it", () => {
  assert.equal(describeRule(US2), "GMT+2, GMT+3 in US summer time");
  assert.equal(describeRule(EU2), "GMT+2, GMT+3 in EU summer time");
  assert.equal(describeRule({ winterOffsetMinutes: 0, dst: "none" }), "GMT+0, no daylight saving");
  assert.equal(describeRule({ winterOffsetMinutes: 330, dst: "none" }), "GMT+5:30, no daylight saving");
  assert.equal(describeRule({ winterOffsetMinutes: -210, dst: "eu" }), "GMT−3:30, GMT−2:30 in EU summer time");
  assert.equal(describeRule({ winterOffsetMinutes: -60, dst: "us" }), "GMT−1, GMT+0 in US summer time");
});

test("a rule's summers in broker time agree with its offset at every broker hour, including the skipped and repeated hours", () => {
  for (const rule of [{ winterOffsetMinutes: 120, dst: "us" as const }, { winterOffsetMinutes: 60, dst: "eu" as const }, { winterOffsetMinutes: -300, dst: "us" as const }]) {
    const summers = brokerSummers(rule, 2025, 2027);
    assert.equal(summers.length, 3);
    for (let ms = Date.UTC(2025, 0, 1); ms < Date.UTC(2028, 0, 1); ms += 15 * 60_000) {
      const summer = summers.some(([from, to]) => ms >= from && ms < to);
      assert.equal(summer ? rule.winterOffsetMinutes + 60 : rule.winterOffsetMinutes, offsetAtBroker(rule, ms), `${JSON.stringify(rule)} ${new Date(ms).toISOString()}`);
    }
  }
  assert.deepEqual(brokerSummers({ winterOffsetMinutes: 120, dst: "none" }, 2025, 2027), []);
});
