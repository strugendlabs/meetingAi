// Supported languages for transcription / translation (plan Task 9).
// BCP-47 codes, English names, and native names for the searchable picker.

export interface Language {
  /** BCP-47 tag, e.g. "en", "pt-BR", "zh-CN". */
  code: string;
  /** English name. */
  name: string;
  /** Endonym shown prominently in the picker. */
  nativeName: string;
}

export const LANGUAGES: readonly Language[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "es", name: "Spanish", nativeName: "Español" },
  { code: "fr", name: "French", nativeName: "Français" },
  { code: "de", name: "German", nativeName: "Deutsch" },
  { code: "it", name: "Italian", nativeName: "Italiano" },
  { code: "pt-BR", name: "Portuguese (Brazil)", nativeName: "Português (Brasil)" },
  { code: "pt-PT", name: "Portuguese (Portugal)", nativeName: "Português (Portugal)" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands" },
  { code: "ru", name: "Russian", nativeName: "Русский" },
  { code: "uk", name: "Ukrainian", nativeName: "Українська" },
  { code: "pl", name: "Polish", nativeName: "Polski" },
  { code: "cs", name: "Czech", nativeName: "Čeština" },
  { code: "ro", name: "Romanian", nativeName: "Română" },
  { code: "el", name: "Greek", nativeName: "Ελληνικά" },
  { code: "tr", name: "Turkish", nativeName: "Türkçe" },
  { code: "sv", name: "Swedish", nativeName: "Svenska" },
  { code: "da", name: "Danish", nativeName: "Dansk" },
  { code: "nb", name: "Norwegian", nativeName: "Norsk bokmål" },
  { code: "fi", name: "Finnish", nativeName: "Suomi" },
  { code: "hu", name: "Hungarian", nativeName: "Magyar" },
  { code: "ar", name: "Arabic", nativeName: "العربية" },
  { code: "he", name: "Hebrew", nativeName: "עברית" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी" },
  { code: "bn", name: "Bengali", nativeName: "বাংলা" },
  { code: "ta", name: "Tamil", nativeName: "தமிழ்" },
  { code: "te", name: "Telugu", nativeName: "తెలుగు" },
  { code: "mr", name: "Marathi", nativeName: "मराठी" },
  { code: "gu", name: "Gujarati", nativeName: "ગુજરાતી" },
  { code: "ur", name: "Urdu", nativeName: "اردو" },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia" },
  { code: "ms", name: "Malay", nativeName: "Bahasa Melayu" },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt" },
  { code: "th", name: "Thai", nativeName: "ไทย" },
  { code: "fil", name: "Filipino", nativeName: "Filipino" },
  { code: "ja", name: "Japanese", nativeName: "日本語" },
  { code: "ko", name: "Korean", nativeName: "한국어" },
  { code: "zh-CN", name: "Chinese (Simplified)", nativeName: "简体中文" },
  { code: "zh-TW", name: "Chinese (Traditional)", nativeName: "繁體中文" },
  { code: "sw", name: "Swahili", nativeName: "Kiswahili" },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

/** Look up a language by exact BCP-47 code. */
export function languageByCode(code: string): Language | undefined {
  return BY_CODE.get(code);
}

/**
 * Case-insensitive substring search across English name, native name and
 * code. An empty/blank query returns the full list.
 */
export function searchLanguages(query: string): Language[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...LANGUAGES];
  return LANGUAGES.filter(
    (l) =>
      l.name.toLowerCase().includes(q) ||
      l.nativeName.toLowerCase().includes(q) ||
      l.code.toLowerCase().includes(q),
  );
}

/**
 * Human label for a stored language setting: "auto" → "Auto-detect",
 * known codes → English name, unknown codes echo back unchanged.
 */
export function languageLabel(code: string): string {
  if (code === "auto") return "Auto-detect";
  return BY_CODE.get(code)?.name ?? code;
}
