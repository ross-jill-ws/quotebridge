// First-run setup screen: the terminals the app found (MT4 pre-ticked, MT5 shown as not yet
// supported), Start with Windows (pre-ticked) and one Install button, then per-terminal progress.
import { useState } from "preact/hooks";
import type { TerminalsState, TerminalView } from "../../server/terminals/index.js";
import { post } from "../api.js";
import { AddFolder } from "./add-folder.js";
import { setTicked, setupSelection } from "./setup-selection.js";
import { describeTerminal } from "./terminal-card.js";
import type { Terminals } from "./use-terminals.js";

export function SetupView({ terminals, onDone }: { terminals: Terminals; onDone: () => void }) {
  const { state, refresh } = terminals;
  /** Terminal IDs the user unticked; everything else supported is ticked. */
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [startWithWindows, setStartWithWindows] = useState(true);
  /** Terminal IDs being installed, once Install was pressed. */
  const [installing, setInstalling] = useState<string[]>();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!state) {
    return (
      <section class="setup">
        <h1>Set up QuoteBridge</h1>
        <p class="muted">{terminals.error || "Looking for MetaTrader terminals on this computer…"}</p>
      </section>
    );
  }

  if (installing) return <SetupProgress state={state} ids={installing} onDone={onDone} />;

  const candidates = state.terminals;
  // The rows' ticks and the Install request come from one selection, so Install sends what is shown.
  const selection = setupSelection(candidates, unticked);
  const ticked = selection.install;

  function toggle(id: string, on: boolean) {
    setUnticked((current) => setTicked(current, id, on));
  }

  async function install() {
    setSubmitting(true);
    setError("");
    try {
      const next = await post<TerminalsState>("/api/setup", { install: ticked, startWithWindows });
      setInstalling(ticked);
      refresh(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section class="setup" aria-labelledby="setup-title">
      <h1 id="setup-title">Set up QuoteBridge</h1>
      <p class="lead">
        {candidates.length === 0
          ? "No MetaTrader terminals were found on this computer."
          : `Found ${candidates.length} MetaTrader ${candidates.length === 1 ? "terminal" : "terminals"}. Install compiles the QuoteBridge EA with each terminal's own MetaEditor and adds the EA, the ZeroMQ DLL and the QuoteBridge template. It never changes MetaTrader's settings.`}
      </p>
      {state.warning && (
        <div class="notice warn" role="note">
          {state.warning}
        </div>
      )}
      {state.bundleProblem && <div class="notice bad">{state.bundleProblem}</div>}
      {error && (
        <div class="notice bad" role="alert">
          {error}
        </div>
      )}

      {candidates.length > 0 && (
        <ul class="setup-list">
          {candidates.map((t) => (
            <SetupRow key={t.key} t={t} checked={selection.checked(t)} onToggle={(on) => t.terminalId && toggle(t.terminalId, on)} onConfirm={() => refresh()} onError={setError} />
          ))}
        </ul>
      )}
      <p class="setup-add">
        Missing a terminal? <AddFolder label="Add its folder…" onAdded={() => refresh()} onError={setError} />
      </p>

      <div class="setup-actions">
        <label class="setup-option">
          <input type="checkbox" checked={startWithWindows} onChange={(e) => setStartWithWindows((e.target as HTMLInputElement).checked)} />
          <span>
            <strong>Start with Windows</strong>
            The app waits in the tray, ready before MetaTrader opens.
          </span>
        </label>
        <button class="button primary large" onClick={install} disabled={submitting || (!!state.bundleProblem && ticked.length > 0)}>
          {ticked.length === 0 ? "Finish setup" : ticked.length === 1 ? "Install" : `Install into ${ticked.length} terminals`}
        </button>
      </div>
    </section>
  );
}

function SetupRow({ t, checked, onToggle, onConfirm, onError }: { t: TerminalView; checked: boolean; onToggle: (on: boolean) => void; onConfirm: () => void; onError: (m: string) => void }) {
  const id = `setup-${t.key}`;
  return (
    <li class={`setup-row${t.supported ? "" : " unsupported"}`}>
      <input type="checkbox" id={id} checked={checked} disabled={!t.supported} onChange={(e) => onToggle((e.target as HTMLInputElement).checked)} />
      <label for={id} class="setup-row-text">
        <span class="setup-name">{t.name}</span>
        <span class="mono path muted">{t.installationFolder ?? t.dataFolder}</span>
        {!t.supported && <span class="muted">{t.unsupportedReason}</span>}
        {t.state === "installed-legacy" && <span class="muted">Has bridge files from the manual setup; they are backed up and replaced.</span>}
      </label>
      <span class="setup-kind">{t.kind === "mt4" ? "MetaTrader 4" : t.kind === "mt5" ? "MetaTrader 5 isn't supported yet" : "Unknown terminal"}</span>
      {t.needsConfirmation && t.installationFolder && (
        <button
          class="button small"
          onClick={async () => {
            try {
              await post("/api/terminals/add-folder", { folder: t.installationFolder });
              onConfirm();
            } catch (e) {
              onError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          It runs in portable mode
        </button>
      )}
    </li>
  );
}

function SetupProgress({ state, ids, onDone }: { state: TerminalsState; ids: string[]; onDone: () => void }) {
  const rows = ids.map((id) => state.terminals.find((t) => t.terminalId === id)).filter((t): t is TerminalView => !!t);
  const running = rows.some((t) => t.operation !== null);
  const ready = rows.filter((t) => t.state === "installed").length;
  const failed = rows.length - ready;

  return (
    <section class="setup" aria-labelledby="setup-title">
      <h1 id="setup-title">{ids.length === 0 ? "Setup complete" : running ? "Installing…" : "Install finished"}</h1>
      {rows.length > 0 && (
        <ul class="setup-list" aria-live="polite">
          {rows.map((t) => {
            const card = describeTerminal(t, Date.now());
            return (
              <li key={t.key} class="setup-row">
                <span class={`progress-icon ${t.operation ? "spin" : card.state.tone}`} aria-hidden="true" />
                <span class="setup-row-text">
                  <span class="setup-name">{t.name}</span>
                  {!t.operation && t.lastFailure && <span class="bad-text">{t.lastFailure.message}</span>}
                </span>
                <span class={`tag ${card.state.tone}`}>{card.state.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {!running && (
        <>
          <p class="lead">
            {ids.length === 0
              ? "You can install into a terminal later from the Terminals view."
              : failed === 0
                ? "Next, in each MetaTrader terminal: refresh the Navigator, apply the QuoteBridge template to a chart and allow DLL imports. The Terminals view ticks each step off when the EA connects."
                : `${ready} of ${rows.length} ready. The Terminals view shows what went wrong and lets you retry.`}
          </p>
          <div class="setup-actions">
            <button class="button primary large" onClick={onDone}>
              Go to Terminals
            </button>
          </div>
        </>
      )}
    </section>
  );
}
