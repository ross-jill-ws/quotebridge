// Bill Williams' Alligator, as MetaTrader's: the smoothed moving average (SMMA) of the median price for the jaw, teeth
// and lips, each shifted forward by its shift onto later bars. The SMMA starts from the simple average of its first
// `period` medians, then each is (previous × (period − 1) + median) / period. A shifted line stops at the last bar: no
// future bar times are made up.
exports.calculate = function ({ inputs, parameters: p, timeline }) {
  const medians = inputs.source.points.map((point) => point.value);
  const smma = (period) => {
    const values = medians.map(() => null);
    if (medians.length < period) return values;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += medians[i];
    values[period - 1] = sum / period;
    for (let i = period; i < medians.length; i++) values[i] = (values[i - 1] * (period - 1) + medians[i]) / period;
    return values;
  };
  const shifted = (values, shift) => timeline.map((time, i) => ({ time, value: i >= shift ? values[i - shift] : null }));
  return {
    outputs: {
      jaw: shifted(smma(p.jaw), p.jawShift),
      teeth: shifted(smma(p.teeth), p.teethShift),
      lips: shifted(smma(p.lips), p.lipsShift),
    },
  };
};
