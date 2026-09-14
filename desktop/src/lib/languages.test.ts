import { describe, expect, it } from "vitest";
import { LANGUAGES, languageByCode, languageLabel, searchLanguages } from "./languages";

describe("LANGUAGES", () => {
  it("has ~30+ entries", () => {
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(30);
  });

  it("has unique codes", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("every entry has a plausible BCP-47 code, name and native name", () => {
    for (const l of LANGUAGES) {
      expect(l.code).toMatch(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/);
      expect(l.name.trim().length).toBeGreaterThan(0);
      expect(l.nativeName.trim().length).toBeGreaterThan(0);
    }
  });

  it("includes English and native-script names", () => {
    expect(languageByCode("en")?.name).toBe("English");
    expect(languageByCode("hi")?.nativeName).toBe("हिन्दी");
    expect(languageByCode("ja")?.nativeName).toBe("日本語");
  });
});

describe("searchLanguages", () => {
  it("returns the full list for an empty or blank query", () => {
    expect(searchLanguages("")).toHaveLength(LANGUAGES.length);
    expect(searchLanguages("   ")).toHaveLength(LANGUAGES.length);
  });

  it("matches English names case-insensitively", () => {
    const hits = searchLanguages("SPAN");
    expect(hits.map((l) => l.code)).toContain("es");
  });

  it("matches native names", () => {
    expect(searchLanguages("Deutsch").map((l) => l.code)).toContain("de");
    expect(searchLanguages("日本語").map((l) => l.code)).toContain("ja");
  });

  it("matches codes, including region variants", () => {
    const codes = searchLanguages("pt").map((l) => l.code);
    expect(codes).toContain("pt-BR");
    expect(codes).toContain("pt-PT");
  });

  it("returns nothing for gibberish", () => {
    expect(searchLanguages("zzzzqq")).toHaveLength(0);
  });
});

describe("languageByCode", () => {
  it("finds by exact code and misses unknowns", () => {
    expect(languageByCode("zh-CN")?.name).toBe("Chinese (Simplified)");
    expect(languageByCode("xx")).toBeUndefined();
  });
});

describe("languageLabel", () => {
  it("labels 'auto' as Auto-detect", () => {
    expect(languageLabel("auto")).toBe("Auto-detect");
  });

  it("labels known codes with the English name", () => {
    expect(languageLabel("fr")).toBe("French");
  });

  it("echoes unknown codes", () => {
    expect(languageLabel("xx-YY")).toBe("xx-YY");
  });
});
