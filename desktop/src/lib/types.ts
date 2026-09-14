// Shared domain types for MeetingAI (see docs/superpowers/plans Task 2 — exact interfaces).

export type Speaker = "me" | "them";

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  speaker: Speaker;
  text: string;
  translatedText?: string;
  lang?: string;
  tStart: number;
  tEnd?: number;
  final: boolean;
}

export interface MeetingSummary {
  summary: string;
  actionItems: string[];
  keyNotes: string[];
  /**
   * Indices into `actionItems` the user has checked off. Optional so older
   * stored `summary_json` rows (written before this field existed) still
   * parse — readers must default a missing value to `[]`.
   */
  completedActionItems?: number[];
}

export interface Meeting {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  calendarEventId?: string;
}

export type VoiceGenderMode = "auto" | "male" | "female";

export interface AppSettings {
  aiProvider?: "gemini" | "ollama";
  ollamaUrl?: string;
  ollamaModel?: string;
  whisperUrl?: string;
  whisperLanguage?: string;
  userLanguage: string;
  otherLanguage: "auto" | string;
  voiceGenderMode: VoiceGenderMode;
  translationEnabled: boolean;
  duckingEnabled: boolean;
  onboarded: boolean;
  googleClientId: string;
  googleClientSecret: string;
  /**
   * True once the user has stored their OWN Gemini API key in the Keychain.
   * Non-secret; gates whether the app reads the Keychain for the key at all,
   * so an admin-.env-only build never triggers the macOS Keychain prompt.
   */
  hasUserGeminiKey: boolean;
}
