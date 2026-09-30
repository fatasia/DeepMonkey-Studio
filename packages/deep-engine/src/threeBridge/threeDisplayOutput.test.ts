import { describe, expect, it } from "vitest";
import { OutputShader } from "three/examples/jsm/shaders/OutputShader.js";
import { guardedThreeDisplayLibrary } from "./threeToneMappingShader.js";
import { threeDisplayOutputShader } from "./threeDisplayOutput.js";

describe("Three display output assembly", () => {
  it("changes only the ACES call and adds the paired library", () => {
    const result = threeDisplayOutputShader(OutputShader.fragmentShader);
    const original = result.replace(`// C8 paired display output\n${guardedThreeDisplayLibrary()}\n`, "")
      .replace("deepThreeAcesFit( gl_FragColor.rgb, toneMappingExposure )", "ACESFilmicToneMapping( gl_FragColor.rgb )");
    expect(original).toBe(OutputShader.fragmentShader);
    expect(result).toContain("#ifdef SRGB_TRANSFER");
  });

  it.each([
    ["missing ACES", OutputShader.fragmentShader.replace("ACESFilmicToneMapping", "UpstreamChanged")],
    ["duplicate ACES", OutputShader.fragmentShader + "ACESFilmicToneMapping( gl_FragColor.rgb )"],
    ["missing main", OutputShader.fragmentShader.replace("void main()", "void entry()")],
    ["duplicate main", OutputShader.fragmentShader + "void main()"],
    ["already adapted", threeDisplayOutputShader(OutputShader.fragmentShader)],
  ])("rejects %s instead of quietly dropping output behavior", (_label, source) => {
    expect(() => threeDisplayOutputShader(source)).toThrow("Three OutputPass shader changed");
  });
});
