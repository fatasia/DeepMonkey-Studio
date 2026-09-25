import { describe, expect, it } from "vitest";
import { isDesktopLocalToken } from "./system.js";

describe("desktop local authentication", () => {
  const token = "local-session-token-0123456789abcdef";
  const environment = {
    BIM_STUDIO_DEPLOYMENT_MODE: "desktop-local",
    BIM_STUDIO_DESKTOP_LOCAL_TOKEN: token,
  } as NodeJS.ProcessEnv;

  it("accepts only the per-process token from loopback", () => {
    expect(isDesktopLocalToken(token, "127.0.0.1", environment)).toBe(true);
    expect(isDesktopLocalToken(token, "::1", environment)).toBe(true);
    expect(isDesktopLocalToken("wrong-session-token-0123456789abcdef", "127.0.0.1", environment)).toBe(false);
    expect(isDesktopLocalToken(token, "192.168.1.8", environment)).toBe(false);
  });

  it("does not enable the bypass outside explicit desktop-local deployment", () => {
    expect(isDesktopLocalToken(token, "127.0.0.1", { BIM_STUDIO_DESKTOP_LOCAL_TOKEN: token })).toBe(false);
  });
});
