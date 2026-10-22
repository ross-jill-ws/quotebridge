// The design tokens the chart's canvas needs, as [light, dark] pairs. app.css defines the same tokens with
// light-dark(); a test fails if the two differ, so a colour is changed in both places or the tests say so. (A custom
// property holding light-dark() computes to that text, not to a colour, so the canvas cannot read it at run time.)
export const COLOUR_TOKENS = {
  ink: ["#131a38", "#e3e8f4"],
  "ink-2": ["#4a5370", "#a6b0c8"],
  "ink-3": ["#6e7790", "#78839e"],
  surface: ["#ffffff", "#111a2e"],
  line: ["#d6dbe8", "#222f4a"],
  "line-soft": ["#e7ebf3", "#1a2640"],
  downtick: ["#d42a3f", "#ff5e6e"],
  "uptick-vivid": ["#00a86b", "#2ee6a0"],
  "downtick-vivid": ["#e5384f", "#ff5e6e"],
  "series-gold": ["#b7791f", "#e8b44a"],
  "series-azure": ["#2f6fb3", "#6aa8ea"],
  "series-violet": ["#7a4cc2", "#b08cf0"],
  "series-slate": ["#4a5568", "#a3afc2"],
} as const satisfies Record<string, readonly [string, string]>;

export type ColourToken = keyof typeof COLOUR_TOKENS;
