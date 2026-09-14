// Tests for the system-audio permission check: a backend failure (e.g. the
// sidecar binary missing from a broken install) must be reported as a check
// error — not collapsed into "denied", which sends users to System Settings
// for a permission macOS never registered.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { runSystemAudioCheck } from "./PermissionsStep";

interface TestWindow {
  __TAURI_INTERNALS__?: unknown;
  __TAURI_MOCK__?: { invoke: (cmd: string) => unknown };
}
const g = globalThis as unknown as { window?: TestWindow };

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  delete g.window;
});

function mockInvoke(invoke: (cmd: string) => unknown, tauri = true): void {
  g.window = {
    ...(tauri ? { __TAURI_INTERNALS__: {} } : {}),
    __TAURI_MOCK__: { invoke },
  };
}

describe("runSystemAudioCheck", () => {
  it("maps true to granted", async () => {
    mockInvoke((cmd) => (cmd === "check_system_audio_permission" ? true : undefined));
    await expect(runSystemAudioCheck()).resolves.toEqual({ state: "granted", error: null });
  });

  it("maps false to a genuine TCC denial", async () => {
    mockInvoke(() => false);
    await expect(runSystemAudioCheck()).resolves.toEqual({ state: "denied", error: null });
  });

  it("reports a backend failure as 'error' with the real message, not as denied", async () => {
    mockInvoke(() => {
      throw new Error("system-audio sidecar binary not found");
    });
    await expect(runSystemAudioCheck()).resolves.toEqual({
      state: "error",
      error: "system-audio sidecar binary not found",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "check_system_audio_permission failed",
      expect.any(Error),
    );
  });

  it("stringifies non-Error rejections", async () => {
    mockInvoke(() => Promise.reject("sidecar --check exited unexpectedly: 71"));
    await expect(runSystemAudioCheck()).resolves.toEqual({
      state: "error",
      error: "sidecar --check exited unexpectedly: 71",
    });
  });

  it("stays 'unavailable' outside the Tauri runtime", async () => {
    await expect(runSystemAudioCheck()).resolves.toEqual({ state: "unavailable", error: null });
  });

  it("treats an undefined result inside Tauri as denied (legacy behavior)", async () => {
    mockInvoke(() => undefined, true);
    await expect(runSystemAudioCheck()).resolves.toEqual({ state: "denied", error: null });
  });
});
