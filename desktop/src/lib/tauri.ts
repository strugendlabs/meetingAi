// Safe Tauri bridge (plan Task 9).
//
// The frontend must run in three environments without crashing:
//   1. Inside the Tauri webview          → real `invoke` / `listen`.
//   2. Plain browser with a test mock    → `window.__TAURI_MOCK__` handlers.
//   3. Plain browser (vite dev, E2E)     → no-ops with sensible fallbacks.
//
// Callers therefore never import @tauri-apps/api directly for these two
// primitives — they go through `safeInvoke` / `safeListen`.

export interface TauriMock {
  /** Handle an invoke; may return a value or a promise. */
  invoke?: (cmd: string, args?: Record<string, unknown>) => unknown;
  /** Subscribe to an event; may return an unlisten function. */
  listen?: (event: string, handler: (payload: unknown) => void) => (() => void) | void;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI_MOCK__?: TauriMock;
  }
}

/** True when running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Invoke a Tauri command.
 * - Inside Tauri: real `invoke` (rejections propagate to the caller).
 * - With `window.__TAURI_MOCK__.invoke`: delegates to the mock.
 * - Otherwise: resolves `fallback` (or `undefined`) — never throws.
 */
export async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
  fallback?: T,
): Promise<T | undefined> {
  if (typeof window !== "undefined" && window.__TAURI_MOCK__?.invoke) {
    return (await window.__TAURI_MOCK__.invoke(cmd, args)) as T;
  }
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  return fallback;
}

/**
 * Listen for a Tauri event. Resolves an unlisten function; outside Tauri
 * (and without a mock) the subscription is a no-op.
 */
export async function safeListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (typeof window !== "undefined" && window.__TAURI_MOCK__?.listen) {
    const unlisten = window.__TAURI_MOCK__.listen(event, handler as (payload: unknown) => void);
    return typeof unlisten === "function" ? unlisten : () => {};
  }
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<T>(event, (e) => handler(e.payload));
  }
  return () => {};
}
