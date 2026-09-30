import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import authoritativeWgsl from "../../wgsl/displayColor.wgsl?raw";
import { displayColorLibrary, type DisplayShaderBackend } from "./displayColorBackends.js";

describe("C8 display color backend libraries", () => {
  it("keeps both wgpu hosts on the authoritative shared bytes", () => {
    const web = displayColorLibrary("webgpu");
    expect(displayColorLibrary("native-wgpu")).toBe(web);
    expect(web.language).toBe("wgsl");
    expect(web.code).toBe(authoritativeWgsl);
    expect(web.sourceHash).toBe(createHash("sha256").update(authoritativeWgsl).digest("hex"));
  });

  it("selects a distinct GLSL library with a traceable source identity", () => {
    const gl = displayColorLibrary("glsl-es-300");
    expect(gl.language).toBe("glsl-es-300");
    expect(gl).not.toBe(displayColorLibrary("webgpu"));
    expect(gl.code).not.toBe(authoritativeWgsl);
    expect(gl.sourceHash).toBe(createHash("sha256").update(gl.code).digest("hex"));
    expect(gl.entryFunction).toBe(displayColorLibrary("webgpu").entryFunction);
    // Library selection must not sneak a host-specific entry point into caller composition.
    expect(gl.code).not.toMatch(/\bvoid\s+main\s*\(/u);
    expect(authoritativeWgsl).not.toMatch(/@(vertex|fragment|compute)\b/u);
  });

  it.each(["webgpu", "native-wgpu", "glsl-es-300"] as const)(
    "returns immutable cached source for %s, preventing cross-consumer corruption",
    (backend) => {
      const library = displayColorLibrary(backend);
      expect(Reflect.set(library, "code", "corrupted shader")).toBe(false);
      expect(Reflect.set(library, "sourceHash", "stale hash")).toBe(false);
      expect(displayColorLibrary(backend)).toBe(library);
      expect(library.sourceHash).toBe(createHash("sha256").update(library.code).digest("hex"));
    },
  );

  it.each(["webgl", "webgl2", "vulkan", "", null, undefined, {}])(
    "rejects unsupported runtime backend %j instead of silently choosing a language",
    (backend) => {
      expect(() => displayColorLibrary(backend as DisplayShaderBackend)).toThrow(RangeError);
    },
  );
});
