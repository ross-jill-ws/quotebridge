// Bill Williams' Accelerator Oscillator, as MetaTrader's: AO (the fast simple average of the median price less the
// slow one) less the simple average of its last `signal` values, as bars. A bar higher than the one before is rising,
// a lower one falling, and an unchanged one keeps the colour before it (the first is rising). Null until there are
// enough bars.
exports.calculate = function ({ inputs, parameters: p, timeline }) {
  const medians = inputs.source.points.map((point) => point.value);
  const sma = (values, period) =>
    values.map((_, i) => {
      if (i < period - 1) return null;
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        if (values[j] === null) return null;
        sum += values[j];
      }
      return sum / period;
    });
  const fast = sma(medians, p.fast);
  const slow = sma(medians, p.slow);
  const ao = medians.map((_, i) => (fast[i] === null || slow[i] === null ? null : fast[i] - slow[i]));
  const signal = sma(ao, p.signal);
  const ac = ao.map((v, i) => (v === null || signal[i] === null ? null : v - signal[i]));
  let rising = true;
  return {
    outputs: {
      ac: timeline.map((time, i) => {
        if (ac[i] === null) return { time, value: null };
        const before = ac[i - 1];
        if (before !== null && before !== undefined && ac[i] !== before) rising = ac[i] > before;
        return { time, value: ac[i], styleKey: rising ? "rising" : "falling" };
      }),
    },
  };
};
