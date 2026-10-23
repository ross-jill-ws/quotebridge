# Accelerator Oscillator

Bill Williams' Accelerator Oscillator (AC), in its own pane, as MetaTrader's: bars coloured by whether they rose or
fell.

## Parameters

| Parameter  | Range | Default | Meaning                                    |
| ---------- | ----- | ------- | ------------------------------------------ |
| Fast SMA   | 1–500 | 5       | AO's fast average; below Slow SMA.         |
| Slow SMA   | 1–500 | 34      | AO's slow average.                         |
| Signal SMA | 1–500 | 5       | The AO values averaged and taken from AO.  |

## Formula

The median price is (high + low) / 2. AO is `SMA(median, fast) − SMA(median, slow)`, and AC is
`AO − SMA(AO, signal)`.

A bar higher than the one before is **rising** (drawn in Uptick), a lower one **falling** (Downtick), and an unchanged
one keeps the colour of the bar before it, as MetaTrader draws it. The first bar is rising. Swap the two colours from
the chart's legend.

There is no value until *slow* + *signal* − 1 bars exist. The app hands the package *slow* + 499 bars of warm-up
before the first bar shown, which covers every signal period.

## Licence

MIT. See `LICENSE`.
