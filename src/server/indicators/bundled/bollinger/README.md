# Bollinger Bands

The simple moving average of the close with a band above and below it, drawn on the price pane, as MetaTrader's
Bollinger Bands.

## Parameters

| Parameter  | Range    | Default | Meaning                                           |
| ---------- | -------- | ------- | ------------------------------------------------- |
| Period     | 1–500    | 20      | The number of closes averaged.                    |
| Deviations | 0.1–10   | 2       | How many standard deviations each band lies away. |

## Formula

- **Middle:** the mean of the last *period* closes.
- **Upper and Lower:** the middle plus and minus *deviations* × the **population** standard deviation of those closes
  (the squared differences from the mean divided by *period*, not *period* − 1), as MetaTrader computes it.

There is no value until *period* bars exist. Nothing depends on older bars, so the app hands the package exactly
*period* bars of warm-up before the first bar shown.

## Licence

MIT. See `LICENSE`.
