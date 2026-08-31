import { describe, expect, it } from "vitest";
import { codeContentFingerprint } from "./ProfessionalCodeEditor";

describe("codeContentFingerprint", () => {
  it("changes when the editor draft changes without exposing source text", () => {
    const original = codeContentFingerprint("function onStart() {}");
    const edited = codeContentFingerprint("function onStart() {}\n// 保留草稿");

    expect(edited).not.toBe(original);
    expect(edited).not.toContain("保留草稿");
  });
});
