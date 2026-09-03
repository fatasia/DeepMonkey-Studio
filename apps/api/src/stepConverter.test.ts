import { createRequire } from "node:module";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { convertIgesToGlb, convertStepToGlb } from "./stepConverter.js";

describe("STEP and IGES conversion", () => {
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

  it("preserves STEP face colors as separate GLB primitives", async () => {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve("occt-import-js/package.json"));
    const input = path.join(packageRoot, "test", "testfiles", "cube-fcstd", "cube3.step");
    const output = await mkdtemp(path.join(os.tmpdir(), "bim-studio-step-color-test-"));

    await convertStepToGlb(input, output);
    const document = await new NodeIO().read(path.join(output, "geometry.glb"));
    const colors = document.getRoot().listMeshes()[0]?.listPrimitives()
      .flatMap((primitive) => primitive.getMaterial()?.getBaseColorFactor().slice(0, 3) ?? []);

    expect(document.getRoot().listMeshes()[0]?.listPrimitives().length).toBeGreaterThan(1);
    expect(colors).toEqual(expect.arrayContaining([0, 0, 1]));
  }, 30_000);

  it("converts the dependency's licensed IGES fixture into selectable GLB geometry", async () => {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve("occt-import-js/package.json"));
    const input = path.join(packageRoot, "test", "testfiles", "cube-10x10mm", "Cube 10x10.igs");
    const output = await mkdtemp(path.join(os.tmpdir(), "bim-studio-iges-test-"));

    const result = await convertIgesToGlb(input, output);
    const properties = JSON.parse(await readFile(path.join(output, "properties.json"), "utf8")) as {
      model: { sourceFormat: string; units: string; meshCount: number };
    };
    const document = await new NodeIO().read(path.join(output, "geometry.glb"));

    expect(result).toMatchObject({ meshCount: 1, triangleCount: 12 });
    expect(document.getRoot().listMeshes()).toHaveLength(1);
    expect(properties.model).toMatchObject({ sourceFormat: "IGES", units: "meter", meshCount: 1 });
  }, 30_000);
});
