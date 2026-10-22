// The chart's colours (pure). The canvas draws with explicit colours, so the scheme is built from the design
// tokens (colour-tokens.ts, kept equal to app.css's) for each theme: Default follows the light or dark theme; Green on
// black is MetaTrader's classic preset and the same in both. Indicator lines always take the series palette, never a
// price colour.
import type { ChartColours } from "../../shared/settings-store.js";
import { COLOUR_TOKENS, type ColourToken } from "../colour-tokens.js";

export type ColourMode = "light" | "dark";

export type CandleColours = { body: string; wick: string; border: string };

export type ChartScheme = {
  canvas: string;
  /** Scale and legend text. */
  text: string;
  /** Emphasised legend text (the title). */
  strong: string;
  /** The faint horizontal grid; equal to the canvas when there is none. */
  grid: string;
  /** Scale borders, pane separators and day separators. */
  line: string;
  /** The crosshair's dashed lines. */
  crosshair: string;
  /** The background of the crosshair's labels on the scales. */
  crosshairLabel: string;
  up: CandleColours;
  down: CandleColours;
  /** The line chart, and the price in Green on black. */
  price: string;
  /** The background of the current Bid's label. */
  bidLabel: string;
  /** The dashed Ask line. */
  ask: string;
  /** Indicator levels (RSI's 30 and 70). */
  level: string;
  /** Gold, azure, violet, slate: indicators take them in order. */
  series: readonly [string, string, string, string];
};

const filled = (colour: string): CandleColours => ({ body: colour, wick: colour, border: colour });

/** Indicator levels: fainter than the tertiary ink, not a token of their own. */
const LEVEL: Record<ColourMode, string> = { light: "#a0aabb", dark: "#4a5872" };

/** Default: the canvas is the surface, candles are Uptick and Downtick vivid, the Ask line is Downtick. */
function tokenScheme(mode: ColourMode): ChartScheme {
  const token = (name: ColourToken) => COLOUR_TOKENS[name][mode === "light" ? 0 : 1];
  return {
    canvas: token("surface"),
    text: token("ink-2"),
    strong: token("ink"),
    grid: token("line-soft"),
    line: token("line"),
    crosshair: token("ink-3"),
    crosshairLabel: token("ink"),
    up: filled(token("uptick-vivid")),
    down: filled(token("downtick-vivid")),
    price: token("ink"),
    bidLabel: token("ink"),
    ask: token("downtick"),
    level: LEVEL[mode],
    series: [token("series-gold"), token("series-azure"), token("series-violet"), token("series-slate")],
  };
}

const DEFAULT: Record<ColourMode, ChartScheme> = { light: tokenScheme("light"), dark: tokenScheme("dark") };

/** Bull bars hollow (black body), bear bars filled white, green outlines and price. */
const GREEN_ON_BLACK: ChartScheme = {
  canvas: "#000000",
  text: "#c0c0c0",
  strong: "#ffffff",
  grid: "#000000",
  line: "#333333",
  crosshair: "#808080",
  crosshairLabel: "#c0c0c0",
  up: { body: "#000000", wick: "#00ff00", border: "#00ff00" },
  down: { body: "#ffffff", wick: "#00ff00", border: "#00ff00" },
  price: "#00ff00",
  bidLabel: "#00ff00",
  ask: "#ff7d69",
  level: "#808080",
  series: DEFAULT.dark.series,
};

export function chartScheme(colours: ChartColours, mode: ColourMode): ChartScheme {
  return colours === "green-on-black" ? GREEN_ON_BLACK : DEFAULT[mode];
}
