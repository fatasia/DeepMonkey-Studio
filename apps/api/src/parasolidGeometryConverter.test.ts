import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditGlbGeometry } from "./converterOutputAudit.js";
import { convertParasolidGeometryToGlb } from "./parasolidGeometryConverter.js";
import type { ParasolidGeometryExport } from "./parasolidSchemaProbe.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function geometryFixture(overrides?: Partial<ParasolidGeometryExport>): ParasolidGeometryExport {
  return {
    faces: [
      {
        id: 1,
        body: 0,
        surfaceKind: "plane",
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        indices: [0, 1, 2, 0, 2, 3],
        approximations: [],
      },
      {
        id: 2,
        body: 1,
        surfaceKind: "cylinder",
        positions: [2, 0, 0, 3, 0, 0, 2.5, 1, 0],
        indices: [0, 1, 2],
        approximations: ["trim.unresolved:intersection"],
      },
    ],
    losses: ["surface.blended_edge:not-triangulated"],
    approximations: ["geometry.tessellation:angular-64-segments"],
    skipped: [{ id: 9, surfaceKind: "blended_edge", reason: "surface-family-unsupported:blended_edge" }],
    stats: { facesTotal: 3, facesPublished: 2, facesSkipped: 1, vertices: 7, triangles: 3 },
    budgetExceeded: false,
    ...overrides,
  };
}

describe("parasolid geometry GLB publisher", () => {
  it("publishes GLB with body→face hierarchy, recomputed normals and honest losses", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "ps-geometry-"));
    directories.push(outputDir);
    const result = await convertParasolidGeometryToGlb({
      geometry: geometryFixture(),
      sourcePath: "/tmp/AS-2059.x_t",
      outputDir,
      schemaKey: "SCH_2100263_20000_13006",
    });
    expect(result.meshCount).toBe(2);
    expect(result.triangleCount).toBe(3);
    expect(result.vertexCount).toBe(7);
    expect(result.bodies).toBe(2);
    expect(result.facesPublished).toBe(2);
    expect(result.losses).toContain("surface.blended_edge:not-triangulated");
    // 近似面存在 → losses 必须含 brep.trim.approximated。
    expect(result.losses).toContain("brep.trim.approximated");
    expect(result.losses).toContain("entity.names");

    const audit = await auditGlbGeometry(path.join(outputDir, "geometry.glb"));
    expect(audit.meshCount).toBe(2);
    expect(audit.triangleCount).toBe(3);
    expect(audit.vertexCount).toBe(7);

    const hierarchy = JSON.parse(await readFile(path.join(outputDir, "hierarchy.json"), "utf8"));
    expect(hierarchy.partial).toBe(true);
    expect(hierarchy.root.type).toBe("Parasolid 模型");
    expect(hierarchy.root.children).toHaveLength(2);
    expect(hierarchy.root.children[0].type).toBe("实体");
    expect(hierarchy.root.children[0].meshIds).toEqual(["parasolid-schema-face:1"]);

    const properties = JSON.parse(await readFile(path.join(outputDir, "properties.json"), "utf8"));
    expect(properties.model.schema).toBe("SCH_2100263_20000_13006");
    expect(properties.model.losses).toContain("brep.trim.approximated");
    expect(properties.model.skippedFaces).toHaveLength(1);
    expect(Object.keys(properties.elements)).toEqual([
      "parasolid-schema-face:1",
      "parasolid-schema-face:2",
    ]);
  });

  it("omits the trim approximation loss when every face is exact", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "ps-geometry-exact-"));
    directories.push(outputDir);
    const fixture = geometryFixture();
    fixture.faces = fixture.faces.map((face) => ({ ...face, approximations: [] }));
    fixture.skipped = [];
    const result = await convertParasolidGeometryToGlb({
      geometry: fixture,
      sourcePath: "exact.x_t",
      outputDir,
    });
    expect(result.losses).not.toContain("brep.trim.approximated");
  });

  it("refuses to publish an empty geometry", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "ps-geometry-empty-"));
    directories.push(outputDir);
    await expect(convertParasolidGeometryToGlb({
      geometry: geometryFixture({ faces: [], stats: {
        facesTotal: 3, facesPublished: 0, facesSkipped: 3, vertices: 0, triangles: 0,
      } }),
      sourcePath: "empty.x_t",
      outputDir,
    })).rejects.toThrow("拒绝生成空 GLB");
  });
});
