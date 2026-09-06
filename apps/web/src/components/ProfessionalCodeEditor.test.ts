import { describe, expect, it } from "vitest";
import { codeContentFingerprint, PROFESSIONAL_CODE_STRUCTURE_OPTIONS } from "./ProfessionalCodeEditor";

describe("codeContentFingerprint", () => {
  it("changes when the editor draft changes without exposing source text", () => {
    const original = codeContentFingerprint("function onStart() {}");
    const edited = codeContentFingerprint("function onStart() {}\n// 保留草稿");

    expect(edited).not.toBe(original);
    expect(edited).not.toContain("保留草稿");
  });
});

describe("Monaco structure rendering", () => {
  it("avoids the null-position bracket guide path without disabling indentation or bracket colors", () => {
    expect(PROFESSIONAL_CODE_STRUCTURE_OPTIONS.guides).toEqual({ bracketPairs: false, indentation: true });
    expect(PROFESSIONAL_CODE_STRUCTURE_OPTIONS.bracketPairColorization).toEqual({ enabled: true });
  });
});
