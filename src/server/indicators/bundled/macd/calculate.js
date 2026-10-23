// MACD of the close, as MetaTrader's: the fast EMA less the slow EMA, drawn as one-colour bars, with a signal line that
// is the SIMPLE average of the last `signal` MACD values (MT4's convention, not the EMA other platforms use). Each EMA
// starts from the simple average of its first `period` closes. Null until there are enough bars.
exports.calculate = function ({ inputs, parameters: p, timeline }) {
  const closes = inputs.source.points.map((point) => point.value);
  const ema = (period) => {
    const values = closes.map(() => null);
    if (closes.length < period) return values;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    values[period - 1] = sum / period;
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) values[i] = closes[i] * k + values[i - 1] * (1 - k);
    return values;
  };
  const fast = ema(p.fast);
  const slow = ema(p.slow);
  const macd = closes.map((_, i) => (fast[i] === null || slow[i] === null ? null : fast[i] - slow[i]));
  const first = macd.findIndex((v) => v !== null);
  const signal = macd.map((_, i) => {
    if (first < 0 || i < first + p.signal - 1) return null;
    let sum = 0;
    for (let j = i - p.signal + 1; j <= i; j++) sum += macd[j];
    return sum / p.signal;
  });
  return {
    outputs: {
      macd: timeline.map((time, i) => ({ time, value: macd[i] })),
      signal: timeline.map((time, i) => ({ time, value: signal[i] })),
    },
  };
};
