import { createRequire } from "node:module";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { convertStepToGlb } from "./stepConverter.js";

describe("STEP conversion", () => {
  it("preserves a selectable hierarchy and writes a valid GLB", async () => {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve("occt-import-js/package.json"));
    const input = path.join(packageRoot, "test", "testfiles", "simple-basic-cube", "cube.stp");
    const output = await mkdtemp(path.join(os.tmpdir(), "bim-studio-step-test-"));

    const result = await convertStepToGlb(input, output);
    const hierarchy = JSON.parse(await readFile(path.join(output, "hierarchy.json"), "utf8")) as {
      root: { children: unknown[] };
    };
    const properties = JSON.parse(await readFile(path.join(output, "properties.json"), "utf8")) as {
      model: { units: string; meshCount: number };
      elements: Record<string, unknown>;
    };
    const document = await new NodeIO().read(path.join(output, "geometry.glb"));

    expect(result.meshCount).toBeGreaterThan(0);
    expect(result.triangleCount).toBeGreaterThan(0);
    expect((await stat(path.join(output, "geometry.glb"))).size).toBeGreaterThan(1_000);
    expect(document.getRoot().listMeshes().length).toBe(result.meshCount);
    expect(hierarchy.root.children.length).toBeGreaterThan(0);
    expect(properties.model).toMatchObject({ units: "meter", meshCount: result.meshCount });
    expect(Object.keys(properties.elements)).toHaveLength(result.meshCount);
  }, 30_000);
});
