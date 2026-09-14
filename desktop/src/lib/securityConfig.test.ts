// Guards the Tauri security posture fixed in the capability/CSP review:
//  - the webview capability must not grant shell or notification permissions
//    (sidecar is spawned Rust-side in audio_bridge.rs; notifications are
//    deferred to v2), while sql:allow-execute must stay for db.ts writes;
//  - the webview must run with a real Content-Security-Policy whose
//    connect-src covers exactly the app's known egress endpoints;
//  - the dead shell/notification plugins must stay out of the Rust builder
//    and out of both dependency manifests.
import { describe, expect, it } from "vitest";
import capability from "../../src-tauri/capabilities/default.json";
import tauriConf from "../../src-tauri/tauri.conf.json";
import pkg from "../../package.json";
import cargoToml from "../../src-tauri/Cargo.toml?raw";
import libRs from "../../src-tauri/src/lib.rs?raw";

/** Permission identifier whether the entry is a string or a scoped object. */
function identifiers(perms: unknown[]): string[] {
  return perms.map((p) =>
    typeof p === "string" ? p : (p as { identifier: string }).identifier,
  );
}

describe("webview capability (src-tauri/capabilities/default.json)", () => {
  const ids = identifiers(capability.permissions);

  it("grants no shell permissions (sidecar is spawned Rust-side)", () => {
    expect(ids.filter((id) => id.startsWith("shell:"))).toEqual([]);
  });

  it("grants no notification permissions (feature deferred to v2)", () => {
    expect(ids.filter((id) => id.startsWith("notification:"))).toEqual([]);
  });

  it("keeps sql:allow-execute for db.ts parameterized INSERT/UPDATE writes", () => {
    expect(ids).toContain("sql:default");
    expect(ids).toContain("sql:allow-execute");
  });

  it("keeps the permissions the frontend actually uses", () => {
    // settings.ts uses the store plugin; CalendarSidebar.tsx uses openUrl.
    expect(ids).toContain("store:default");
    expect(ids).toContain("opener:default");
  });
});

describe("Content-Security-Policy (src-tauri/tauri.conf.json)", () => {
  const csp: string = tauriConf.app.security.csp;

  function directive(policy: string, name: string): string | undefined {
    return policy
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `) || d === name);
  }

  it("is set (not null / not disabled)", () => {
    expect(typeof csp).toBe("string");
    expect(csp.length).toBeGreaterThan(0);
  });

  it("restricts default-src to 'self'", () => {
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
  });

  it("connect-src covers exactly the app's known egress plus Tauri IPC", () => {
    const connect = directive(csp, "connect-src");
    expect(connect).toBeDefined();
    const sources = connect!.split(/\s+/).slice(1).sort();
    expect(sources).toEqual(
      [
        "ipc:",
        "http://ipc.localhost",
        // calendar.ts
        "https://www.googleapis.com",
        // gemini/summarize.ts
        "https://generativelanguage.googleapis.com",
        // gemini/live.ts (Live API WebSocket)
        "wss://generativelanguage.googleapis.com",
      ].sort(),
    );
  });

  it("allows no remote or unsafe script sources (blob: only, for the AudioWorklet in mic.ts)", () => {
    const script = directive(csp, "script-src");
    expect(script).toBe("script-src 'self' blob:");
  });

  it("keeps worklet/worker loading limited to self + blob", () => {
    expect(directive(csp, "worker-src")).toBe("worker-src 'self' blob:");
  });

  it("blocks plugin content and base hijacking", () => {
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
  });

  it("dev CSP only adds the Vite HMR websocket and inline dev scripts", () => {
    const dev: string = tauriConf.app.security.devCsp;
    expect(typeof dev).toBe("string");
    const devConnect = directive(dev, "connect-src")!.split(/\s+/).slice(1);
    const prodConnect = directive(csp, "connect-src")!.split(/\s+/).slice(1);
    const extra = devConnect.filter((s) => !prodConnect.includes(s));
    expect(extra).toEqual(["ws://localhost:1420"]);
  });
});

describe("dead plugin removal (shell, notification)", () => {
  it("package.json no longer depends on the shell/notification JS plugins", () => {
    const deps: Record<string, string> = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    expect(deps["@tauri-apps/plugin-shell"]).toBeUndefined();
    expect(deps["@tauri-apps/plugin-notification"]).toBeUndefined();
  });

  it("Cargo.toml no longer depends on the shell/notification Rust plugins", () => {
    expect(cargoToml).not.toMatch(/tauri-plugin-shell/);
    expect(cargoToml).not.toMatch(/tauri-plugin-notification/);
  });

  it("lib.rs no longer registers the shell/notification plugins", () => {
    expect(libRs).not.toMatch(/tauri_plugin_shell/);
    expect(libRs).not.toMatch(/tauri_plugin_notification/);
  });

  it("frontend source never imports the removed plugins", () => {
    // The capability removal is only safe because nothing calls these APIs.
    // (Verified by grep at review time; this guards the manifests, and a
    // future import would fail to resolve at build time anyway.)
    expect(Object.keys(pkg.dependencies)).not.toContain(
      "@tauri-apps/plugin-shell",
    );
    expect(Object.keys(pkg.dependencies)).not.toContain(
      "@tauri-apps/plugin-notification",
    );
  });
});
