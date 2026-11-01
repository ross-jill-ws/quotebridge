# Indicator packages

Every indicator on a chart, and every indicator value the REST API answers, comes from an **indicator package**: a
small ZIP with a manifest and a JavaScript calculation. The app ships eight (Moving average, RSI, Bollinger, MACD, AO,
AC, Alligator and EO); you can install your own from the Indicators page. This page is the format, for writing a
package by hand. To convert an MT4 indicator, see [Converting an MT4 indicator](#converting-an-mt4-indicator).

The app computes a package's values in the server, in a sandbox, and serves the same values to every chart and to
REST. A package sees only its bars and its parameters, so its output depends on nothing else.

## The files

A package is exactly four files, at the root of a ZIP:

| File            | What it holds                                                          |
| --------------- | ---------------------------------------------------------------------- |
| `manifest.json` | What the package is: its ID, version, parameters, outputs and drawing. |
| `calculate.js`  | The calculation.                                                       |
| `README.md`     | What it computes, for the Indicators page.                             |
| `LICENSE`       | Its licence text.                                                      |

- The ZIP is at most 2 MiB, and each file at most 256 KB of UTF-8 text.
- Nothing else may be in the ZIP: no folders, other files, links, encryption or ZIP64. Use a plain ZIP (deflate or stored).
- `npm run indicator-package -- <folder>` builds the ZIP from a folder with the four files (see
  [Installing](#installing)).

## manifest.json

Format apiVersion 1, the legacy QuoteBridge server's, so its packages load unchanged. Any field not listed here is
refused.

| Field            | Required | Value                                                                                                         |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `apiVersion`     | yes      | `1`.                                                                                                          |
| `id`             | yes      | Lowercase letters, digits, dots or hyphens, starting with a letter, up to 100. Use a prefix of your own (`acme.momentum`); the bundled packages' IDs start with `quotebridge.`. |
| `version`        | yes      | `major.minor.patch`, such as `1.2.0`. See [Versions](#versions).                                              |
| `name`           | yes      | The name on menus and in the legend, up to 80 characters.                                                     |
| `description`    | yes      | One or two sentences, up to 2000 characters.                                                                  |
| `license`        | yes      | The licence's name, such as `MIT`, up to 100 characters. The text goes in `LICENSE`.                          |
| `entry`          | yes      | `"calculate.js"`.                                                                                             |
| `inputs`         | yes      | Exactly one input, the source (below).                                                                        |
| `parameters`     | yes      | Up to 12 parameters (below); `[]` for none.                                                                   |
| `outputs`        | yes      | 1 to 8 outputs (below).                                                                                       |
| `closedBarsOnly` | no       | `true`: the package never gets the bar still forming. Its values appear as each bar closes.                   |
| `levels`         | no       | Up to 8 numbers, drawn as dashed horizontal lines on the package's pane (RSI's `[30, 70]`).                   |
| `range`          | no       | `{ "min": 0, "max": 100 }`: a fixed scale for the package's pane. Its values then read with 2 decimals.       |

`levels` and `range` need outputs placed in a pane.

### The input

```json
{ "id": "source", "label": "Close", "kind": "numeric", "alignment": "exact", "field": "close", "history": { "bars": 50 } }
```

- `id` is `"source"`, `kind` `"numeric"` and `alignment` `"exact"`; `label` names the price (up to 80 characters).
- `field` is `close` (the default) or `median`, which is `(high + low) / 2`. These are the only two prices a package
  gets.
- `history` is the **warm-up**: how many bars the package needs before the first value it shows. The app hands it
  that many bars before the first bar on the chart (or the first REST asks for), so the first value shown is as
  correct as the last. It is either:
  - `{ "bars": 50 }`: a fixed number, 1 to 5000;
  - `{ "parameter": "period", "extra": 499 }`: an integer parameter (with `min` 1 or more) plus some bars, 5000 at most with the
    parameter at its maximum.

  An average that starts from its first value (an EMA, Wilder's smoothing) needs generous warm-up to settle: the
  bundled RSI and MACD declare their period plus 499.

### Parameters

A number parameter:

```json
{ "id": "fast", "label": "Fast EMA", "type": "integer", "default": 12, "min": 1, "max": 500, "lessThan": "slow" }
```

- `id`: starts with a lowercase letter, then letters, digits or `_` (`jawShift` is fine), up to 40.
- `label`: what the settings form shows.
- `type`: `integer` (whole numbers) or `number`.
- `default` within `min` and `max`. The settings form and REST refuse values outside them.
- `lessThan` (optional): another number parameter's ID. Its value must stay below that one's, by default too (MACD's
  fast period below its slow one).

A choice parameter, a list of labelled values:

```json
{ "id": "type", "label": "Type", "type": "choice", "default": "simple", "choices": [{ "value": "simple", "label": "Simple" }, { "value": "exponential", "label": "Exponential" }] }
```

- 1 to 16 choices. A `value` follows the output ID rule below; `calculate` gets the value, the form shows the label.

### Outputs

```json
{ "id": "macd", "label": "MACD", "kind": "numeric", "render": "histogram", "placement": "pane", "color": "#a3afc2", "unit": { "input": "source" } }
```

- `id`: lowercase letters, digits or `_`, starting with a letter, up to 40.
- `label`: what the legend shows. A package with one output is read by its name instead.
- `kind`: `"numeric"`. `unit`: `{ "input": "source" }`.
- `render`: `line` or `histogram`.
- `placement`: `overlay` (on the price) or `pane` (a pane of its own under the price). Every output of a package has
  the same placement.
- `color`: `#rrggbb`. Required, but the chart chooses the colours (see [What the chart draws](#what-the-chart-draws)).
- `palette` (histograms only, optional): up to 16 style keys, each named like an output ID, with a `#rrggbb` colour:
  `{ "rising": "#26a69a", "falling": "#ef5350" }`. A point picks one with its `styleKey`.
- `lineWidth` (1 to 4) and `lineStyle` (`solid`, `dashed`, `dotted`), lines only, optional: accepted for legacy
  packages; the chart draws every line at its own width, solid.

## calculate.js

The file sets `exports.calculate`, a function that takes the bars and the parameters and returns every output's
values:

```js
exports.calculate = function ({ inputs, parameters, timeline, asOf }) {
  const points = inputs.source.points; // [{ time, value }], oldest first
  return { outputs: { line: timeline.map((time, i) => ({ time, value: points[i].value })) } };
};
```

What it gets:

- `inputs.source.points`: one `{ time, value }` per bar, oldest first. `time` is the bar's open time in UTC seconds;
  `value` is its close, or its median price.
- `timeline`: the bars' times, the same as `points.map((p) => p.time)`.
- `parameters`: every parameter by ID, already checked against the manifest (in range, `lessThan` kept, a choice one
  of its values).
- `asOf`: the last bar's time.

The bars are the warm-up, then the bars a chart has loaded (or REST asked for). The last one is the bar still forming,
unless the package is `closedBarsOnly`. The package is called again, over every bar, whenever they change: when a
chart loads older bars, and at most once a second while the forming bar moves. Each call starts from nothing, so
compute everything from `points`.

What it returns: `{ outputs: { <output id>: [points] } }`, with every output the manifest lists and no other. Each
point is `{ time, value, styleKey? }`:

- `time` is one of the bars' times, in increasing order, at most one point per bar. Bars without a point have no value.
- `value` is a finite number, or `null` where the output has no value (during its warm-up, for instance). `0` is a
  real value.
- `styleKey` (optional) is one of the output's `palette` keys.

Anything else (a missing or extra output, a time out of order, `NaN` or `Infinity`, an unknown style key) is invalid
output, and the calculation fails.

## The sandbox

`calculate.js` runs in [QuickJS](https://bellard.org/quickjs/), a separate JavaScript engine, on a worker thread of
its own. Its output can depend only on its bars and its parameters:

- **500 ms** per call, a **32 MiB** heap, and a 1 MiB stack.
- At most 50,000 bars in one call.
- Standard JavaScript (`Math`, `JSON`, arrays, typed arrays, `Map`, …), without `Date` and `Math.random`.
- No `require` or `import`, no network, no files, no timers and no `console`. The file is one script: bundle anything
  it needs into it.

A call that runs too long, runs out of memory, throws or returns invalid output **fails**. The indicator's legend row then reads
"Failed" with the reason, and the chart keeps its last good values, greyed. REST answers `422` with the reason.

## What the chart draws

- A **line** joins its values. A **histogram** draws a bar from zero for each value, over a zero line.
- `overlay` outputs are drawn on the price. `pane` outputs get a pane of their own, one per indicator, which the
  trader can resize.
- `levels` are dashed lines on the pane, and `range` fixes its scale. A pane with a histogram already has a solid
  zero line, so it needs no level at 0.
- Values read in the market's digits, or with 2 decimals on a pane with a `range`.

Packages don't choose their colours; the chart does, from the trader's theme, so that indicators never look like price
direction:

- Each line, and each histogram of one colour, takes the series palette's least-used colour (gold, azure, violet,
  slate).
- A histogram whose `palette` has the keys `rising` and `falling` draws those bars in the chart's Uptick and Downtick
  colours, as on the candles. Give each of its points one of the two keys.
- Other palette keys are kept in the data (REST answers them in `styles`) but are drawn in the output's one
  colour.
- The trader can change any output's colour, or swap rising and falling, from the legend.

Arrows, markers, fills between lines, text, and values drawn past the last bar are not supported.

## Installing

1. Build the ZIP. In a working copy of this repository, put the four files in a folder and run
   `npm run indicator-package -- <folder>`. It makes the same checks as Install, runs the package once on test bars,
   and writes `build/<id>-<version>.zip`. Any ZIP tool works too, with the four files at the ZIP's root.
2. In the **app window**, open **Indicators** in the rail and click **Install package…**, or drop the ZIP on the page.
3. The app checks the ZIP, runs the package on test bars with its defaults, and shows its manifest, README and
   licence. Nothing is installed yet.
4. Click **Install**. A new package is enabled and appears in the chart's Indicators menu, after the bundled ones; a
   new version of an installed one keeps its switch, enabled or not.

A refused ZIP says why (a bad manifest, a missing file, too big, a failed trial run). On the same page you can disable
a package (it leaves the Indicators menu; charts using it read "Not available" until it is enabled again) and delete
an installed one. Bundled packages can be disabled but not deleted.

Only the app window can install, enable, disable or delete packages. A remote browser sees the Indicators page
read-only, and REST has no way to change packages.

## Versions

A package is its `id` plus its `version`, and the app keeps one version of each `id`.

- Installing a **newer** version replaces the installed one. The preview shows the old and new versions and the
  parameters added or removed. Charts keep the values of parameters that still exist; new ones take their defaults.
- Installing an **older** version asks a second time.
- The **same** version with different files is refused: a version always means the same four files (the app keeps a
  SHA-256 over them). Change the version with any change.
- A bundled package's ID (`quotebridge.ma`, `quotebridge.rsi`, `quotebridge.bollinger`, `quotebridge.macd`,
  `quotebridge.ao`, `quotebridge.ac`, `quotebridge.alligator`, `quotebridge.eo`) can't be used: those packages update
  only with the app.

## Converting an MT4 indicator

This repository has a skill for coding agents, `mt4-indicator-to-package` (in `skills/`), that converts an
`.mq4` indicator into a package: it checks the indicator can be converted, maps its buffers, writes the four files and
tests against values worked out by hand, then checks the result against values you copy from MT4's Data Window. Ask
your agent to convert the indicator and give it the `.mq4` file.

## Example

A histogram in its own pane of how far the close moved over the last `period` bars, coloured rising or falling
against the bar before.

### manifest.json

```json
{
  "apiVersion": 1,
  "id": "example.change",
  "version": "1.0.0",
  "name": "Close change",
  "description": "The close less the close a number of bars before, as bars rising or falling against the bar before.",
  "license": "MIT",
  "entry": "calculate.js",
  "inputs": [{ "id": "source", "label": "Close", "kind": "numeric", "alignment": "exact", "field": "close", "history": { "parameter": "period", "extra": 1 } }],
  "parameters": [{ "id": "period", "label": "Period", "type": "integer", "default": 10, "min": 1, "max": 500 }],
  "outputs": [
    {
      "id": "change",
      "label": "Change",
      "kind": "numeric",
      "render": "histogram",
      "placement": "pane",
      "color": "#26a69a",
      "palette": { "rising": "#26a69a", "falling": "#ef5350" },
      "unit": { "input": "source" }
    }
  ]
}
```

### calculate.js

```js
// The close less the close `period` bars before; null until that bar exists. Rising when higher than the bar
// before's value (the first value: when above zero), falling otherwise.
exports.calculate = function ({ inputs, parameters, timeline }) {
  const closes = inputs.source.points.map((point) => point.value);
  const n = parameters.period;
  let previous = 0;
  const change = timeline.map((time, i) => {
    if (i < n) return { time, value: null };
    const value = closes[i] - closes[i - n];
    const point = { time, value, styleKey: value > previous ? "rising" : "falling" };
    previous = value;
    return point;
  });
  return { outputs: { change } };
};
```

### README.md

```markdown
# Close change

The close less the close `period` bars before, as bars in their own pane: rising when higher than the bar before,
falling otherwise.
```

### LICENSE

```text
MIT License

Copyright (c) 2026 Example

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Worked by hand

With `period` 2 and the closes 1, 2, 4, 3, 3, 6:

| Bar | Close | Change    | Style   |
| --- | ----- | --------- | ------- |
| 1   | 1     | null      |         |
| 2   | 2     | null      |         |
| 3   | 4     | 4 − 1 = 3 | rising (above zero) |
| 4   | 3     | 3 − 2 = 1 | falling |
| 5   | 3     | 3 − 4 = −1 | falling |
| 6   | 6     | 6 − 3 = 3 | rising  |

This repository's tests install this example and check these values (`tests/indicator-packages-doc.test.ts`).
