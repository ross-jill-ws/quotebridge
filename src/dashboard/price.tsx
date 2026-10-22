// A price set like a dealing ticket, shared by the Feeds and Charts views.
import { priceParts, type Flash } from "./feeds/feed-row.js";

/** A price set like a dealing ticket; on a tick the pips flash in its direction, with a wash behind the price, and fade back to ink. */
export function Price({ value, digits, flash }: { value: number | undefined; digits: number; flash?: Flash }) {
  if (value === undefined) return <span class="px none">—</span>;
  const { big, pips, pipette } = priceParts(value, digits);
  const direction = flash?.direction ?? "none";
  return (
    // A new key restarts the fade on every tick.
    <span key={`${direction}-${flash?.changedAt}`} class={direction === "none" ? "px" : `px ${direction}`}>
      <span class="visually-hidden">{value.toFixed(digits)}</span>
      <span class="big" aria-hidden="true">
        {big}
      </span>
      <span class="moving" aria-hidden="true">
        {pips && <span class="pips">{pips}</span>}
        {pipette && <span class="pipette">{pipette}</span>}
      </span>
    </span>
  );
}
