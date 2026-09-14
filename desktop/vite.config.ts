/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Every build uses each user's credential-vault key. Never embed the developer's
  // private .env credentials, even when a release is built on their laptop.
  ...{
    envPrefix: "MEETINGAI_PUBLIC_",
    define: {
      "import.meta.env.VITE_GEMINI_API_KEY": JSON.stringify(""),
      "import.meta.env.VITE_GOOGLE_CLIENT_ID": JSON.stringify(""),
      "import.meta.env.VITE_GOOGLE_CLIENT_SECRET": JSON.stringify(""),
    },
  },

  // Tests must be deterministic regardless of the developer's local .env —
  // admin-config values are pinned empty here; tests that need values mock
  // the adminConfig module instead.
  test: {
    env: {
      VITE_GEMINI_API_KEY: "",
      VITE_GOOGLE_CLIENT_ID: "",
      VITE_GOOGLE_CLIENT_SECRET: "",
    },
  },

  // Vite options tailored for Tauri development.
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
});
