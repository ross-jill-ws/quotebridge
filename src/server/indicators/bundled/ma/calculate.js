// Moving average (simple or exponential) of the close: one value per bar, null until there are enough bars.
// An exponential average starts from the simple average of its first `period` closes, as MetaTrader's does.
exports.calculate = function ({ inputs, parameters, timeline }) {
  const closes = inputs.source.points.map((p) => p.value);
  const period = parameters.period;
  const exponential = parameters.type === "exponential";
  const values = closes.map(() => null);
  if (closes.length >= period) {
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    values[period - 1] = sum / period;
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) {
      if (exponential) {
        values[i] = closes[i] * k + values[i - 1] * (1 - k);
      } else {
        sum += closes[i] - closes[i - period];
        values[i] = sum / period;
      }
    }
  }
  return { outputs: { ma: timeline.map((time, i) => ({ time, value: values[i] })) } };
};
