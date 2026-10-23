# Awesome Oscillator

Bill Williams' Awesome Oscillator (AO), in its own pane, as MetaTrader's: bars coloured by whether they rose or fell.

## Parameters

| Parameter | Range | Default | Meaning                                       |
| --------- | ----- | ------- | --------------------------------------------- |
| Fast SMA  | 1–500 | 5       | The fast average's period; below Slow SMA.    |
| Slow SMA  | 1–500 | 34      | The slow average's period.                    |

## Formula

The median price is (high + low) / 2. AO is `SMA(median, fast) − SMA(median, slow)`.

A bar higher than the one before is **rising** (drawn in Uptick), a lower one **falling** (Downtick), and an unchanged
one keeps the colour of the bar before it, as MetaTrader draws it. The first bar is rising. Swap the two colours from
the chart's legend.

There is no value until *slow* bars exist. Nothing depends on older bars, so the app hands the package exactly *slow*
bars of warm-up before the first bar shown.

## Licence

MIT. See `LICENSE`.
