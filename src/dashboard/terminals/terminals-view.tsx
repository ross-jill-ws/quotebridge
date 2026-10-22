// Terminals view: every terminal the app found, its bridge files, its EA and the setup checklist,
// with Install / Recompile / Remove, rescan and add folder.
import { useState } from "preact/hooks";
import type { TerminalsState, TerminalView } from "../../server/terminals/index.js";
import { post } from "../api.js";
import { useTicker } from "../use-live.js";
import { AddFolder } from "./add-folder.js";
import { CompileLogDialog } from "./compile-log.js";
import { describeTerminal } from "./terminal-card.js";
import type { Terminals } from "./use-terminals.js";

export function TerminalsView({ terminals }: { terminals: Terminals }) {
  const { state, unavailable, refresh } = terminals;
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [logFor, setLogFor] = useState<TerminalView>();

  if (unavailable) {
    return (
      <section class="view">
        <h1>Terminals</h1>
        <div class="empty">
          <p>Terminal management is not available in this server.</p>
        </div>
      </section>
    );
  }
  if (!state) {
    return (
      <section class="view">
        <h1>Terminals</h1>
        <div class="empty">
          <p>{terminals.error || "Looking for MetaTrader terminals…"}</p>
        </div>
      </section>
    );
  }

  /** Runs an action; the state it returns (if any) replaces the shown one. */
  async function act(action: () => Promise<unknown>) {
    setError("");
    try {
      const next = await action();
      refresh(isState(next) ? next : undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      refresh();
    }
  }

  async function rescan() {
    setScanning(true);
    await act(() => post<TerminalsState>("/api/terminals/rescan", {}));
    setScanning(false);
  }

  const managed = state.terminals.filter((t) => t.managed);
  const others = state.terminals.filter((t) => !t.managed && (t.supported || t.needsConfirmation));
  const unsupported = state.terminals.filter((t) => !t.managed && !t.supported && !t.needsConfirmation);
  const offered = others.filter((t) => t.offered).length;
  const settingUp = managed.filter((t) => describeTerminal(t, Date.now()).shape === "setup").length;
  const needAttention = managed.filter((t) => t.attention).length;

  return (
    <section class="view" aria-labelledby="terminals-title">
      <div class="view-heading">
        <div>
          <h1 id="terminals-title">Terminals</h1>
          <p class="summary">
            {managed.length} managed
            {settingUp > 0 && `, ${settingUp} still being set up in MetaTrader`}.
            {needAttention > 0 && (
              <span class="attention-text fault">
                {" "}
                {needAttention} {needAttention === 1 ? "needs" : "need"} attention.
              </span>
            )}
            {offered > 0 && (
              <span class="attention-text">
                {" "}
                {offered} new {offered === 1 ? "terminal" : "terminals"} found.
              </span>
            )}
          </p>
        </div>
        <div class="heading-actions">
          <button class="button" onClick={rescan} disabled={scanning}>
            {scanning ? "Scanning…" : "Rescan"}
          </button>
          <AddFolder onAdded={() => refresh()} onError={setError} />
        </div>
      </div>
      {state.warning && (
        <div class="notice warn" role="note">
          {state.warning}
        </div>
      )}
      {state.bundleProblem && <div class="notice bad">{state.bundleProblem}</div>}
      {error && (
        <div class="notice bad" role="alert">
          {error}
          <button class="link" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}

      {managed.length === 0 && (
        <div class="empty">
          <p>No managed terminals.</p>
          <p class="muted">Install the bridge into a terminal below, or add one by its folder.</p>
        </div>
      )}
      <div class="cards">
        {managed.map((t) => (
          <TerminalCardView key={t.key} t={t} act={act} showLog={() => setLogFor(t)} />
        ))}
      </div>

      {others.length > 0 && (
        <>
          <h2 class="section-title">Found on this computer, not managed</h2>
          <div class="cards">
            {others.map((t) => (
              <TerminalCardView key={t.key} t={t} act={act} showLog={() => setLogFor(t)} />
            ))}
          </div>
        </>
      )}
      {unsupported.length > 0 && (
        <>
          <h2 class="section-title">Not supported yet</h2>
          <div class="cards">
            {unsupported.map((t) => (
              <TerminalCardView key={t.key} t={t} act={act} showLog={() => setLogFor(t)} />
            ))}
          </div>
        </>
      )}
      {logFor && <CompileLogDialog terminal={logFor} onClose={() => setLogFor(undefined)} />}
    </section>
  );
}

/** One terminal; the panel's shape shows its state (terminal-card.ts). */
function TerminalCardView({ t, act, showLog }: { t: TerminalView; act: (action: () => Promise<unknown>) => Promise<void>; showLog: () => void }) {
  useTicker(1000); // "Last heard 3 min ago" keeps counting
  const card = describeTerminal(t, Date.now());
  const install = () => act(() => post("/api/terminals/install", { terminalIds: [t.terminalId] }));
  const remove = () => {
    if (!confirm(`Remove the QuoteBridge bridge files from ${t.name}? The app stops managing this terminal. Charts with the QuoteBridge EA stop sending quotes.`)) return;
    return act(() => post("/api/terminals/remove", { terminalId: t.terminalId }));
  };
  const found = card.shape === "found";
  // In a Fault panel, Retry (with the fix) stands in for Recompile.
  const recompile = card.actions.recompile && !card.fault?.retry;
  const folder = found ? (t.installationFolder ?? t.dataFolder) : (t.dataFolder ?? t.installationFolder);

  return (
    <article class={`term ${card.shape}`} aria-label={t.name}>
      <header class="term-head">
        <h3>{t.name}</h3>
        <div class="facts">
          {t.supported && t.state !== "not-installed" && (
            <span class={`connection ${card.connection.tone}`}>
              <span class={`dot${card.connection.tone === "good" ? " good" : " off"}`} aria-hidden="true" />
              {card.connection.text}
            </span>
          )}
          {/* A found terminal's "Not installed" goes without saying. */}
          {(!found || t.operation || !t.supported) && <span class={`state ${card.state.tone}`}>{card.state.text}</span>}
          {found && folder && <span class="mono path">{folder}</span>}
        </div>
        <div class="term-actions">
          {t.needsConfirmation && t.installationFolder && (
            <button
              class="button quiet"
              onClick={() => act(() => post("/api/terminals/add-folder", { folder: t.installationFolder }))}
              title="This terminal keeps its data beside terminal.exe (portable mode)"
            >
              Confirm portable folder
            </button>
          )}
          {card.actions.decline && (
            <button class="button quiet" disabled={card.busy} onClick={() => act(() => post("/api/terminals/decline", { terminalId: t.terminalId }))}>
              Not now
            </button>
          )}
          {recompile && (
            <button class="button quiet" disabled={card.busy} onClick={install} title="Compile the QuoteBridge EA again and reinstall the bridge files">
              Recompile
            </button>
          )}
          {card.actions.compileLog && (
            <button class="button quiet" onClick={showLog}>
              Compile log
            </button>
          )}
          {card.actions.remove && (
            <button class="button danger" disabled={card.busy} onClick={remove}>
              Remove
            </button>
          )}
          {card.actions.install && (
            <button class="button primary" disabled={card.busy} onClick={install}>
              Install
            </button>
          )}
        </div>
      </header>

      {!found && (
        <dl class="term-meta">
          {t.terminalId && (
            <>
              <dt>Terminal ID</dt>
              <dd class="mono">{t.terminalId}</dd>
            </>
          )}
          <dt>{t.portable ? "Folder (portable)" : "Data folder"}</dt>
          <dd class="mono path">{folder ?? "—"}</dd>
          {card.eaVersion && (
            <>
              <dt>Running EA</dt>
              <dd>{card.eaVersion}</dd>
            </>
          )}
          {t.legacyTerminalId && (
            <>
              <dt>Legacy setup</dt>
              <dd>
                TerminalId <span class="mono">{t.legacyTerminalId}</span>; installing replaces these files (backed up first).
              </dd>
            </>
          )}
        </dl>
      )}

      {(t.unsupportedReason && !t.supported) || !t.detected || t.pendingRemoval.length > 0 || (found && t.legacyTerminalId) ? (
        <div class="term-notes">
          {!t.supported && t.unsupportedReason && <p class="muted">{t.unsupportedReason}</p>}
          {found && t.legacyTerminalId && <p class="muted">Has bridge files from the manual setup; installing backs them up and replaces them.</p>}
          {!t.detected && <p class="warn-text">This terminal was not found in the last scan. Its folder may have moved or been uninstalled.</p>}
          {t.pendingRemoval.length > 0 && <p class="muted">{t.pendingRemoval.length} file(s) are in use by MetaTrader; the app removes them the next time it starts.</p>}
        </div>
      ) : null}

      {card.fault && (
        <div class="fault-box" role="alert">
          <div class="fault-text">
            <strong>{card.fault.reason}</strong>
            {t.lastFailure?.errors && t.lastFailure.errors.length > 0 && (
              <ul class="errors">
                {t.lastFailure.errors.slice(0, 3).map((e, i) => (
                  <li key={i} class="mono">
                    {fileName(e.file)}({e.line},{e.column}): error {e.code}: {e.text}
                  </li>
                ))}
                {t.lastFailure.errors.length > 3 && <li>…and {t.lastFailure.errors.length - 3} more in the compile log.</li>}
              </ul>
            )}
            <span class="fix">{card.fault.fix}</span>
          </div>
          {/* Outlined, not filled: several terminals can fail at once, and a screen has one filled button at most. */}
          {card.fault.retry && (
            <button class="button" disabled={card.busy} onClick={install}>
              Retry
            </button>
          )}
        </div>
      )}

      {t.hint && card.shape !== "setup" && <div class="notice warn term-notice">{t.hint}</div>}

      {card.steps && (
        <ol class="steps" aria-label="Steps in MetaTrader">
          {card.steps.map((step, i) => (
            <li key={step.key} class={`step ${step.status}`} aria-current={step.status === "next" ? "step" : undefined}>
              <span class="n" aria-hidden="true">
                {step.status === "done" ? "✓" : i + 1}
              </span>
              <b>{step.title}</b>
              {step.text}
              <span class="visually-hidden">{step.status === "done" ? " (done)" : " (to do)"}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function isState(value: unknown): value is TerminalsState {
  return typeof value === "object" && value !== null && Array.isArray((value as TerminalsState).terminals);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
