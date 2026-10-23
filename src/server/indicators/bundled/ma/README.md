# Moving average

The moving average of the close, drawn on the price pane, as MetaTrader's Moving Average.

## Parameters

| Parameter | Range  | Default | Meaning                                  |
| --------- | ------ | ------- | ---------------------------------------- |
| Period    | 1–500  | 20      | The number of closes averaged.           |
| Type      | choice | Simple  | Simple (SMA) or Exponential (EMA).       |

## Formula

- **Simple:** the mean of the last *period* closes.
- **Exponential:** the first value is the simple average of the first *period* closes; each later one is
  `close × k + previous × (1 − k)`, with `k = 2 / (period + 1)`.

There is no value until *period* bars exist. The app hands the package *period* + 499 bars of warm-up before the first
bar shown, so an exponential average has settled by then.

## Licence

MIT. See `LICENSE`.
