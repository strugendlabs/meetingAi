import { describe, it, expect } from "vitest";
import { pickVoice } from "./voices";

describe("pickVoice", () => {
  it("returns Charon when mode is male", () => {
    expect(pickVoice("male")).toBe("Charon");
  });

  it("returns Kore when mode is female", () => {
    expect(pickVoice("female")).toBe("Kore");
  });

  it("mode male wins even if detected is female", () => {
    expect(pickVoice("male", "female")).toBe("Charon");
  });

  it("mode female wins even if detected is male", () => {
    expect(pickVoice("female", "male")).toBe("Kore");
  });

  it("auto with detected male returns Charon", () => {
    expect(pickVoice("auto", "male")).toBe("Charon");
  });

  it("auto with detected female returns Kore", () => {
    expect(pickVoice("auto", "female")).toBe("Kore");
  });

  it("auto without detection defaults to Kore", () => {
    expect(pickVoice("auto")).toBe("Kore");
  });
});
