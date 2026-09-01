import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { auditGlbGeometry } from "./converterOutputAudit.js";
import { minimalXtRevolvedSubsetFixture } from "./fixtures/minimalXtRevolvedSubset.js";
import { convertXtTextSubsetToGlb } from "./xtTextSubsetConverter.js";

const realFixturePath = fileURLToPath(new URL("../../../data/external-assets/format-fixtures/x_t/cadconvert-small.x_t", import.meta.url));

describe("X_T clean-room subset conversion", () => {
  it("writes selectable face meshes, hierarchy and readable properties", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "bim-xt-subset-"));
    const input = path.join(workspace, "minimal.x_t");
    const output = path.join(workspace, "output");
    await writeFile(input, minimalXtRevolvedSubsetFixture());

    const result = await convertXtTextSubsetToGlb(input, output);
    const audit = await auditGlbGeometry(path.join(output, "geometry.glb"));
    const hierarchy = JSON.parse(await readFile(path.join(output, "hierarchy.json"), "utf8")) as {
      root: { children: Array<{ children: unknown[] }> };
    };
    const properties = JSON.parse(await readFile(path.join(output, "properties.json"), "utf8")) as {
      model: {
        converterScope: string;
        limitations: string[];
        entityMetadata: { names: string; colors: string; properties: string; material: string };
      };
      elements: Record<string, unknown>;
    };
    const document = await new NodeIO().read(path.join(output, "geometry.glb"));

    expect(result).toMatchObject({ bodyCount: 1, faceCount: 10, meshCount: 10, triangleCount: 4224 });
    expect(result.bounds).toEqual({ min: [0, -51.5, -51.5], max: [63, 51.5, 51.5] });
    expect(audit).toMatchObject({ meshCount: 10, primitiveCount: 10, triangleCount: 4224 });
    expect(document.getRoot().listMeshes()).toHaveLength(10);
    expect(hierarchy.root.children[0]?.children).toHaveLength(10);
    expect(Object.keys(properties.elements)).toHaveLength(10);
    expect(properties.model.converterScope).toContain("单体共轴旋转体子集");
    expect(properties.model.entityMetadata).toEqual({
      names: "generated-labels",
      colors: "not-decoded",
      properties: "header-only",
      material: "generated-default",
    });
    expect(properties.model.limitations.join(" ")).toContain("NURBS");
    expect((await stat(path.join(output, "geometry.glb"))).size).toBeGreaterThan(100_000);
  });

  it.runIf(existsSync(realFixturePath))("stays within the real reference-converter differential envelope", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "bim-xt-differential-"));
    const result = await convertXtTextSubsetToGlb(realFixturePath, output);

    // 临时参考转换器证据：1 body、10 faces、4000 triangles、同一毫米包围盒。
    expect(result).toMatchObject({ bodyCount: 1, faceCount: 10, meshCount: 10 });
    expect(result.triangleCount / 4000).toBeGreaterThan(0.9);
    expect(result.triangleCount / 4000).toBeLessThan(1.1);
    expect(result.bounds.min).toEqual([0, -51.5, -51.5]);
    expect(result.bounds.max).toEqual([63, 51.5, 51.5]);
  });
});
