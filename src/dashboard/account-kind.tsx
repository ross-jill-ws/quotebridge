// Whether an account is demo or real, as its terminal reports it (MetaTrader's IsDemo()): one badge wherever an account
// or the terminal logged into it shows, so real money never looks like a demo.

const TITLES = {
  demo: "A demo account: its trades use no real money.",
  real: "A real account: its trades use real money.",
  unknown: "Its terminal has not reported yet whether this is a demo or a real account.",
};

/** Demo, Real, or (`showUnknown`) not known yet; nothing when unknown and not asked to show it. */
export function AccountKind({ demo, showUnknown = false }: { demo: boolean | null | undefined; showUnknown?: boolean }) {
  const kind = demo === true ? "demo" : demo === false ? "real" : "unknown";
  if (kind === "unknown" && !showUnknown) return null;
  return (
    <span class={`account-kind ${kind}`} title={TITLES[kind]}>
      {kind === "demo" ? "Demo" : kind === "real" ? "Real" : "Demo or real?"}
    </span>
  );
}
