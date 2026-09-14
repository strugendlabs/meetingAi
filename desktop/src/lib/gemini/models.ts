// Model configuration with fallback chains (global constraint: never hardcode
// model IDs at call sites — always go through these chains).
//
// Dedicated recognition was verified with streamed Hindi speech on 2026-09-14.
// It uses TEXT + automatic language detection + SMART transcription. Existing
// native-audio models remain fallbacks with their AUDIO/interpreter setup.
// Spoken translation has a separate model chain and connection.

/** Speech recognition for both participants. */
export const LIVE_STT_MODEL_CHAIN: string[] = [
  "gemini-3.5-transcribe-live",
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-2.5-flash-native-audio-latest",
];

/** Dedicated speech recognition has a different setup from native-audio agents. */
export function isTranscriptionModel(model: string): boolean {
  return model === "gemini-3.5-transcribe-live";
}

/** Live session whose translated AUDIO is played to the user. */
export const LIVE_TRANSLATE_MODEL_CHAIN: string[] = [
  "gemini-3.5-live-translate-preview",
  "gemini-3.1-flash-live-preview",
];

export const TEXT_MODEL_CHAIN: string[] = [
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
];

/**
 * True for errors where trying the NEXT model in the chain can help:
 * the model doesn't exist (404/NOT_FOUND) or it exists but rejects the
 * requested response modalities (WS close 1007 "... not supported by the
 * model") — both mean "wrong model", not "broken request".
 */
function isModelUnusableError(e: unknown): boolean {
  const maybe = e as { status?: unknown; code?: unknown; message?: unknown } | null;
  if (maybe && (maybe.status === 404 || maybe.code === 404)) return true;
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : typeof maybe?.message === "string"
          ? maybe.message
          : "";
  return /\b404\b|NOT_FOUND|not found|modalit(y|ies)[^]*not supported|not supported by the model/i.test(
    msg,
  );
}

/**
 * Run `fn` against each model in `chain`, advancing to the next model ONLY
 * when the model itself is unusable (404/NOT_FOUND or unsupported response
 * modality). Any other error is rethrown immediately. If the whole chain
 * fails that way, the last error is thrown.
 */
export async function withModelFallback<T>(
  chain: string[],
  fn: (model: string) => Promise<T>,
): Promise<{ model: string; result: T }> {
  if (chain.length === 0) {
    throw new Error("withModelFallback: empty model chain");
  }
  let lastError: unknown;
  for (const model of chain) {
    try {
      const result = await fn(model);
      return { model, result };
    } catch (e) {
      if (!isModelUnusableError(e)) throw e;
      lastError = e;
    }
  }
  throw lastError;
}
