// EO, converted from EO.mq4 by Yuexin Zhu (see README.md): the fast EMA of the close less the slow one, smoothed by an
// EMA of `signal` bars, then averaged over two bars. Each EMA starts at the first close, as the source's do, and EO
// shows once max(fast, slow) + signal closes exist; nothing shows on 34 bars or fewer, the source's own guard. The
// histogram repeats EO from its second value on: rising when EO is higher than the bar before, falling when lower or
// unchanged. The package gets closed bars only (its manifest says so): the source never draws the forming bar.
exports.calculate = function ({ inputs, parameters: p, timeline }) {
  const closes = inputs.source.points.map((point) => point.value);
  const eo = timeline.map((time) => ({ time, value: null }));
  const histogram = timeline.map((time) => ({ time, value: null }));
  if (closes.length <= 34) return { outputs: { histogram, eo } };

  const fastK = 2 / (p.fast + 1);
  const slowK = 2 / (p.slow + 1);
  const signalK = 2 / (p.signal + 1);
  const shown = Math.max(p.fast, p.slow) + p.signal;
  let fast = closes[0];
  let slow = closes[0];
  let signal = 0;
  let previous = null;
  for (let i = 0; i < closes.length; i++) {
    const before = signal;
    if (i > 0) {
      fast += fastK * (closes[i] - fast);
      slow += slowK * (closes[i] - slow);
      // The source's "SignalSMA" is an EMA.
      signal += signalK * (fast - slow - signal);
    }
    if (i + 1 < shown) continue;
    const value = (before + signal) / 2;
    eo[i].value = value;
    if (previous !== null) {
      histogram[i].value = value;
      histogram[i].styleKey = value > previous ? "rising" : "falling";
    }
    previous = value;
  }
  return { outputs: { histogram, eo } };
};
