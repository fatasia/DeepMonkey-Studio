import { describe, expect, it } from "vitest";
import { CLIENT_ICON_MAX_BYTES, DEFAULT_CLIENT_NAME, clientBrandingNameInvalid, normalizedClientBranding, readClientIcon } from "./clientPackageBranding";

describe("local client package branding", () => {
  it("omits defaults and trims only the chosen client name", () => {
    expect(normalizedClientBranding({})).toBeUndefined();
    expect(normalizedClientBranding({ applicationName: ` ${DEFAULT_CLIENT_NAME} ` })).toBeUndefined();
    expect(normalizedClientBranding({ applicationName: "  热电园区  " })).toEqual({ applicationName: "热电园区" });
    expect(normalizedClientBranding({ applicationName: "", iconDataUrl: "data:image/png;base64,a" })).toEqual({ iconDataUrl: "data:image/png;base64,a" });
  });
  it("rejects oversized names and controls without changing defaults", () => {
    expect(clientBrandingNameInvalid("a".repeat(81))).toBe(true);
    expect(clientBrandingNameInvalid("client\u0000.exe")).toBe(true);
    expect(() => normalizedClientBranding({ applicationName: "bad\u007f" })).toThrow();
  });
  it("uses byte signatures rather than declared file type", async () => {
    const png = new File([new Uint8Array([137,80,78,71,13,10,26,10,0])], "wrong.txt", { type: "text/plain" });
    expect(await readClientIcon(png)).toMatch(/^data:image\/png;base64,/);
    const ico = new File([new Uint8Array([0,0,1,0,1,0,16])], "icon.ico");
    expect(await readClientIcon(ico)).toMatch(/^data:image\/x-icon;base64,/);
    await expect(readClientIcon(new File(["not png"], "fake.png", { type: "image/png" }))).rejects.toThrow("icon_format");
  });
  it("rejects empty and oversized input before reading it", async () => {
    await expect(readClientIcon(new File([], "empty.ico"))).rejects.toThrow("icon_size");
    await expect(readClientIcon(new File([new Uint8Array(CLIENT_ICON_MAX_BYTES + 1)], "big.png"))).rejects.toThrow("icon_size");
  });
});
