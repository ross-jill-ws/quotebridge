// The terminals state from GET /api/terminals, polled while the view is open (faster while an install runs).
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { TerminalsState } from "../../server/terminals/index.js";
import { ApiError, get } from "../api.js";

export type Terminals = {
  state?: TerminalsState;
  /** The server does not manage terminals (no terminal manager), so there is no setup or Terminals view. */
  unavailable: boolean;
  error: string;
  /** Replaces the state with one an action returned, or fetches it again. */
  refresh(next?: TerminalsState): void;
};

const IDLE_MS = 2000;
const BUSY_MS = 600;

/** Polls while `active` (the Terminals view or setup screen is open); otherwise loads once. */
export function useTerminals(active: boolean): Terminals {
  const [state, setState] = useState<TerminalsState>();
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const busy = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const next = await get<TerminalsState>("/api/terminals");
      busy.current = next.busy;
      setState(next);
      setError("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return setUnavailable(true);
      setError(e instanceof Error ? e.message : String(e));
    }
    if (activeRef.current) timer.current = setTimeout(load, busy.current ? BUSY_MS : IDLE_MS);
  }, []);

  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load, active]);

  const refresh = useCallback(
    (next?: TerminalsState) => {
      if (next) {
        busy.current = next.busy;
        setState(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(load, next.busy ? BUSY_MS : IDLE_MS);
      } else void load();
    },
    [load],
  );

  return { state, unavailable, error, refresh };
}
