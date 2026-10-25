// Review of a request whose outcome is unknown: its evidence, an acknowledgement that MetaTrader's open orders and
// history were checked, and a note. A review lifts the account's block; it does not settle the outcome or resend.
import { useEffect, useRef, useState } from "preact/hooks";
import { post } from "../api.js";
import type { TimeShown } from "../../shared/settings-store.js";
import { describeIntent, reviewError, shownTime, type AccountView, type RequestView } from "./trading-model.js";

/** Reviews `record` (unknown, not yet reviewed); `onReviewed` after the server took the review. */
export function ReviewDialog(props: { record: RequestView; account?: AccountView; timeShown: TimeShown; onClose: () => void; onReviewed: () => void }) {
  const { record, account, timeShown, onClose, onReviewed } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);

  async function review(event: Event) {
    event.preventDefault();
    const problem = reviewError(note, acknowledged);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      await post(`/api/v1/requests/${record.requestId}/review`, { note: note.trim(), acknowledged: true });
      onReviewed();
      dialog.current?.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const i = record.normalizedIntent;
  return (
    <dialog ref={dialog} class="order-dialog" onClose={onClose} aria-labelledby="review-title">
      <form onSubmit={review}>
        <header class="dialog-head">
          <h2 id="review-title">Review unknown request</h2>
        </header>
        <p class="muted">
          MetaTrader's answer to this request never arrived, so QuoteBridge cannot tell whether it ran. Check in MetaTrader first. A review records what you
          found and unblocks the account; it does not mark the request done and sends nothing again.
        </p>
        <dl class="facts">
          <dt>Account</dt>
          <dd>{account?.label ?? record.accountId}</dd>
          <dt>Request</dt>
          <dd>{describeIntent(i)}</dd>
          <dt>Sent</dt>
          <dd>{shownTime(record.createdAt, null, timeShown)}</dd>
          <dt>Terminal</dt>
          <dd class="mono">{record.terminalId}</dd>
          <dt>Request ID</dt>
          <dd class="mono">{record.requestId}</dd>
        </dl>
        <ul class="order-events">
          {record.events.map((e) => (
            <li key={`${e.type}-${e.at}`}>
              {shownTime(e.at, null, timeShown)} · {e.type === "unknown" ? `Unknown (${e.reason})` : e.type === "result" ? `Result: ${e.result.status} ${e.result.message}` : `Reviewed: ${e.note}`}
            </li>
          ))}
        </ul>
        <label class="review-check">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.currentTarget.checked)} />
          <span>I checked this account's open orders and account history in MetaTrader.</span>
        </label>
        <label class="order-field wide">
          <span>What you found (8–500 characters)</span>
          <textarea class="input review-note" rows={3} maxLength={500} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        </label>
        {error && (
          <div class="notice bad" role="alert">
            {error}
          </div>
        )}
        <div class="confirm-actions order-actions">
          <button type="button" class="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="submit" class="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save review"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
