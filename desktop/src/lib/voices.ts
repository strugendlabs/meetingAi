// Gender -> Gemini prebuilt voice mapping (spec §2.3).
// Male -> "Charon" (alts: Puck, Fenrir); female -> "Kore" (alts: Aoede, Leda).

import type { VoiceGenderMode } from "./types";

const MALE_VOICE = "Charon";
const FEMALE_VOICE = "Kore";

/**
 * Pick the translated-speech voice.
 * Explicit mode wins; "auto" follows the detected gender, defaulting to the
 * female voice when nothing has been detected yet.
 */
export function pickVoice(mode: VoiceGenderMode, detected?: "male" | "female"): string {
  if (mode === "male") return MALE_VOICE;
  if (mode === "female") return FEMALE_VOICE;
  return detected === "male" ? MALE_VOICE : FEMALE_VOICE;
}
