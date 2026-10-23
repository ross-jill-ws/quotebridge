# MACD

Moving Average Convergence/Divergence of the close, in its own pane, as MetaTrader's MACD: bars of one colour and a
signal line.

## Parameters

| Parameter  | Range | Default | Meaning                                    |
| ---------- | ----- | ------- | ------------------------------------------ |
| Fast EMA   | 1–500 | 12      | The fast average's period; below Slow EMA. |
| Slow EMA   | 1–500 | 26      | The slow average's period.                 |
| Signal SMA | 1–500 | 9       | The MACD values the signal averages.       |

## Formula

- **MACD:** `EMA(close, fast) − EMA(close, slow)`. Each EMA starts from the simple average of its first *period*
  closes, then `close × k + previous × (1 − k)`, with `k = 2 / (period + 1)`.
- **Signal:** the **simple** average of the last *signal* MACD values. MetaTrader uses a simple average here; many
  other platforms use an exponential one, so their signal lines differ.

There is no MACD until *slow* bars exist, and no signal until *signal* MACD values exist. The app hands the package
*slow* + 499 bars of warm-up before the first bar shown, so the averages have settled by then.

## Licence

MIT. See `LICENSE`.
