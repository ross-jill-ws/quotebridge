// Bundled works and their licences, for About › Licences. Each text ships with the dashboard under
// `licences/` (scripts/dashboard-build.ts copies them; the release check proves they are in the package).
import { APP_NAME } from "./app-identity.js";

export type BundledWork = {
  name: string;
  /** Its licence, and what it is where that needs saying: "MIT License". */
  licence: string;
  /** Licence and notice texts, as dashboard paths. */
  texts: { label: string; path: string }[];
  /** A link the licence asks for. */
  link?: { label: string; url: string };
};

/** The attribution Lightweight Charts' licence asks for (its NOTICE file and a link to tradingview.com). */
export const TRADINGVIEW_URL = "https://www.tradingview.com/";

export const BUNDLED_WORKS: readonly BundledWork[] = [
  { name: APP_NAME, licence: "MIT License", texts: [{ label: "Licence", path: "licences/QuoteBridge-LICENSE.txt" }] },
  {
    name: "libzmq",
    licence: "ZeroMQ, bundled for the QuoteBridge EA. Mozilla Public License 2.0, built from unmodified upstream source; its notices ship beside the DLL",
    texts: [],
  },
  { name: "Preact", licence: "MIT License", texts: [{ label: "Licence", path: "licences/Preact-LICENSE.txt" }] },
  { name: "Archivo", licence: "typeface, © 2020 The Archivo Project Authors. SIL Open Font License 1.1", texts: [{ label: "Licence", path: "licences/Archivo-OFL.txt" }] },
  {
    name: "TradingView Lightweight Charts™",
    licence: "© 2025 TradingView, Inc. Apache License 2.0",
    texts: [
      { label: "Notice", path: "licences/lightweight-charts-NOTICE.txt" },
      { label: "Licence", path: "licences/lightweight-charts-LICENSE.txt" },
    ],
    link: { label: "tradingview.com", url: TRADINGVIEW_URL },
  },
];

/** Every licence text the dashboard must carry. */
export const LICENCE_TEXTS: readonly string[] = BUNDLED_WORKS.flatMap((w) => w.texts.map((t) => t.path));
