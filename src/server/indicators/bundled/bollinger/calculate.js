// Bollinger bands of the close, as MetaTrader's Bands: the simple average of `period` closes, and the bands that many
// population standard deviations (divided by n, not n − 1) times `deviations` above and below it. Null until there
// are enough bars.
exports.calculate = function ({ inputs, parameters, timeline }) {
  const closes = inputs.source.points.map((p) => p.value);
  const { period, deviations } = parameters;
  const middle = [];
  const upper = [];
  const lower = [];
  for (let i = 0; i < closes.length; i++) {
    const time = timeline[i];
    if (i < period - 1) {
      middle.push({ time, value: null });
      upper.push({ time, value: null });
      lower.push({ time, value: null });
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let squares = 0;
    for (let j = i - period + 1; j <= i; j++) squares += (closes[j] - mean) ** 2;
    const band = Math.sqrt(squares / period) * deviations;
    middle.push({ time, value: mean });
    upper.push({ time, value: mean + band });
    lower.push({ time, value: mean - band });
  }
  return { outputs: { middle, upper, lower } };
};
