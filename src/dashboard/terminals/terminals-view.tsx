// Terminals view: every terminal the app found, its bridge files, its EA and the setup checklist,
// with Install / Recompile / Remove, rescan and add folder.
import { useState } from "preact/hooks";
import type { TerminalsState, TerminalView } from "../../server/terminals/index.js";
import { post } from "../api.js";
import { useTicker } from "../use-live.js";
import { AddFolder } from "./add-folder.js";
import { CompileLogDialog } from "./compile-log.js";
import { CHECKLIST_STEPS, describeTerminal } from "./terminal-card.js";
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

  return (
    <section class="view" aria-labelledby="terminals-title">
      <div class="view-heading">
        <h1 id="terminals-title">Terminals</h1>
        <p class="summary">
          {managed.length} managed
          {offered > 0 && (
            <>
              {" · "}
              <span class="warn-text">{offered} new</span>
            </>
          )}
        </p>
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
          <h2 class="section-title">Not managed</h2>
          <div class="cards">
            {others.map((t) => (
              <TerminalCardView key={t.key} t={t} act={act} showLog={() => setLogFor(t)} />
            ))}
          </div>
        </>
      )}
      {unsupported.length > 0 && (
        <>
          <h2 class="section-title">Not supported</h2>
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

function TerminalCardView({ t, act, showLog }: { t: TerminalView; act: (action: () => Promise<unknown>) => Promise<void>; showLog: () => void }) {
  useTicker(1000); // "Last heard 3 min ago" keeps counting
  const card = describeTerminal(t, Date.now());
  const install = () => act(() => post("/api/terminals/install", { terminalIds: [t.terminalId] }));
  const remove = () => {
    if (!confirm(`Remove the QuoteBridge bridge files from ${t.name}? The app stops managing this terminal. Charts with the QuoteBridge EA stop sending quotes.`)) return;
    return act(() => post("/api/terminals/remove", { terminalId: t.terminalId }));
  };
  const showChecklist = t.managed && (t.state === "installed" || t.state === "outdated");

  return (
    <article class={`card${t.attention ? " attention" : ""}`} aria-label={t.name}>
      <header class="card-head">
        <div class="card-title">
          <h3>{t.name}</h3>
          <span class={`tag ${card.state.tone}`}>{card.state.text}</span>
          {t.supported && t.state !== "not-installed" && (
            <span class={`connection-tag ${card.connection.tone}`}>
              <span class="dot" aria-hidden="true" />
              {card.connection.text}
            </span>
          )}
        </div>
        <div class="card-actions">
          {card.actions.install && (
            <button class="button primary" disabled={card.busy} onClick={install}>
              Install
            </button>
          )}
          {card.actions.decline && (
            <button class="button quiet" disabled={card.busy} onClick={() => act(() => post("/api/terminals/decline", { terminalId: t.terminalId }))}>
              Not now
            </button>
          )}
          {card.actions.recompile && (
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
          {t.needsConfirmation && t.installationFolder && (
            <button
              class="button"
              onClick={() => act(() => post("/api/terminals/add-folder", { folder: t.installationFolder }))}
              title="This terminal keeps its data beside terminal.exe (portable mode)"
            >
              Confirm portable folder
            </button>
          )}
        </div>
      </header>

      <dl class="card-meta">
        {t.terminalId && t.supported && (
          <>
            <dt>Terminal ID</dt>
            <dd class="mono">{t.terminalId}</dd>
          </>
        )}
        <dt>{t.portable ? "Folder (portable)" : "Data folder"}</dt>
        <dd class="mono path">{t.dataFolder ?? t.installationFolder ?? "—"}</dd>
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

      {!t.supported && t.unsupportedReason && <p class="muted card-note">{t.unsupportedReason}</p>}
      {!t.detected && <p class="warn-text card-note">This terminal was not found in the last scan. Its folder may have moved or been uninstalled.</p>}

      {card.closeMetaEditor ? (
        <div class="notice warn card-notice" role="alert">
          <span>
            MetaEditor of this terminal is open. Close MetaEditor (File › Exit), then retry, so the compile is not sent to your open editor.
          </span>
          <button class="button" disabled={card.busy} onClick={install}>
            Retry
          </button>
        </div>
      ) : (
        t.lastFailure && (
          <div class="notice bad card-notice">
            <div>
              <div>{t.lastFailure.message}</div>
              {t.lastFailure.errors && t.lastFailure.errors.length > 0 && (
                <ul class="errors">
                  {t.lastFailure.errors.slice(0, 3).map((e, i) => (
                    <li key={i} class="mono">
                      {fileName(e.file)}({e.line},{e.column}): error {e.code}: {e.text}
                    </li>
                  ))}
                  {t.lastFailure.errors.length > 3 && <li>…and {t.lastFailure.errors.length - 3} more in the compile log.</li>}
                </ul>
              )}
            </div>
          </div>
        )
      )}
      {t.managed && t.state === "no-metaeditor" && !t.lastFailure && (
        <div class="notice bad card-notice">This terminal has no MetaEditor (metaeditor.exe), so the app cannot compile the QuoteBridge EA for it.</div>
      )}
      {t.pendingRemoval.length > 0 && (
        <p class="muted card-note">{t.pendingRemoval.length} file(s) are in use by MetaTrader; the app removes them the next time it starts.</p>
      )}
      {t.hint && <div class="notice warn card-notice">{t.hint}</div>}

      {showChecklist && (
        <ol class="checklist" aria-label="Steps in MetaTrader">
          {CHECKLIST_STEPS.map((step) => {
            const done = t.checklist[step.key];
            return (
              <li key={step.key} class={done ? "done" : undefined}>
                <span class="check" aria-hidden="true">
                  {done ? "✓" : ""}
                </span>
                <span>{step.text}</span>
                <span class="visually-hidden">{done ? "(done)" : "(to do)"}</span>
              </li>
            );
          })}
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
