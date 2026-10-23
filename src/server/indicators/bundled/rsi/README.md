# RSI

The Relative Strength Index of the close, in its own pane on a fixed 0–100 scale, with dashed levels at 30 and 70, as
MetaTrader's RSI.

## Parameters

| Parameter | Range | Default | Meaning                         |
| --------- | ----- | ------- | ------------------------------- |
| Period    | 1–500 | 14      | The number of changes smoothed. |

## Formula

Wilder's smoothing: the first average gain and loss are the means of the first *period* changes of the close; each
later one is `(previous × (period − 1) + current) / period`. RSI is `100 − 100 / (1 + gain / loss)`: 100 when there
were no losses, 50 when the price never moved.

There is no value until *period* changes exist. The app hands the package *period* + 499 bars of warm-up before the
first bar shown, so the smoothing has settled by then.

## Licence

MIT. See `LICENSE`.
