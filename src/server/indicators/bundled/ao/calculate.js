// Bill Williams' Awesome Oscillator, as MetaTrader's: the fast simple average of the median price less the slow one,
// as bars. A bar higher than the one before is rising, a lower one falling, and an unchanged one keeps the colour
// before it (the first is rising). Null until there are enough bars.
exports.calculate = function ({ inputs, parameters: p, timeline }) {
  const medians = inputs.source.points.map((point) => point.value);
  const sma = (period) =>
    medians.map((_, i) => {
      if (i < period - 1) return null;
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += medians[j];
      return sum / period;
    });
  const fast = sma(p.fast);
  const slow = sma(p.slow);
  const ao = medians.map((_, i) => (fast[i] === null || slow[i] === null ? null : fast[i] - slow[i]));
  let rising = true;
  return {
    outputs: {
      ao: timeline.map((time, i) => {
        if (ao[i] === null) return { time, value: null };
        const before = ao[i - 1];
        if (before !== null && before !== undefined && ao[i] !== before) rising = ao[i] > before;
        return { time, value: ao[i], styleKey: rising ? "rising" : "falling" };
      }),
    },
  };
};
