// Trading state for the Trading page and the charts, from REST v1 with the window session: accounts, each account's
// Funds, positions and pending orders, the request journal and the trading settings, read again every two seconds
// while shown. A terminal answers an account's three reads with one snapshot.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { SettingsView } from "../../server/settings/index.js";
import { get, getAll, type Envelope } from "../api.js";
import type { AccountView, FundsView, PendingView, PositionView, RequestView, TradingSettings } from "./trading-model.js";

const POLL_MS = 2000;

export type TradingState = {
  accounts: AccountView[];
  funds: ReadonlyMap<string, FundsView>;
  positions: ReadonlyMap<string, PositionView[]>;
  orders: ReadonlyMap<string, PendingView[]>;
  /** Why an account's Funds or trades could not be read just now (its last values stay). */
  readErrors: ReadonlyMap<string, string>;
  requests: RequestView[];
  settings: TradingSettings | undefined;
  /** This session may change the trading settings: the app window's, not a remote browser's. */
  manage: boolean;
  /** The accounts or the journal could not be read. */
  error: string;
  loaded: boolean;
  /** Reads everything again now, e.g. after a request was sent. */
  refresh: () => void;
};

/**
 * Polls while `active`. `brokerServer`, when given, reads Funds and trades only of that broker server's accounts (a
 * chart's), and `journal: false` skips the request journal.
 */
export function useTrading(active: boolean, options: { brokerServer?: string; journal?: boolean } = {}): TradingState {
  const [state, setState] = useState<Omit<TradingState, "refresh">>({
    accounts: [], funds: new Map(), positions: new Map(), orders: new Map(), readErrors: new Map(), requests: [], settings: undefined, manage: false, error: "", loaded: false,
  });
  const latest = useRef(state);
  latest.current = state;
  const poke = useRef<() => void>(() => {});
  const { brokerServer, journal = true } = options;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One read at a time: a refresh during a read asks for another straight after it.
    let running = false;
    let again = false;
    const load = async () => {
      if (running) return void (again = true);
      running = true;
      clearTimeout(timer);
      try {
        const [accounts, requests, settings] = await Promise.all([
          getAll<AccountView>("/api/v1/accounts"),
          journal ? getAll<RequestView>("/api/v1/requests") : Promise.resolve([]),
          get<SettingsView>("/api/settings"),
        ]);
        const funds = new Map(latest.current.funds);
        const positions = new Map(latest.current.positions);
        const orders = new Map(latest.current.orders);
        const readErrors = new Map<string, string>();
        await Promise.all(
          accounts.filter((a) => brokerServer === undefined || a.brokerServer === brokerServer).map(async (a) => {
            const base = `/api/v1/accounts/${encodeURIComponent(a.id)}`;
            try {
              const [f, p, o] = await Promise.all([get<Envelope<FundsView>>(`${base}/funds`), getAll<PositionView>(`${base}/positions`), getAll<PendingView>(`${base}/orders`)]);
              funds.set(a.id, f.data);
              positions.set(a.id, p);
              orders.set(a.id, o);
            } catch (e) {
              readErrors.set(a.id, e instanceof Error ? e.message : String(e));
            }
          }),
        );
        if (!stopped) setState({ accounts, funds, positions, orders, readErrors, requests, settings: settings.trading, manage: settings.manage === true, error: "", loaded: true });
      } catch (e) {
        if (!stopped) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loaded: true }));
      }
      running = false;
      if (!stopped) timer = setTimeout(load, again ? 0 : POLL_MS);
      again = false;
    };
    poke.current = () => void load();
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
      poke.current = () => {};
    };
  }, [active, brokerServer, journal]);

  const refresh = useCallback(() => poke.current(), []);
  return { ...state, refresh };
}
