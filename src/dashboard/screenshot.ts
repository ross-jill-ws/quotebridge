// The page's side of a screenshot through the REST API (main captures the window): refuse while a dialog is open,
// else switch to the view, and answer once it has drawn, with the live link's state.
import { useEffect, useRef } from "preact/hooks";
import type { PageReady } from "../shared/server-host-protocol.js";
import { native } from "./terminals/native.js";
import type { Live } from "./use-live.js";

/** The open dialog's title (its labelling heading), or null when none is open. */
export function openDialog(doc: Document): string | null {
  const dialog = doc.querySelector("dialog[open]");
  if (!dialog) return null;
  const labelledBy = dialog.getAttribute("aria-labelledby");
  return (labelledBy ? doc.getElementById(labelledBy)?.textContent?.trim() : undefined) || dialog.getAttribute("aria-label") || "a dialog";
}

/** Answers main's screenshot requests for as long as the app is shown (only in the app window). */
export function useScreenshots(live: Live, setupOpen: boolean) {
  const state = useRef({ live, setupOpen });
  state.current = { live, setupOpen };
  useEffect(() => {
    native()?.onScreenshot?.(async (view): Promise<PageReady> => {
      const dialog = openDialog(document);
      if (dialog) return { busy: dialog };
      // The setup screen stands in for every view until the user moves on.
      if (state.current.setupOpen) return { busy: "Set up QuoteBridge" };
      const hash = `#/${view}`;
      if (location.hash !== hash) location.hash = hash;
      // The hashchange re-renders the view; two frames later it has been painted.
      await new Promise((r) => setTimeout(r, 0));
      await frame();
      await frame();
      return { ready: true, live: state.current.live.status };
    });
  }, []);
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
