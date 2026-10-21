// Host transport: one end of the message channel between the main process and the server process.
// The server host protocol runs over it unchanged whether the server is an Electron utilityProcess,
// a forked Node child (tests) or in the same process (tests).

export interface HostTransport<In, Out> {
  send(message: Out): void;
  /** Listens for incoming messages; returns an unsubscribe function. */
  onMessage(listener: (message: In) => void): () => void;
  /** Stops listening so the channel no longer keeps the process alive. */
  close(): void;
}

/** Electron's `process.parentPort` inside a utility process. */
export type ParentPortLike = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  off(event: "message", listener: (event: { data: unknown }) => void): unknown;
};

/** Electron's `UtilityProcess` as seen from the main process. */
export type UtilityProcessLike = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
};

/** A Node process with an IPC channel: `process` in a forked child, or the `ChildProcess` in the parent. */
export type IpcProcessLike = {
  send?(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
  disconnect?(): void;
  connected?: boolean;
};

/** Server side inside an Electron utility process. */
export function parentPortTransport<In, Out>(port: ParentPortLike): HostTransport<In, Out> {
  const listeners = new Set<(event: { data: unknown }) => void>();
  return {
    send: (message) => port.postMessage(message),
    onMessage(listener) {
      const wrapped = (event: { data: unknown }) => listener(event.data as In);
      listeners.add(wrapped);
      port.on("message", wrapped);
      return () => {
        listeners.delete(wrapped);
        port.off("message", wrapped);
      };
    },
    close() {
      for (const l of listeners) port.off("message", l);
      listeners.clear();
    },
  };
}

/** Main side of an Electron utility process. */
export function utilityProcessTransport<In, Out>(child: UtilityProcessLike): HostTransport<In, Out> {
  return eventTransport<In, Out>(child, (message) => child.postMessage(message));
}

/** Either side of a Node IPC channel (`child_process.fork`). Closing disconnects the channel. */
export function ipcTransport<In, Out>(proc: IpcProcessLike): HostTransport<In, Out> {
  let pending = 0;
  let closing = false;
  const disconnect = () => {
    if (proc.connected) proc.disconnect?.();
  };
  const transport = eventTransport<In, Out>(proc, (message) => {
    if (proc.connected === false || !proc.send) return;
    pending++;
    proc.send(message, () => {
      pending--;
      if (closing && pending === 0) disconnect();
    });
  });
  return {
    ...transport,
    close() {
      transport.close();
      // Disconnect only after messages already sent (e.g. `stopped`) have been written.
      closing = true;
      if (pending === 0) disconnect();
    },
  };
}

function eventTransport<In, Out>(emitter: UtilityProcessLike | IpcProcessLike, send: (message: Out) => void): HostTransport<In, Out> {
  const listeners = new Set<(message: unknown) => void>();
  return {
    send,
    onMessage(listener) {
      const wrapped = (message: unknown) => listener(message as In);
      listeners.add(wrapped);
      emitter.on("message", wrapped);
      return () => {
        listeners.delete(wrapped);
        emitter.off("message", wrapped);
      };
    },
    close() {
      for (const l of listeners) emitter.off("message", l);
      listeners.clear();
    },
  };
}

/**
 * Two connected ends in one process. Messages are delivered asynchronously and structured-cloned,
 * as they would be across processes.
 */
export function inProcessTransportPair<A, B>(): [HostTransport<B, A>, HostTransport<A, B>] {
  const aListeners = new Set<(message: B) => void>();
  const bListeners = new Set<(message: A) => void>();
  let closed = false;
  const end = <In, Out>(own: Set<(message: In) => void>, other: Set<(message: Out) => void>): HostTransport<In, Out> => ({
    send(message) {
      if (closed) return;
      const copy = structuredClone(message);
      setImmediate(() => {
        for (const l of other) l(copy);
      });
    },
    onMessage(listener) {
      own.add(listener);
      return () => own.delete(listener);
    },
    close() {
      closed = true;
      own.clear();
    },
  });
  return [end<B, A>(aListeners, bListeners), end<A, B>(bListeners, aListeners)];
}
