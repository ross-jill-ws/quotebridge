// The dashboard shell: the title bar band, the left rail (views and bridge status), connection notices and the current view.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SettingsView as Settings } from "../server/settings/index.js";
import type { TerminalsState } from "../server/terminals/index.js";
import { get } from "./api.js";
import { ChartsView } from "./charts/charts-view.js";
import { FeedsView } from "./feeds/feeds-view.js";
import { SettingsView } from "./settings/settings-view.js";
import { SetupView } from "./terminals/setup-view.js";
import { TerminalsView } from "./terminals/terminals-view.js";
import { useTerminals } from "./terminals/use-terminals.js";
import { applyTheme } from "./theme.js";
import { useLive, type Live } from "./use-live.js";

const ICONS = {
  feeds: (
    <>
      <path d="M2 14l4.5-5 3.5 3 6-7" />
      <path d="M13 5h3v3" />
    </>
  ),
  terminals: (
    <>
      <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" />
      <path d="M7 17h6M10 13.5V17" />
    </>
  ),
  charts: (
    <>
      <path d="M5 3v14M10 5v10M15 2v12" />
      <rect x="3.5" y="6" width="3" height="6" rx=".5" />
      <rect x="8.5" y="8" width="3" height="4" rx=".5" />
      <rect x="13.5" y="4" width="3" height="7" rx=".5" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6" />
    </>
  ),
};

const VIEWS = [
  { id: "feeds", label: "Feeds" },
  { id: "terminals", label: "Terminals" },
  { id: "charts", label: "Charts" },
  { id: "settings", label: "Settings" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

/** `#/feeds`, or with the view's own state after it: `#/charts?feed=…`. */
function viewFromHash(): ViewId {
  const id = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
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
  const [settings, setSettings] = useSavedSettings(live.status);
  // The setup screen opens on first run and stays (with its progress) until the user moves on.
  const [setupOpen, setSetupOpen] = useState(false);
  const terminals = useTerminals(view === "terminals" || setupOpen);
  const firstRun = terminals.state ? !terminals.state.setupCompleted : false;
  useEffect(() => {
    if (firstRun) setSetupOpen(true);
  }, [firstRun]);
  const finishSetup = () => {
    setSetupOpen(false);
    location.hash = "#/terminals";
    terminals.refresh();
  };

  return (
    <div class="app">
      {/* In the app window the title bar is hidden and its overlay reserved here; a browser has none (height 0). */}
      <div class="title-bar">QuoteBridge for MetaTrader</div>
      <aside class="rail">
        <div class="wordmark" aria-hidden="true">
          <span class="wordmark-full">
            QuoteBridge<small>for MetaTrader</small>
          </span>
          <span class="wordmark-short">QB</span>
        </div>
        {!setupOpen && (
          <nav class="rail-nav" aria-label="Views">
            {VIEWS.filter((v) => v.id !== "settings").map((v) => (
              <RailItem key={v.id} id={v.id} label={v.label} current={view === v.id} />
            ))}
          </nav>
        )}
        <div class="rail-foot">
          {!setupOpen && (
            <nav class="rail-nav" aria-label="Settings">
              <RailItem id="settings" label="Settings" current={view === "settings"} />
            </nav>
          )}
          <BridgeStatus status={live.status} eaPort={settings?.portsInUse.ea} />
        </div>
      </aside>
      <main class="content">
        <ConnectionNotice live={live} />
        {setupOpen ? (
          <SetupView terminals={terminals} onDone={finishSetup} />
        ) : view === "feeds" ? (
          <FeedsView live={live} terminalNames={terminalNames(terminals.state)} flashPrices={settings?.flashPrices ?? true} timeShown={settings?.timeShown ?? "broker"} />
        ) : view === "charts" ? (
          <ChartsView live={live} terminalNames={terminalNames(terminals.state)} chartColours={settings?.chartColours ?? "default"} timeShown={settings?.timeShown ?? "broker"} />
        ) : view === "settings" ? (
          <SettingsView managedTerminals={terminals.state?.terminals.filter((t) => t.managed).length ?? 0} onSaved={setSettings} />
        ) : (
          <TerminalsView terminals={terminals} />
        )}
      </main>
    </div>
  );
}

function RailItem({ id, label, current }: { id: keyof typeof ICONS; label: string; current: boolean }) {
  return (
    <a href={`#/${id}`} class="rail-item" aria-current={current ? "page" : undefined} title={label}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
        {ICONS[id]}
      </svg>
      <span class="rail-label">{label}</span>
    </a>
  );
}

/**
 * The saved settings, for the theme and the rail's EA port: read at start, when the window comes back
 * (they may have changed elsewhere) and after a reconnect (a port change restarts the server).
 */
function useSavedSettings(status: Live["status"]) {
  const [settings, setSettings] = useState<Settings>();
  useEffect(() => {
    const load = () =>
      get<Settings>("/api/settings").then(
        (s) => {
          applyTheme(s.theme);
          setSettings(s);
        },
        () => {},
      );
    if (status === "live") load();
    addEventListener("focus", load);
    return () => removeEventListener("focus", load);
  }, [status]);
  return [settings, setSettings] as const;
}

/** Terminal IDs to the names the Terminals view shows, for the Feeds view's groups. */
function terminalNames(state: TerminalsState | undefined): Map<string, string> {
  return new Map(state?.terminals.flatMap((t) => (t.terminalId ? [[t.terminalId, t.name] as const] : [])));
}

const BRIDGE_STATUS: Record<Live["status"], { text: string; tone: string }> = {
  connecting: { text: "Connecting…", tone: "neutral" },
  live: { text: "Live", tone: "live" },
  reconnecting: { text: "Reconnecting…", tone: "warn" },
  "session-ended": { text: "Disconnected", tone: "bad" },
};

function BridgeStatus({ status, eaPort }: { status: Live["status"]; eaPort?: number }) {
  const { text, tone } = BRIDGE_STATUS[status];
  const port = eaPort === undefined ? undefined : `EAs connect on port ${eaPort}`;
  return (
    <div class={`bridge-status ${tone}`} role="status" title={port ? `${text} · ${port}` : text}>
      <b>
        <span class="pulse" aria-hidden="true" />
        <span class="rail-label">{text}</span>
      </b>
      {port && <span class="rail-label">{port}</span>}
    </div>
  );
}

function ConnectionNotice({ live }: { live: Live }) {
  if (live.status === "session-ended") {
    return <Notice tone="bad" title="Disconnected.">This page's session has ended. Open the dashboard again from the app window.</Notice>;
  }
  if (live.status === "reconnecting") {
    return <Notice tone="warn" title="Reconnecting…">Lost the connection to the app. The values below are not updating.</Notice>;
  }
  return null;
}

function Notice({ tone, title, children }: { tone: "warn" | "bad"; title: string; children: ComponentChildren }) {
  return (
    <div class={`notice connection-notice ${tone}`} role="alert">
      <span class="dot" aria-hidden="true" />
      <span>
        <strong>{title}</strong> {children}
      </span>
    </div>
  );
}

