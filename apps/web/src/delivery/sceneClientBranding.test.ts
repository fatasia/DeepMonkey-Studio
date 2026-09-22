import { describe, expect, it } from "vitest";
import { decodeSceneClientIcon, freezeSceneClientBranding } from "./sceneClientBranding";

const png = "data:image/png;base64,iVBORw0KGgo=";
describe("scene client branding boundary", () => {
  it("keeps default delivery unchanged and snapshots caller input", () => {
    expect(freezeSceneClientBranding()).toBeUndefined();
    expect(freezeSceneClientBranding({ applicationName: " DeepMonkey Studio " })).toBeUndefined();
    const input = { applicationName: " 客户园区 ", iconDataUrl: png };
    const output = freezeSceneClientBranding(input);
    input.applicationName = "mutated";
    expect(output).toEqual({ applicationName: "客户园区", iconDataUrl: png });
    expect(Object.isFrozen(output)).toBe(true);
    expect(decodeSceneClientIcon(png).path).toBe("branding/icon.png");
  });
  it.each(["https://example.test/icon.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,YWJj", "data:image/x-icon;base64,iVBORw0KGgo=", "data:image/png;base64,!"])("rejects non-local or mismatched bytes %s", iconDataUrl => {
    expect(() => freezeSceneClientBranding({ iconDataUrl })).toThrow();
  });
  it("rejects malformed names, objects and oversized icon data before decode", () => {
    for (const applicationName of ["x".repeat(81), "x\u0000y"]) expect(() => freezeSceneClientBranding({ applicationName })).toThrow();
    expect(() => freezeSceneClientBranding({ applicationName: 1 } as never)).toThrow();
    expect(() => freezeSceneClientBranding({ other: "x" } as never)).toThrow();
    expect(() => decodeSceneClientIcon(`data:image/png;base64,${"A".repeat(3_000_000)}`)).toThrow("icon_size");
  });
});
