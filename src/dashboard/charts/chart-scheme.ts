// The chart's colours (pure). The canvas draws with explicit colours, so the scheme carries the design
// tokens of app.css for each theme: Default follows the light or dark theme; Green on black is MetaTrader's
// classic preset and the same in both. Indicator lines always take the series palette, never a price colour.
import type { ChartColours } from "../../shared/settings-store.js";

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

const DEFAULT: Record<ColourMode, ChartScheme> = {
  light: {
    canvas: "#ffffff",
    text: "#4a5568",
    strong: "#172033",
    grid: "#eef1f5",
    line: "#d5dbe3",
    crosshair: "#7a8699",
    crosshairLabel: "#172033",
    up: filled("#0f7b53"),
    down: filled("#c2412d"),
    price: "#172033",
    bidLabel: "#172033",
    ask: "#c2412d",
    level: "#a0aabb",
    series: ["#b7791f", "#2f6fb3", "#7a4cc2", "#4a5568"],
  },
  dark: {
    canvas: "#131e31",
    text: "#a3afc2",
    strong: "#dce3ee",
    grid: "#1a2640",
    line: "#24314a",
    crosshair: "#74829a",
    crosshairLabel: "#dce3ee",
    up: filled("#3cc98e"),
    down: filled("#ff7d69"),
    price: "#dce3ee",
    bidLabel: "#dce3ee",
    ask: "#ff7d69",
    level: "#4a5872",
    series: ["#e8b44a", "#6aa8ea", "#b08cf0", "#a3afc2"],
  },
};

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
