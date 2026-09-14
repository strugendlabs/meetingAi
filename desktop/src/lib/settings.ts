// Zustand settings store with persistence.
// Inside Tauri: persisted via @tauri-apps/plugin-store (settings.json).
// In a plain browser (vite dev / tests): localStorage, with an in-memory
// fallback so importing this module never throws.
//
// NOTE: secrets (Gemini API key, OAuth tokens) are NOT stored here — they live
// in the macOS Keychain (spec §2.5). The Google OAuth client id/secret for a
// desktop "installed app" flow are configuration, kept in settings per plan.

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { AppSettings } from "./types";

export const DEFAULT_SETTINGS: AppSettings = {
  aiProvider: "gemini",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "",
  whisperUrl: "http://127.0.0.1:8080",
  whisperLanguage: "auto",
  userLanguage: "en",
  otherLanguage: "auto",
  voiceGenderMode: "auto",
  translationEnabled: true,
  duckingEnabled: true,
  onboarded: false,
  googleClientId: "",
  googleClientSecret: "",
  hasUserGeminiKey: false,
};

export interface SettingsState extends AppSettings {
  /** Patch one or more settings and persist. */
  update: (patch: Partial<AppSettings>) => void;
  /** Restore defaults (does not touch Keychain-held secrets). */
  reset: () => void;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function memoryStorage(): StateStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

function tauriStorage(): StateStorage {
  type TauriStore = {
    get<T>(key: string): Promise<T | undefined | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    save(): Promise<void>;
  };
  let storePromise: Promise<TauriStore> | null = null;
  const loadStore = () =>
    (storePromise ??= import("@tauri-apps/plugin-store").then(({ load }) =>
      load("settings.json", { autoSave: false }),
    ));
  return {
    getItem: async (k) => {
      const store = await loadStore();
      return (await store.get<string>(k)) ?? null;
    },
    setItem: async (k, v) => {
      const store = await loadStore();
      await store.set(k, v);
      await store.save();
    },
    removeItem: async (k) => {
      const store = await loadStore();
      await store.delete(k);
      await store.save();
    },
  };
}

function pickStorage(): StateStorage {
  if (isTauri()) return tauriStorage();
  if (typeof localStorage !== "undefined") return localStorage;
  return memoryStorage();
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      update: (patch) => set(patch),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      name: "meetingai-settings",
      version: 1,
      storage: createJSONStorage(pickStorage),
      partialize: (state) => {
        const { update, reset, ...data } = state;
        return data;
      },
      merge: (persisted, current) => ({
        ...current,
        ...DEFAULT_SETTINGS,
        ...(persisted as Partial<AppSettings> | undefined),
      }),
    },
  ),
);

/** Read the current settings snapshot outside React. */
export function getSettings(): AppSettings {
  const { update, reset, ...data } = useSettings.getState();
  return data;
}
