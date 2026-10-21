// The dashboard shell: header with navigation and connection state, and the current view.
import { useEffect, useState } from "preact/hooks";
import { FeedsView } from "./feeds/feeds-view.js";
import { TerminalsView } from "./terminals/terminals-view.js";
import { useLive, type Live } from "./use-live.js";

const VIEWS = [
  { id: "feeds", label: "Feeds" },
  { id: "terminals", label: "Terminals" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

function viewFromHash(): ViewId {
  const id = location.hash.replace(/^#\/?/, "");
  return VIEWS.find((v) => v.id === id)?.id ?? "feeds";
}

export function App() {
  const [view, setView] = useState<ViewId>(viewFromHash);
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const live = useLive();

  return (
    <>
      <header class="app-header">
        <div class="brand">QuoteBridge</div>
        <nav class="tabs" aria-label="Views">
          {VIEWS.map((v) => (
            <a key={v.id} href={`#/${v.id}`} class="tab" aria-current={view === v.id ? "page" : undefined}>
              {v.label}
            </a>
          ))}
        </nav>
        <ConnectionBadge status={live.status} />
      </header>
      <ConnectionNotice live={live} />
      <main class="content">{view === "feeds" ? <FeedsView live={live} /> : <TerminalsView />}</main>
    </>
  );
}

const BADGES: Record<Live["status"], { text: string; tone: string }> = {
  connecting: { text: "Connecting…", tone: "neutral" },
  live: { text: "Live", tone: "good" },
  reconnecting: { text: "Reconnecting…", tone: "warn" },
  "session-ended": { text: "Disconnected", tone: "bad" },
};

function ConnectionBadge({ status }: { status: Live["status"] }) {
  const badge = BADGES[status];
  return (
    <div class={`connection ${badge.tone}`} role="status">
      <span class="dot" aria-hidden="true" />
      {badge.text}
    </div>
  );
}

function ConnectionNotice({ live }: { live: Live }) {
  if (live.status === "session-ended") {
    return <div class="notice bad">This page's session has ended. Open the dashboard again from the QuoteBridge app window.</div>;
  }
  if (live.status === "reconnecting") {
    return <div class="notice warn">Lost the connection to the app. Retrying; the values below are not updating.</div>;
  }
  return null;
}
