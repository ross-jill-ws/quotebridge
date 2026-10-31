// The Settings view's model (server process): the settings it shows and the changes it may make.
// The server stays the single writer of settings.json; each save is handed on so main applies it.
import { createServer } from "node:net";
import { isOrderDefaultsList, isTradingSettings, ORDER_DEFAULTS_ERROR, CHART_COLOURS, THEMES, TIMES_SHOWN, type Settings, type SettingsStore } from "../../shared/settings-store.js";
import type { PortRole } from "../port-in-use.js";

export type AppSettingsOptions = {
  store: SettingsStore;
  /** Called with the saved settings after every change (the host forwards them to main). */
  onSaved?: (settings: Settings) => void;
};

/** What GET and POST /api/settings answer. */
export type SettingsView = Pick<Settings, "startWithWindows" | "openWindowAtStartup" | "theme" | "flashPrices" | "chartColours" | "timeShown" | "ports" | "trading" | "orderDefaults"> & {
  /** The ports this server is bound to. They differ from `ports` after a change until main restarts the server, or in a dev run with port overrides. */
  portsInUse: Settings["ports"];
  /** Set by the HTTP server: whether this session (the app window) may change settings; a remote browser may not. */
  manage?: boolean;
};

export class SettingsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Ports below 1024 are left to system services. */
const LOWEST_PORT = 1024;
const BOOLEAN_KEYS = ["startWithWindows", "openWindowAtStartup", "flashPrices"] as const;
const PORT_NAMES: Record<PortRole, string> = { ea: "EA port", http: "dashboard port" };

export class AppSettings {
  constructor(
    private readonly options: AppSettingsOptions,
    private readonly portsInUse: Settings["ports"],
  ) {}

  async view(): Promise<SettingsView> {
    return this.toView(await this.options.store.read());
  }

  /** Applies a change from the Settings view; throws SettingsRequestError (400) for one it may not make. */
  async change(request: unknown): Promise<SettingsView> {
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new SettingsRequestError(400, "Expected the settings to change.");
    const body = request as Record<string, unknown>;
    const change: Partial<Settings> = {};
    for (const [key, value] of Object.entries(body)) {
      if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
        if (typeof value !== "boolean") throw new SettingsRequestError(400, `"${key}" must be true or false.`);
        change[key as (typeof BOOLEAN_KEYS)[number]] = value;
      } else if (key === "theme") {
        if (!(THEMES as readonly unknown[]).includes(value)) throw new SettingsRequestError(400, `The theme must be one of ${THEMES.join(", ")}.`);
        change.theme = value as Settings["theme"];
      } else if (key === "chartColours") {
        if (!(CHART_COLOURS as readonly unknown[]).includes(value)) throw new SettingsRequestError(400, `The chart colours must be one of ${CHART_COLOURS.join(", ")}.`);
        change.chartColours = value as Settings["chartColours"];
      } else if (key === "timeShown") {
        if (!(TIMES_SHOWN as readonly unknown[]).includes(value)) throw new SettingsRequestError(400, `Time shown must be one of ${TIMES_SHOWN.join(", ")}.`);
        change.timeShown = value as Settings["timeShown"];
      } else if (key === "trading") {
        if (!isTradingSettings(value)) throw new SettingsRequestError(400, "Invalid trading settings: expected enabled, positive decimal maxLots, nonnegative whole slippage and optional realAccounts.");
        change.trading = { ...value };
      } else if (key === "orderDefaults") {
        // The whole list: the view adds, edits and removes a market's entry by saving the list it shows.
        if (!isOrderDefaultsList(value)) throw new SettingsRequestError(400, ORDER_DEFAULTS_ERROR);
        change.orderDefaults = value.map((d) => ({ ...d }));
      } else if (key !== "ports") {
        throw new SettingsRequestError(400, `"${key}" cannot be changed here.`);
      }
    }
    const current = await this.options.store.read();
    if ("ports" in body) change.ports = await this.checkPorts(body.ports, current.ports);
    const saved = await this.options.store.update((settings) => ({ ...settings, ...change }));
    this.options.onSaved?.(saved);
    return this.toView(saved);
  }

  private async checkPorts(requested: unknown, current: Settings["ports"]): Promise<Settings["ports"]> {
    if (typeof requested !== "object" || requested === null || Array.isArray(requested)) throw new SettingsRequestError(400, "Expected the ports to change.");
    const given = requested as Record<string, unknown>;
    const ports = { ...current };
    for (const role of Object.keys(given)) {
      if (role !== "ea" && role !== "http") throw new SettingsRequestError(400, `There is no "${role}" port.`);
      const port = given[role];
      if (typeof port !== "number" || !Number.isInteger(port) || port < LOWEST_PORT || port > 65535) {
        throw new SettingsRequestError(400, `The ${PORT_NAMES[role]} must be a whole number from ${LOWEST_PORT} to 65535.`);
      }
      ports[role] = port;
    }
    if (ports.ea === ports.http) throw new SettingsRequestError(400, "The EA port and the dashboard port must differ.");
    for (const role of ["ea", "http"] as const) {
      // A port this server holds is free for it; any other must be free now.
      if (ports[role] === current[role] || ports[role] === this.portsInUse[role]) continue;
      if (!(await isFree(ports[role], role === "http" ? ["127.0.0.1", "::1"] : ["127.0.0.1"]))) {
        throw new SettingsRequestError(400, `Port ${ports[role]} is in use by another program. Choose another ${PORT_NAMES[role]}.`);
      }
    }
    return ports;
  }

  private toView(settings: Settings): SettingsView {
    const { startWithWindows, openWindowAtStartup, theme, flashPrices, chartColours, timeShown, ports, trading, orderDefaults } = settings;
    return { startWithWindows, openWindowAtStartup, theme, flashPrices, chartColours, timeShown, trading: { ...trading, realAccounts: trading.realAccounts === true }, orderDefaults: orderDefaults.map((d) => ({ ...d })), ports: { ...ports }, portsInUse: { ...this.portsInUse } };
  }
}

/**
 * Whether a TCP port can be bound now on each of `hosts`, where the app binds it: 127.0.0.1 for the EA port, also ::1
 * for the HTTP port. A computer without IPv6 has no ::1 to hold.
 */
async function isFree(port: number, hosts: string[]): Promise<boolean> {
  for (const host of hosts) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", (e: NodeJS.ErrnoException) => resolve(host === "::1" && (e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT")));
      probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}
