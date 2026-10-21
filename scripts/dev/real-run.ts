// `npm run dev -- --real`: real terminals are the developer's own, often managed by the installed app
// too. A dev run installs into them only when the developer clicks Install or Recompile on a card.
import { access } from "node:fs/promises";
import type { TerminalManagerOptions } from "../../src/server/terminals/index.js";
import { SettingsStore } from "../../src/shared/settings-store.js";

export const REAL_TERMINALS_WARNING =
  "Development run on your real MetaTrader terminals: Install, Recompile and Remove change their bridge files, as the installed app does.";

/**
 * Seeds a --real dev data folder that has no settings yet: setup completed, no managed or declined
 * terminals, so no setup screen offers every terminal pre-ticked and nothing is updated on start.
 * Existing settings are left exactly as they are. Returns true when it seeded.
 */
export async function seedRealRunSettings(dataFolder: string): Promise<boolean> {
  const store = new SettingsStore(dataFolder);
  try {
    await access(store.file);
    return false;
  } catch {
    // No settings yet.
  }
  await store.update((s) => {
    s.setupCompleted = true;
    s.managedTerminals = [];
    s.declinedTerminals = [];
    s.startWithWindows = false;
  });
  return true;
}

/** The terminal manager's options in a --real run: the Terminals view warns that the terminals are real. */
export function realTerminalOptions(options: TerminalManagerOptions): TerminalManagerOptions {
  return { ...options, warning: REAL_TERMINALS_WARNING };
}
