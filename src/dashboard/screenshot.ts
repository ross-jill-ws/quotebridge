// The page's side of a screenshot through the REST API (main captures the window): refuse while a dialog is open,
// else switch to the view (Feeds, or the Charts view on one feed), and answer once it has drawn, with the live link's
// state.
import { useEffect, useRef } from "preact/hooks";
import type { LiveLinkState, PageReady, ScreenshotTarget } from "../shared/server-host-protocol.js";
import { chartHash, type ChartState } from "./charts/chart-model.js";
import { native } from "./terminals/native.js";
import type { Live } from "./use-live.js";

/** How long the page waits for a chart to draw before the capture takes what is shown; within main's deadline. */
const CHART_WAIT_MS = 6000;

/** The open dialog's title (its labelling heading), or null when none is open. */
export function openDialog(doc: Document): string | null {
  const dialog = doc.querySelector("dialog[open]");
  if (!dialog) return null;
  const labelledBy = dialog.getAttribute("aria-labelledby");
  return (labelledBy ? doc.getElementById(labelledBy)?.textContent?.trim() : undefined) || dialog.getAttribute("aria-label") || "a dialog";
}

/** The window's address for a target; a chart's feed also becomes the window's remembered chart. */
export function screenshotHash(target: ScreenshotTarget): string {
  return target.view === "chart" ? chartHash(target.feed) : "#/feeds";
}

/** The Charts view as its section marks it (`data-chart`, `data-chart-feed`), or null before it renders. */
export type ChartMark = { state: ChartState | undefined; feed: string | undefined };

/**
 * Whether the chart of `feed` shows what it will: all of it drawn, no feeds at all, or that feed's chart while the
 * live link is down (nothing is fetched then).
 */
export function chartShown(chart: ChartMark | null, feed: string, live: LiveLinkState): boolean {
  if (chart?.state === "empty") return true;
  if (chart?.feed !== feed) return false;
  return live !== "live" || chart.state === "drawn";
}

/** Answers main's screenshot requests for as long as the app is shown (only in the app window). */
export function useScreenshots(live: Live, setupOpen: boolean) {
  const state = useRef({ live, setupOpen });
  state.current = { live, setupOpen };
  useEffect(() => {
    native()?.onScreenshot?.(async (target): Promise<PageReady> => {
      const dialog = openDialog(document);
      if (dialog) return { busy: dialog };
      // The setup screen stands in for every view until the user moves on.
      if (state.current.setupOpen) return { busy: "Set up QuoteBridge" };
      const hash = screenshotHash(target);
      if (location.hash !== hash) location.hash = hash;
      // The hashchange re-renders the view.
      await new Promise((r) => setTimeout(r, 0));
      if (target.view === "chart") await untilChartShown(target.feed, () => state.current.live.status);
      // Two frames later it has been drawn; main gives Chromium time to paint it all (SETTLE_MS) before capturing.
      await frame();
      await frame();
      return { ready: true, live: state.current.live.status };
    });
  }, []);
}

/**
 * Waits until the chart of `feed` shows what it will, or CHART_WAIT_MS, after which the capture takes what is shown.
 * It watches the page rather than polling: a minimised window's timers are throttled.
 */
function untilChartShown(feed: string, live: () => LiveLinkState) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const section = document.querySelector<HTMLElement>("section.view.charts");
      const mark = section && { state: section.dataset.chart as ChartState | undefined, feed: section.dataset.chartFeed };
      if (chartShown(mark, feed, live())) done();
    };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => done(), CHART_WAIT_MS);
    const done = () => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    observer.observe(document.body, { subtree: true, childList: true, attributeFilter: ["data-chart", "data-chart-feed"] });
    check();
  });
}

/** The next animation frame; a minimised window may not run frames, so a short timer stands in for it. */
function frame() {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
