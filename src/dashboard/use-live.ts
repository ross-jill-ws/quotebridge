// Live bridge snapshots for the views, from the server's /live WebSocket, and the indicator keys the Charts view shows.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BridgeSnapshot } from "../server/bridge/index.js";
import { sessionValid } from "./api.js";
import { LiveClient, type LiveSocket, type LiveStatus } from "./live-client.js";

export type Live = {
  status: LiveStatus;
  snapshot?: BridgeSnapshot;
  /** `performance.now()` when the snapshot arrived; the server sends a new one only when something changes. */
  receivedAt: number;
  /** The indicator keys shown now; the server says when their values change. */
  showIndicators: (keys: readonly string[]) => void;
  /** `listener` hears the shown keys whose values changed; returns a function that stops it. */
  onIndicators: (listener: (changed: string[]) => void) => () => void;
};

export function useLive(): Live {
  const [live, setLive] = useState<Omit<Live, "showIndicators" | "onIndicators">>({ status: "connecting", receivedAt: 0 });
  const client = useRef<LiveClient<BridgeSnapshot>>();
  const listeners = useRef(new Set<(changed: string[]) => void>());
  const indicators = useMemo(
    () => ({
      showIndicators: (keys: readonly string[]) => client.current?.show(keys),
      onIndicators: (listener: (changed: string[]) => void) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
      },
    }),
    [],
  );
  useEffect(() => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/live`;
    const live = new LiveClient<BridgeSnapshot>({
      open: () => browserSocket(url),
      onSnapshot: (snapshot) => setLive((l) => ({ ...l, snapshot, receivedAt: performance.now() })),
      onIndicators: (changed) => listeners.current.forEach((listener) => listener(changed)),
      onStatus: (status) => setLive((l) => ({ ...l, status })),
      sessionValid,
    });
    client.current = live;
    live.start();
    return () => live.stop();
  }, []);
  return useMemo(() => ({ ...live, ...indicators }), [live, indicators]);
}

/** Re-renders every `ms` so elapsed times ("unchanged for 42 s") keep counting between snapshots. */
export function useTicker(ms: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function browserSocket(url: string): LiveSocket {
  const ws = new WebSocket(url);
  const socket: LiveSocket = { onopen: null, onmessage: null, onclose: null, onerror: null, send: (data) => ws.send(data), close: () => ws.close() };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data });
  ws.onclose = () => socket.onclose?.();
  ws.onerror = () => socket.onerror?.();
  return socket;
}
