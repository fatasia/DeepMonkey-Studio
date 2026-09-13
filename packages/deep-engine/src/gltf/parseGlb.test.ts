import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseGlb } from "./parseGlb.js";
import { GltfImportError, type JsonObject } from "./validation.js";

describe("GLB container parser", () => {
  it("returns the official BoxTextured document and embedded bytes without IO", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const bytes = readFileSync(new URL("../../lab/assets/BoxTextured.glb", import.meta.url));
      const parsed = parseGlb(bytes);
      const document = parsed.json as JsonObject;
      expect((document.asset as JsonObject).version).toBe("2.0");
      expect(parsed.buffers).toHaveLength(1);
      expect(parsed.buffers[0]).toHaveLength(4592);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a byte subview while keeping offsets correct", () => {
    const source = readFileSync(new URL("../../lab/assets/Box.glb", import.meta.url));
    const backing = new Uint8Array(source.length + 13);
    backing.set(source, 7);
    const parsed = parseGlb(backing.subarray(7, 7 + source.length));
    expect([...parsed.buffers[0]!]).toEqual([...parseGlb(source).buffers[0]!]);
    expect((parsed.json as JsonObject).asset).toMatchObject({ version: "2.0" });
  });

  it("reports envelope failures with the existing structured contract", () => {
    let caught: unknown;
    try {
      parseGlb(new Uint8Array(19));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GltfImportError);
    expect(caught).toMatchObject({ code: "invalid", path: "glb" });
  });
});
