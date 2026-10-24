---
name: mt4-indicator-to-package
description: Convert an MT4 indicator's MQL4 source (.mq4) into a QuoteBridge indicator package with tests and a ZIP. Use when porting an .mq4 indicator, or checking a converted package against MT4's values.
---

# MT4 indicator to QuoteBridge package

Input: a readable `.mq4` and a slug for the package. Output: a package folder `indicators/<slug>/` in this working copy (git-ignored; the trader's own work) holding the four package files and `<slug>.test.ts`, and its ZIP in `build/`.

The package format is [the user manual's Indicator packages page](../../../docs/indicator-packages.md); read all of it before gate 1. Where the page and the code disagree, `src/shared/indicator-manifest.ts` (manifest validation) and `src/server/indicators/sandbox.ts` (the `calculate` contract and limits) decide. The bundled packages in `src/server/indicators/bundled/` are worked conversions: MACD, AO, AC and Alligator follow MT4's built-ins, and `eo/README.md` shows how a custom indicator's quirks are recorded.

Each gate ends the step; pass it before the next.

## 1. Check that the indicator is supported

Read the whole `.mq4`, its local `#include`s and every `iCustom` it calls. With only an `.ex4`, ask for the source: compiled MQL4 cannot be converted. Leave the trader's MT4 files unchanged.

A package gets one price per bar (close, or median `(high + low) / 2`) of its own chart's symbol and period, and draws lines and histograms on the price or in one pane. List each dependency the indicator has beyond that: open, high, low or volume as separate series, typical or weighted price, other symbols or periods, chart objects, arrows, fills, alerts, files, `Time`-based logic, trading calls.

**Gate:** every input and every drawn buffer maps to something the page supports, or the trader has chosen a reduced scope for the parts that don't. When something doesn't map, stop and ask, naming each unsupported part. A missing price is never stood in for by another price or by zeros.

## 2. Write the semantic map

Work through [the MQL4 semantic checklist](references/mql4-semantics.md) and write the answers into the package README's Mapping section, in the shape the checklist's last section gives: every `extern`/`input` parameter, the source price, every buffer (hidden ones included), each smoothing stage and its seed, indexing and shifts, draw-begin, empty values, colours, and the forming-bar behaviour. Name the warm-up the package declares and why it is enough.

Record each suspicious source behaviour and each intentional difference with its reason. A difference that changes what a trading signal means (another averaging method, another seed, another colour switch) needs the trader's yes before it is built.

**Gate:** every buffer and every branch of the source is accounted for as kept, internal, merged, unsupported or changed, with a reason. The actual MQL4 call decides a mapping, never a variable's name.

## 3. Write the four files

In `indicators/<slug>/`: `manifest.json`, `calculate.js`, `README.md` and `LICENSE`.

- **id**: the trader's own prefix and the slug (`<prefix>.<slug>`); the page's Versions section lists the ids that are taken. Version `1.0.0`.
- **Parameters** keep the source's defaults. The label is the `input`'s trailing comment, which MT4 shows in its Inputs tab, else the name in words (`MaPeriod` → "MA period"). The range is what the source handles, capped so that the warm-up stays within the page's limit at every maximum; record a cap the source doesn't have as a difference. `lessThan` only where the source requires the order. An MQL4 enum input becomes a choice parameter.
- **Warm-up** (`history`): the bars until every output has settled. It names one parameter; when several periods add up, name the largest and set `extra` to cover the others at their maximum, or declare fixed `bars`.
- **Extended fields** (`closedBarsOnly`, `levels`, `range`, a `rising`/`falling` palette) follow from the gate 2 map; the checklist says which MQL4 feature maps to each.
- **calculate.js** is one self-contained script setting `exports.calculate`, computing every output from `inputs.source.points` oldest first, returning exactly the manifest's outputs with `null` where MT4 shows nothing.
- **README.md**: what it computes, the parameter table with each MQL4 input's name, the formula, the mapping from gate 2, the colours, and provenance: the source file's name, author, licence notice and SHA-256.
- **LICENSE**: the source's licence text, or its notice as the source gives it (a public-domain dedication, with the author's name or "no author named"). Third-party work keeps its author's terms; label it MIT or the trader's own only with the author's grant, and ask when the terms are unclear.

**Gate:** `npm run indicator-package -- indicators/<slug>` passes (the manifest is valid and the trial run succeeds; it writes a ZIP that step 6 replaces), and every entry of the gate 2 map is in the README.

## 4. Write tests against hand-worked values

Write `indicators/<slug>/<slug>.test.ts` (`node:test`), running the package in the real sandbox through `loadPackage` from `scripts/indicator-package.ts` and `IndicatorEngine` from `src/server/indicators/index.ts`; `tests/indicator-sandbox.test.ts` shows the pattern. Every expected value is **hand-worked**: computed step by step in a comment from a short close series, or taken from a published worked example, never by running the same formula a second time.

Cover: defaults and a non-default setting, the first value after warm-up and the bars before it (`null`), each smoothing seed, shifts, the rising/falling switch including equality, a series shorter than the warm-up, and exact output times.

Run `npx tsx --test "indicators/<slug>/*.test.ts"` and `npm run typecheck` (it covers `indicators/`).

**Gate:** the tests pass, and each behaviour in the README has a test or a stated reason it has none.

## 5. Check against MT4's Data Window

Parity is proven only by MT4's own numbers. Ask the trader to:

1. put the original indicator on an MT4 chart with the package's default parameters, on a symbol and period the app has a feed for;
2. pick three **closed** bars well past the warm-up, with the newest within the last 900 bars;
3. for each, copy from the Data Window (Ctrl+D, pointer on the bar): the bar's date and time, its close, and every value of the indicator.

Install the gate 3 ZIP through the Indicators page in the app window, then read the package's values at those bar times: through REST (`GET /api/v1/indicators/<id>/<symbol>?period=<period>`, see `docs/rest-api.md`; `time` there is broker time, as MT4's Data Window shows) with a read key the trader puts in an environment variable, or by asking the trader to read the chart legend with the crosshair on each bar. Check first that the closes agree, so both sides see the same bars. Compare to the market's digits; a difference in the last digit is rounding, anything more is a mismatch to explain or fix before going on. Add the three bars as a test labelled "MT4 Data Window".

**Gate:** every value agrees, or the trader has seen each difference and accepted it. Without the trader's values, report the package as converted but unchecked against MT4.

## 6. Build the ZIP

Run `npm run indicator-package -- indicators/<slug>` once more, after the last change. It writes `build/<id>-<version>.zip` and prints the SHA-256 over the four files. A file changed after a ZIP was installed anywhere (gate 5's included) needs a new version, or the app refuses the new ZIP.

**Done:** report the package folder, the ZIP and its SHA-256, the tests run, the Data Window check's result (or that it was not done), provenance and licence, and every difference from the source. Installing it into the trader's app is the trader's step unless they asked for it.
