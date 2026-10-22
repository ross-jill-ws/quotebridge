// The Settings view: Startup, Appearance, Connection and About. A change applies at once (the server
// saves it and main applies it); only a port change asks first, because it restarts the app.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SettingsView as Settings } from "../../server/settings/index.js";
import { APP_NAME, SOURCE_URL, TRADEMARK_NOTICE } from "../../shared/app-identity.js";
import { BUNDLED_WORKS } from "../../shared/licences.js";
import type { ChartColours, Theme } from "../../shared/settings-store.js";
import { get, post } from "../api.js";
import { native, type AboutApp } from "../terminals/native.js";
import { applyTheme } from "../theme.js";
import { parsePort, PORT_LABELS, portChange, portsNote, type PortRole } from "./settings-model.js";

const THEME_LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
const CHART_COLOUR_LABELS: Record<ChartColours, string> = { default: "Default", "green-on-black": "Green on black" };

/** `onSaved` hands each saved change to the shell (the Feeds view's Flash prices, the rail's port). */
export function SettingsView({ managedTerminals, onSaved }: { managedTerminals: number; onSaved?: (settings: Settings) => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState("");
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    const load = () => get<Settings>("/api/settings").then(setSettings, (e: Error) => setError(e.message));
    load();
    // The tray menu changes Start with Windows too: read again when the window comes back.
    addEventListener("focus", load);
    return () => removeEventListener("focus", load);
  }, []);

  // A theme change shows at once, in this page as in the window.
  useEffect(() => {
    if (settings) applyTheme(settings.theme);
  }, [settings?.theme]);

  const change = async (body: Partial<Settings>) => {
    setError("");
    try {
      const saved = await post<Settings>("/api/settings", body);
      setSettings(saved);
      onSaved?.(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  if (!settings) {
    return (
      <section class="view">
        <h1>Settings</h1>
        <p class="muted">{error || "Loading…"}</p>
      </section>
    );
  }

  const note = portsNote(settings);
  return (
    <section class="view settings" aria-labelledby="settings-title">
      <h1 id="settings-title">Settings</h1>
      <p class="lead">Changes apply straight away.</p>
      {error && (
        <div class="notice bad" role="alert">
          {error}
        </div>
      )}

      <SettingsGroup title="Startup">
        <Toggle
          label="Start with Windows"
          hint="The app starts in the tray when you sign in, ready before MetaTrader opens. Also in the tray menu."
          checked={settings.startWithWindows}
          onChange={(on) => change({ startWithWindows: on }).catch(() => {})}
        />
        <Toggle
          label="Open the window at startup"
          hint="Show this window when the app starts with Windows, instead of staying in the tray."
          checked={settings.openWindowAtStartup}
          disabled={!settings.startWithWindows}
          onChange={(on) => change({ openWindowAtStartup: on }).catch(() => {})}
        />
      </SettingsGroup>

      <SettingsGroup title="Appearance">
        <div class="setting-row">
          <div class="setting-text">
            <span class="setting-label" id="theme-label">
              Theme
            </span>
            <span class="setting-hint">System follows the Windows colour mode.</span>
          </div>
          <div class="segmented" role="radiogroup" aria-labelledby="theme-label">
            {(Object.keys(THEME_LABELS) as Theme[]).map((theme) => (
              <button
                key={theme}
                class="segment"
                role="radio"
                aria-checked={settings.theme === theme}
                onClick={() => settings.theme !== theme && change({ theme }).catch(() => {})}
              >
                {THEME_LABELS[theme]}
              </button>
            ))}
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-text">
            <span class="setting-label" id="chart-colours-label">
              Chart colours
            </span>
            <span class="setting-hint">Default follows the theme. Green on black is MetaTrader's classic look: hollow bull bars on a black canvas.</span>
          </div>
          <div class="segmented" role="radiogroup" aria-labelledby="chart-colours-label">
            {(Object.keys(CHART_COLOUR_LABELS) as ChartColours[]).map((chartColours) => (
              <button
                key={chartColours}
                class="segment"
                role="radio"
                aria-checked={settings.chartColours === chartColours}
                onClick={() => settings.chartColours !== chartColours && change({ chartColours }).catch(() => {})}
              >
                {CHART_COLOUR_LABELS[chartColours]}
              </button>
            ))}
          </div>
        </div>
        <Toggle
          label="Flash prices"
          hint="The pips flash green or red on each tick, then settle back. Always off when Windows is set to reduce animations."
          checked={settings.flashPrices}
          onChange={(on) => change({ flashPrices: on }).catch(() => {})}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Connection"
        after={
          restarting ? (
            <div class="notice warn" role="status">
              Restarting QuoteBridge on the new port. This window reconnects by itself.
            </div>
          ) : (
            note && (
              <div class="notice warn" role="note">
                {note}
              </div>
            )
          )
        }
      >
        {(["ea", "http"] as const).map((role) => (
          <PortRow
            key={role}
            role={role}
            settings={settings}
            managedTerminals={managedTerminals}
            disabled={restarting}
            onChange={async (port) => {
              await change({ ports: { ...settings.ports, [role]: port } });
              setRestarting(true);
            }}
          />
        ))}
      </SettingsGroup>

      <About />
    </section>
  );
}

/** A group of setting rows on one panel; `after` is a note under the panel. */
function SettingsGroup({ title, children, after }: { title: string; children: ComponentChildren; after?: ComponentChildren }) {
  return (
    <section class="settings-group" aria-label={title}>
      <h2>{title}</h2>
      <div class="settings-panel">{children}</div>
      {after}
    </section>
  );
}

function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label class={`setting-row${disabled ? " disabled" : ""}`}>
      <span class="setting-text">
        <span class="setting-label">{label}</span>
        <span class="setting-hint">{hint}</span>
      </span>
      <input type="checkbox" role="switch" class="switch" checked={checked} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
    </label>
  );
}

const PORT_HINTS: Record<PortRole, string> = {
  ea: "QuoteBridge EAs in MetaTrader send their quotes to this port.",
  http: "This window and the dashboard use this port on 127.0.0.1.",
};

function PortRow({ role, settings, managedTerminals, disabled, onChange }: { role: PortRole; settings: Settings; managedTerminals: number; disabled: boolean; onChange: (port: number) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState("");
  const [confirming, setConfirming] = useState<number>();
  const [busy, setBusy] = useState(false);

  const close = () => {
    setEditing(false);
    setConfirming(undefined);
    setProblem("");
  };
  const check = (e: Event) => {
    e.preventDefault();
    // What the field holds now, even if an input event has not re-rendered yet.
    const typed = new FormData(e.currentTarget as HTMLFormElement).get("port");
    const parsed = parsePort(typeof typed === "string" ? typed : text, role, settings);
    if ("error" in parsed) return setProblem(parsed.error);
    setProblem("");
    setConfirming(parsed.port);
  };
  const apply = async () => {
    setBusy(true);
    try {
      await onChange(confirming!);
      close();
    } catch {
      // The view shows the server's reason (e.g. the port is in use); let the user type another.
      setConfirming(undefined);
    } finally {
      setBusy(false);
    }
  };

  const consequence = confirming !== undefined ? portChange(role, confirming, managedTerminals) : undefined;
  return (
    <div class="setting-row port-row">
      <div class="setting-text">
        <span class="setting-label">{PORT_LABELS[role]}</span>
        <span class="setting-hint">{PORT_HINTS[role]}</span>
        {editing && !consequence && (
          <form class="port-form" onSubmit={check}>
            <input
              class="input port-input"
              name="port"
              inputMode="numeric"
              aria-label={`New ${PORT_LABELS[role].toLowerCase()}`}
              value={text}
              onInput={(e) => setText((e.target as HTMLInputElement).value)}
              autoFocus
            />
            <button class="button" type="submit">
              Continue
            </button>
            <button class="button quiet" type="button" onClick={close}>
              Cancel
            </button>
            {problem && (
              <span class="bad-text" role="alert">
                {problem}
              </span>
            )}
          </form>
        )}
        {consequence && (
          <div class="confirm" role="alertdialog" aria-label={consequence.title}>
            <strong>{consequence.title}</strong>
            <p>{consequence.body}</p>
            <div class="confirm-actions">
              <button class="button primary" disabled={busy} onClick={apply}>
                {consequence.confirm}
              </button>
              <button class="button quiet" disabled={busy} onClick={close}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <div class="port-value">
        <span class="port-number">{settings.ports[role]}</span>
        {!editing && (
          <button
            class="button"
            disabled={disabled}
            onClick={() => {
              setText("");
              setEditing(true);
            }}
          >
            Change…
          </button>
        )}
      </div>
    </div>
  );
}

function About() {
  const bridge = native();
  const [about, setAbout] = useState<AboutApp | null>();
  useEffect(() => {
    bridge?.about().then(setAbout, () => setAbout(null));
  }, []);

  return (
    <SettingsGroup title="About">
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">
            {APP_NAME} {about ? about.version : bridge ? "…" : ""}
          </span>
          {about?.installFolder ? (
            <span class="mono path">{about.installFolder}</span>
          ) : (
            !bridge && <span class="setting-hint">Open the app window to see the version.</span>
          )}
        </div>
      </div>
      {about && (
        <div class="setting-row">
          <div class="setting-text">
            <span class="setting-label">Data folder</span>
            <span class="mono path">{about.dataFolder}</span>
          </div>
          <button class="button" onClick={() => void bridge?.openDataFolder()}>
            Open data folder
          </button>
        </div>
      )}
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">Source</span>
          <a class="mono path" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
            {SOURCE_URL}
          </a>
        </div>
      </div>
      <details class="setting-row licences">
        <summary>Licences</summary>
        <ul>
          {BUNDLED_WORKS.map((work) => (
            <li key={work.name}>
              <strong>{work.name}</strong>: {work.licence}.
              {work.link && (
                <>
                  {" "}
                  <a href={work.link.url} target="_blank" rel="noopener noreferrer">
                    {work.link.label}
                  </a>
                </>
              )}
              {work.texts.map((text) => (
                <LicenceText key={text.path} label={text.label} path={text.path} />
              ))}
            </li>
          ))}
        </ul>
      </details>
      <p class="setting-row setting-hint">
        {TRADEMARK_NOTICE} {APP_NAME} is an independent project, not affiliated with or endorsed by MetaQuotes Ltd.
      </p>
    </SettingsGroup>
  );
}

/** A licence or notice text, read from the dashboard when first opened. */
function LicenceText({ label, path }: { label: string; path: string }) {
  const [text, setText] = useState<string>();
  const load = (e: Event) => {
    if (text !== undefined || !(e.currentTarget as HTMLDetailsElement).open) return;
    fetch(`/${path}`).then(
      (res) => (res.ok ? res.text() : Promise.reject(new Error())),
    ).then(setText, () => setText("The text could not be read."));
  };
  return (
    <details class="licence-text" onToggle={load}>
      <summary>{label}</summary>
      <pre>{text ?? "Loading…"}</pre>
    </details>
  );
}
