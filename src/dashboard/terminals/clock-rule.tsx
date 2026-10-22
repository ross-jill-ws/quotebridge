// The Change… dialog for a broker server's clock rule: winter offset (−12:00 to +14:00 in 15-minute steps)
// and daylight saving (none, US dates or EU dates).
import { useEffect, useRef, useState } from "preact/hooks";
import {
  DAYLIGHT_SAVINGS,
  describeRule,
  formatOffset,
  MAX_OFFSET_MINUTES,
  MIN_OFFSET_MINUTES,
  OFFSET_STEP_MINUTES,
  type ClockRule,
  type DaylightSaving,
} from "../../shared/clock.js";
import { post } from "../api.js";

const OFFSETS = Array.from({ length: (MAX_OFFSET_MINUTES - MIN_OFFSET_MINUTES) / OFFSET_STEP_MINUTES + 1 }, (_, i) => MIN_OFFSET_MINUTES + i * OFFSET_STEP_MINUTES);
const DAYLIGHT_SAVING_LABELS: Record<DaylightSaving, string> = { none: "None", us: "US dates (New York)", eu: "EU dates" };

export function ClockRuleDialog({ brokerServer, rule, onClose, onSaved }: { brokerServer: string; rule: ClockRule; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [offset, setOffset] = useState(rule.winterOffsetMinutes);
  const [dst, setDst] = useState<DaylightSaving>(rule.dst);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => dialog.current?.showModal(), []);

  async function save(event: Event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await post("/api/clock-rules", { brokerServer, winterOffsetMinutes: offset, dst });
      onSaved();
      dialog.current?.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialog} class="clock-dialog" onClose={onClose} aria-labelledby="clock-title">
      <form onSubmit={save}>
        <h2 id="clock-title">Broker clock · {brokerServer}</h2>
        <p class="muted">The offset of this broker server's clock from UTC in winter, and when it moves to summer time.</p>
        <div class="clock-fields">
          <label>
            <span>Winter offset</span>
            <select class="input" value={offset} onChange={(e) => setOffset(Number(e.currentTarget.value))}>
              {OFFSETS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {formatOffset(minutes)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Daylight saving</span>
            <select class="input" value={dst} onChange={(e) => setDst(e.currentTarget.value as DaylightSaving)}>
              {DAYLIGHT_SAVINGS.map((d) => (
                <option key={d} value={d}>
                  {DAYLIGHT_SAVING_LABELS[d]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p class="clock-preview">{describeRule({ winterOffsetMinutes: offset, dst })}</p>
        {error && (
          <div class="notice bad" role="alert">
            {error}
          </div>
        )}
        <div class="confirm-actions">
          <button type="button" class="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="submit" class="button primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
