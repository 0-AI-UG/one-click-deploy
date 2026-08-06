type ControllerOptions = {
  name: string;
  intervalMs: number;
  initialDelayMs?: number;
  timeoutMs?: number;
  run: () => Promise<void> | void;
};

type ControllerState = {
  options: ControllerOptions;
  timer: ReturnType<typeof setInterval> | null;
  initialTimer: ReturnType<typeof setTimeout> | null;
  running: boolean;
};

const controllers = new Map<string, ControllerState>();

function log(name: string, ...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [controller:${name}]`, ...args);
}

async function invoke(state: ControllerState): Promise<void> {
  const { options } = state;
  if (state.running) {
    log(options.name, "skip (previous run still active)");
    return;
  }
  state.running = true;
  const started = Date.now();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const work = Promise.resolve().then(options.run);
    void work.finally(() => { state.running = false; }).catch(() => {});
    // The timeout reports a wedged controller but deliberately does not release
    // the single-flight guard: starting a second copy while the first still owns
    // remote side effects would be less safe than skipping subsequent intervals.
    if (options.timeoutMs) {
      const timed = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`controller timed out after ${options.timeoutMs}ms`)),
          options.timeoutMs,
        );
      });
      await Promise.race([work, timed]);
    } else {
      await work;
    }
    log(options.name, `done in ${Date.now() - started}ms`);
  } catch (error) {
    log(options.name, `failed: ${error}`);
    // A timeout does not prove the work stopped. Keep the guard for one full
    // interval; provider calls also have transport-level abort timeouts.
    if (!(error instanceof Error && /timed out/.test(error.message))) state.running = false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function startController(options: ControllerOptions): void {
  if (controllers.has(options.name)) return;
  const state: ControllerState = {
    options,
    timer: null,
    initialTimer: null,
    running: false,
  };
  controllers.set(options.name, state);
  state.initialTimer = setTimeout(
    () => { void invoke(state); },
    options.initialDelayMs ?? 5_000,
  );
  state.timer = setInterval(() => { void invoke(state); }, options.intervalMs);
  log(options.name, `started (interval=${options.intervalMs}ms)`);
}

export function stopControllers(): void {
  for (const state of controllers.values()) {
    if (state.timer) clearInterval(state.timer);
    if (state.initialTimer) clearTimeout(state.initialTimer);
  }
  controllers.clear();
}

export async function runControllerOnceForTest(options: ControllerOptions): Promise<void> {
  const state: ControllerState = { options, timer: null, initialTimer: null, running: false };
  await invoke(state);
}
