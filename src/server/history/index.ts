// History (server): MetaTrader's HST files read in place, the app's saved copy of them, and the chart history joined
// from both and the live candles.
export { ChartHistory, PERIOD_MINUTES, PERIOD_OF } from "./chart-history.js";
export type { BrokerHistoryPage, ChartHistoryOptions, HistoryPage } from "./chart-history.js";
export { ANSWER_TIMEOUT_MS, EaBarFetcher, LOADING_RETRY_MS } from "./ea-bars.js";
export type { EaBarFetcherOptions } from "./ea-bars.js";
export { CSV_HEADER, csvRows, HistoryCatalog } from "./history-catalog.js";
export { HistorySaver, SAVE_CHECK_MS, SAVE_EVERY_MS } from "./history-saver.js";
export type { HistorySaverOptions, SaveProgress } from "./history-saver.js";
export { SavedBarStore } from "./saved-store.js";
export type { SavedBar, SavedSpan } from "./saved-store.js";
export type { HistoryMarket, HistoryPeriod, HistorySeries, HistorySpan } from "./history-catalog.js";
export { HstFile, hstHeaderBytes, hstPath, hstRecordBytes } from "./hst-file.js";
export type { HstBar, HstHeader, HstPage } from "./hst-file.js";
