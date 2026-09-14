/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Admin-provisioned Gemini API key (see .env.example). */
  readonly VITE_GEMINI_API_KEY?: string;
  /** Admin-provisioned Google OAuth desktop-client ID. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Admin-provisioned Google OAuth desktop-client secret. */
  readonly VITE_GOOGLE_CLIENT_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
