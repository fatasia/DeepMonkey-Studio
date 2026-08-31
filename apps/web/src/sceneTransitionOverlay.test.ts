import { describe, expect, it } from "vitest";
import { sceneTransitionFrames } from "./sceneTransitionOverlay";

describe("scene transition presentation", () => {
  it("keeps fade neutral and gives scale/rise distinct motion", () => {
    expect(sceneTransitionFrames("fade").cover[0]).toMatchObject({ opacity: 0, transform: "none" });
    expect(sceneTransitionFrames("scale").cover[0]).toMatchObject({ transform: "scale(0.96)" });
    expect(sceneTransitionFrames("rise").reveal[1]).toMatchObject({ opacity: 0, transform: "translateY(2.5%)" });
  });
});
