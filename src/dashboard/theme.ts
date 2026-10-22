// The page's theme: app.css takes its colours from `data-theme` on <html> when Light or Dark is
// forced, and from the colour-scheme media query otherwise. In the app window main also sets
// `nativeTheme.themeSource`; the attribute makes a browser outside the window follow the setting too.
import type { Theme } from "../shared/settings-store.js";

/** The last theme the page applied, so the next load starts in it before the settings arrive. */
const REMEMBERED = "quotebridge.theme";

export function themeAttribute(theme: Theme): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}

export function applyTheme(theme: Theme) {
  const attribute = themeAttribute(theme);
  if (attribute) document.documentElement.dataset.theme = attribute;
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(REMEMBERED, theme);
  } catch {
    // Storage may be unavailable; the saved setting still applies once it is read.
  }
}

export function applyRememberedTheme() {
  try {
    const theme = localStorage.getItem(REMEMBERED);
    if (theme === "system" || theme === "light" || theme === "dark") applyTheme(theme);
  } catch {
    // As above.
  }
}
