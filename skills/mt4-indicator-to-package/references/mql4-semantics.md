# MQL4 semantic checklist

Read during gate 2. Answer every item for the indicator at hand and write the answers in the package README, so a later agent can audit the conversion without the trader's MT4.

## Prices and averages

- Trace each `iMA`, `iMAOnArray`, `iRSI`, `iStdDev` and similar call: symbol, timeframe, period, shift, method, applied price. `MODE_SMA`, `MODE_EMA`, `MODE_SMMA` and `MODE_LWMA` are different recurrences. A name such as `SignalSMA` is not proof of the method: the call is.
- Applied prices: `PRICE_CLOSE` maps to `field: "close"`, `PRICE_MEDIAN` to `field: "median"`. `PRICE_OPEN`, `PRICE_HIGH`, `PRICE_LOW`, `PRICE_TYPICAL` and `PRICE_WEIGHTED` are unsupported (gate 1).
- **Seeds.** MT4's built-in `iMA` EMA starts from the SMA of its first `period` values; SMMA likewise (the Alligator). A hand-written EMA loop in the source often starts from the first value instead (EO does). For `iMAOnArray`, MetaQuotes documents no seed, and it runs over the whole array, including slots the source never wrote: choose a seed from the first value the source did write, mark it unverified in the README, and let gate 5 decide. Write down each stage's seed and the warm-up that makes it settle; after enough warm-up, seeds stop mattering.
- **Unwritten values.** Indicator buffers start filled with their empty value (`EMPTY_VALUE` unless `SetIndexEmptyValue` sets another); arrays of the source's own start at 0 only once `ArrayInitialize`d. A comparison or average that reaches an unwritten slot (the oldest bar's `[i + 1]`) is suspicious behaviour: give the first value a defined result and record it.
- Follow every `iCustom`, `#include`, global and `static` variable and recursive buffer in dependency order. A centred or forward-looking filter repaints: disclose it, never make it causal silently.

## Indexing

- MQL4 series index 0 is the **newest** bar; a package's `points[0]` is the **oldest**. Convert each `[i + k]` by direction (`i + k` in MQL4 is `k` bars older), not by copying loop bounds.
- Check `ArraySetAsSeries`, and the order of `SetIndexBuffer` calls against `SetIndexStyle`/`SetIndexLabel`.
- `IndicatorCounted()`, `prev_calculated` and `rates_total` only schedule work: the package gets every bar on each call and recomputes from scratch. Check whether the loops ever reach index 0, the forming bar: when they never do, set `closedBarsOnly`.
- Hard-coded guards (`if (Bars <= 34) return;`) set when values start; keep their effect, and say so in the README.
- `EMPTY_VALUE` and unset buffer slots become `null`. Zero is a real value.
- `SetIndexShift(n, k)` moves a buffer `k` bars forward: the value computed at a bar appears at the bar `k` later. Map it onto existing bar times only; the values that would land past the last bar are dropped (the bundled Alligator does this).
- `SetIndexDrawBegin(n, k)`: buffer `n` has `null` on its first `k` bars of the whole series. Bars the warm-up hands the package come first, so when the warm-up is at least `k`, this is already the case on every bar shown; still write the `null`s, for short series.

## Drawing

- List every `SetIndexBuffer`, `SetIndexStyle`, `SetIndexLabel`, colour and width. `DRAW_NONE` buffers and buffers only used by others are internal, not outputs.
- `#property indicator_chart_window` maps to `placement: "overlay"`, `indicator_separate_window` to `"pane"`. Every output of a package shares one placement.
- `DRAW_LINE` maps to a line, `DRAW_HISTOGRAM` to a histogram. `DRAW_ARROW`, `DRAW_SECTION`, `DRAW_ZIGZAG`, fills and objects are unsupported (gate 1).
- **Split histograms.** Two `DRAW_HISTOGRAM` buffers of different colours, each filled only where the other is empty, merge into one histogram output with a `rising`/`falling` palette. Find the switch (slope against the bar before, the sign, a crossover) and how equality falls: EO puts equality in falling. Name the switch in the README; the chart draws `rising` in Uptick and `falling` in Downtick, whatever the source's colours, and the trader can swap them from the legend.
- `SetLevelValue`, `IndicatorSetDouble(INDICATOR_LEVELVALUE, …)` and `#property indicator_levelN` map to `levels` (a level at 0 on a histogram's pane is left out: the chart draws its zero line already); `IndicatorMinimum`/`IndicatorMaximum` and `#property indicator_minimum`/`indicator_maximum` to `range`. A source that never computes the forming bar sets `closedBarsOnly` (Indexing, above). `IndicatorDigits` has no counterpart: the chart uses the market's digits, or 2 decimals with a `range`.

## The README's Mapping section

A table with one row per buffer, then the other decisions as lists, each item with its reason:

```markdown
## Mapping

| Buffer (MQL4)        | Drawn as            | Output    | Decision                              |
| -------------------- | ------------------- | --------- | ------------------------------------- |
| 0 `UpBuffer`         | DRAW_HISTOGRAM      | `distance` | merged: `rising` style                |
| 3 `DistBuffer`       | DRAW_NONE           | —         | internal                              |

- **Parameters:** each `extern`/`input` → parameter id, default, range (and any cap the source lacks).
- **Source price, averages and seeds:** each stage, its method and seed, marked verified or unverified.
- **Indexing, shifts, draw-begin, forming bar:** what each became.
- **Warm-up:** the `history` declared and why it suffices.
- **Suspicious source behaviour:** each one, and what the package does instead or why it copies it.
- **Differences:** every intentional difference from MT4's output, and who agreed to it.
```

A behaviour belongs in one list: as a difference if the package's output differs from MT4's for it, else as suspicious behaviour or a plain mapping.

## Worked example

`src/server/indicators/bundled/eo/README.md`: five buffers (hidden MACD and temporary EMA, the visible EO line, and two slope-coloured histograms) became two outputs; `SignalSMA` sets an EMA; the hand-written EMAs start at their first value; equality falls; the loops skip the forming bar (`closedBarsOnly`); the hard-coded 34-bar guard is kept.
