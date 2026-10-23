# Alligator

Bill Williams' Alligator on the price pane, as MetaTrader's: three smoothed moving averages of the median price, each
shifted forward onto later bars.

## Parameters

| Parameter    | Range | Default | Meaning                                        |
| ------------ | ----- | ------- | ---------------------------------------------- |
| Jaw period   | 1–500 | 13      | The medians the jaw (blue in MT4) smooths.     |
| Jaw shift    | 0–100 | 8       | The bars the jaw is moved forward.             |
| Teeth period | 1–500 | 8       | The medians the teeth (red in MT4) smooth.     |
| Teeth shift  | 0–100 | 5       | The bars the teeth are moved forward.          |
| Lips period  | 1–500 | 5       | The medians the lips (green in MT4) smooth.    |
| Lips shift   | 0–100 | 3       | The bars the lips are moved forward.           |

## Formula

The median price is (high + low) / 2. Each line is its SMMA: the first value is the simple average of the first
*period* medians, and each later one is `(previous × (period − 1) + median) / period`. The value computed at a bar is
drawn *shift* bars later.

MetaTrader draws the shifted lines past the last bar, into the future. This package does not: each line stops at the
last bar, and its last *shift* values wait for the bars to come.

The app hands the package 1,200 bars of warm-up before the first bar shown, so the smoothing has settled by then.

## Licence

MIT. See `LICENSE`.
