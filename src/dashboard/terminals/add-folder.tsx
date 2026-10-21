// Add folder: the native folder picker in the app window (ADR 2), a typed path in a browser.
import { useState } from "preact/hooks";
import type { TerminalView } from "../../server/terminals/index.js";
import { post } from "../api.js";
import { native } from "./native.js";

const PICKER_TITLE = "Choose the MetaTrader folder (the one with terminal.exe)";

export function AddFolder({ onAdded, onError, label = "Add folder…" }: { onAdded: (terminal: TerminalView) => void; onError: (message: string) => void; label?: string }) {
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(folder: string) {
    setBusy(true);
    onError("");
    try {
      const { terminal } = await post<{ terminal: TerminalView }>("/api/terminals/add-folder", { folder });
      setTyping(false);
      setPath("");
      onAdded(terminal);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const bridge = native();
    if (!bridge) return setTyping(true);
    const folder = await bridge.pickFolder(PICKER_TITLE).catch(() => null);
    if (folder) await add(folder);
  }

  if (!typing) {
    return (
      <button class="button" onClick={start} disabled={busy}>
        {busy ? "Adding…" : label}
      </button>
    );
  }
  return (
    <form
      class="add-folder"
      onSubmit={(e) => {
        e.preventDefault();
        if (path.trim()) void add(path.trim());
      }}
    >
      <label class="visually-hidden" for="add-folder-path">
        {PICKER_TITLE}
      </label>
      <input
        id="add-folder-path"
        class="input mono"
        placeholder="C:\Program Files (x86)\My Broker MetaTrader 4"
        value={path}
        onInput={(e) => setPath((e.target as HTMLInputElement).value)}
        autoFocus
      />
      <button class="button primary" type="submit" disabled={busy || !path.trim()}>
        Add
      </button>
      <button class="button" type="button" onClick={() => setTyping(false)}>
        Cancel
      </button>
    </form>
  );
}
