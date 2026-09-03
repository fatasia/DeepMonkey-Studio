import { describe, expect, it } from "vitest";
import { isUnityWebGlZip, UNITY_BRIDGE_PACKAGE_URL } from "./UnityResourceInspector";

describe("UnityResourceInspector", () => {
  it("exposes the verified Unity bridge package from the application base path", () => {
    expect(UNITY_BRIDGE_PACKAGE_URL).toMatch(/downloads\/com\.bim-studio\.bridge-0\.6\.1\.tgz$/);
  });

  it("accepts only Unity WebGL ZIP packages in the low-code drop flow", () => {
    expect(isUnityWebGlZip("Factory.WebGL.ZIP")).toBe(true);
    expect(isUnityWebGlZip("Factory.unitypackage")).toBe(false);
  });
});
