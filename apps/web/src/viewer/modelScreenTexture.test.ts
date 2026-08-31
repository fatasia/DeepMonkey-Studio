import { describe, expect, it } from "vitest";
import { modelScreenSourceUrl, normalizeModelScreenState } from "./modelScreenTexture";

describe("model screen texture policy", () => {
  it("normalizes playback and forces muted autoplay", () => {
    expect(normalizeModelScreenState({
      enabled: true,
      sourceType: "video",
      url: "  /assets/line.mp4  ",
      autoplay: true,
      loopMode: "once",
      muted: false,
      emissiveIntensity: 9,
    })).toMatchObject({ url: "/assets/line.mp4", autoplay: true, loopMode: "once", muted: true, emissiveIntensity: 5 });
  });

  it("accepts same-origin and HTTPS media while rejecting unsafe protocols", () => {
    expect(modelScreenSourceUrl("/assets/screen.mp4", "https://studio.test/editor")).toBe("https://studio.test/assets/screen.mp4");
    expect(modelScreenSourceUrl("https://media.test/screen.mp4", "https://studio.test/editor")).toBe("https://media.test/screen.mp4");
    expect(modelScreenSourceUrl("http://media.test/screen.mp4", "https://studio.test/editor")).toBeUndefined();
    expect(modelScreenSourceUrl("javascript:alert(1)", "https://studio.test/editor")).toBeUndefined();
  });
});

