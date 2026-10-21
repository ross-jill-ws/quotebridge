// Debounced restarts for `npm run dev`: a burst of file changes (an editor's save, a rebuild writing
// several files) restarts once, after the changes have been quiet for `quietMs`. Restarts never
// overlap: changes that settle while one runs bring exactly one more as soon as it has finished.
import { systemClock, type SupervisorClock } from "../../src/main/supervisor/supervisor.js";

export type RestartSchedulerOptions = {
  quietMs: number;
  clock?: SupervisorClock;
  onError?: (error: unknown) => void;
};

export class RestartScheduler {
  private readonly clock: SupervisorClock;
  private timer: unknown = null;
  private running = false;
  private pending = false;
  private closed = false;

  constructor(
    private readonly restart: () => Promise<void>,
    private readonly options: RestartSchedulerOptions,
  ) {
    this.clock = options.clock ?? systemClock;
  }

  /** Something changed: restart once things are quiet. */
  changed() {
    if (this.closed) return;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.run();
    }, this.options.quietMs);
  }

  close() {
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private run() {
    if (this.closed) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    let done: Promise<void>;
    try {
      done = Promise.resolve(this.restart());
    } catch (e) {
      done = Promise.reject(e);
    }
    done
      .catch((e) => (this.options.onError ?? console.error)(e))
      .finally(() => {
        this.running = false;
        if (this.pending) {
          this.pending = false;
          this.run();
        }
      });
  }
}
