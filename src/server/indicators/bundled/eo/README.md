# EO

Yuexin Zhu's EO indicator, in its own pane: a line and a histogram of a smoothed MACD of the close. Converted from
`EO.mq4` by Yuexin Zhu (<http://blog.sina.com.cn/wordteller>), who allows it to ship with QuoteBridge under MIT.
`EO.mq4` itself is not bundled.

## Parameters

| Parameter  | Range | Default | MQL4 input  | Meaning                                    |
| ---------- | ----- | ------- | ----------- | ------------------------------------------ |
| Fast EMA   | 1–500 | 5       | `FastEMA`   | The fast EMA's period.                     |
| Slow EMA   | 1–500 | 34      | `SlowEMA`   | The slow EMA's period.                     |
| Signal EMA | 1–500 | 1       | `SignalSMA` | The EMA that smooths the difference.       |

Despite its MQL4 name, `SignalSMA` sets an **EMA**. Equal or reversed fast and slow periods are allowed, as in the
source.

## Formula

On the closes, oldest first:

```text
macd = EMA(close, fast) − EMA(close, slow)
temp = EMA(macd, signal)
eo   = (temp + temp of the bar before) / 2
```

- Each EMA starts at the first close and then moves `previous + 2 / (period + 1) × (value − previous)`, as the source's
  do.
- EO shows from the bar where max(fast, slow) + signal closes exist. With 34 bars or fewer, nothing shows: the source's
  own guard.
- The histogram repeats EO from its second value on: **rising** when EO is higher than the bar before, **falling** when
  it is lower or unchanged.

## Colours

The source draws rising bars red and falling ones green. QuoteBridge draws rising bars in Uptick and falling ones in
Downtick, as on the candles; swap the two from the chart's legend to see EO as in MetaTrader.

## Closed bars only

The package is computed on closed bars only (`closedBarsOnly`): the bar still forming has no value, and a bar's value
appears once it closes. The source draws the same way: its loops never reach the forming bar.

The app hands the package 2,000 bars of warm-up before the first bar shown, so the EMAs, which start at their first
close, have settled by then.

## Licence

MIT, © Yuexin Zhu. See `LICENSE`.
