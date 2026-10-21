// The MetaEditor log of a terminal's latest compile, in a dialog.
import { useEffect, useRef, useState } from "preact/hooks";
import type { TerminalView } from "../../server/terminals/index.js";
import type { CompileLog } from "../../shared/metaeditor/index.js";
import { get } from "../api.js";

export function CompileLogDialog({ terminal, onClose }: { terminal: TerminalView; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [log, setLog] = useState<CompileLog>();
  const [error, setError] = useState("");

  useEffect(() => {
    dialog.current?.showModal();
    get<CompileLog>(`/api/terminals/compile-log?terminalId=${encodeURIComponent(terminal.terminalId ?? "")}`).then(setLog, (e: Error) => setError(e.message));
  }, [terminal.terminalId]);

  return (
    <dialog ref={dialog} class="log-dialog" onClose={onClose} aria-labelledby="log-title">
      <header class="dialog-head">
        <h2 id="log-title">Compile log · {terminal.name}</h2>
        <button class="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </header>
      {error && <div class="notice bad">{error}</div>}
      {log?.result && (
        <p class={log.result.errors ? "bad-text" : "muted"}>
          {log.result.errors} {log.result.errors === 1 ? "error" : "errors"}, {log.result.warnings} {log.result.warnings === 1 ? "warning" : "warnings"}
        </p>
      )}
      {log && <pre class="log">{log.text.trim() || "(the log is empty)"}</pre>}
      {!log && !error && <p class="muted">Loading…</p>}
    </dialog>
  );
}
