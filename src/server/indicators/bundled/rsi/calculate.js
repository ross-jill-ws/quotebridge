// RSI (0–100) of the close with Wilder's smoothing, as MetaTrader's: the first average gain and loss are the means of
// the first `period` changes, then each is (previous × (period − 1) + current) / period. 100 when there were no losses,
// 50 when the price never moved; null until `period` changes exist.
exports.calculate = function ({ inputs, parameters, timeline }) {
  const closes = inputs.source.points.map((p) => p.value);
  const period = parameters.period;
  const values = closes.map(() => null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const up = Math.max(change, 0);
    const down = Math.max(-change, 0);
    if (i <= period) {
      gain += up / period;
      loss += down / period;
      if (i < period) continue;
    } else {
      gain = (gain * (period - 1) + up) / period;
      loss = (loss * (period - 1) + down) / period;
    }
    values[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return { outputs: { rsi: timeline.map((time, i) => ({ time, value: values[i] })) } };
};
