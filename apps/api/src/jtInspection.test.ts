import { createHash } from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectJtFile, writeJtInspectionArtifacts } from "./jtInspection.js";

const fixturePath = fileURLToPath(new URL(
  "../../../data/external-assets/format-fixtures/jt/voyager-example-block-jt10.3.jt",
  import.meta.url,
));

describe("JT API inspection adapter", () => {
  it("reads the licensed JT 10.3 structure, properties, materials and real LOD meshes", async () => {
    const source = await readFile(fixturePath);
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "937a7c41559f9c9cb7f69b3d981b171cbadee417ab1e4f5bcb21b122728403f4",
    );

    const inspection = await inspectJtFile(fixturePath);
    expect(inspection).toMatchObject({
      status: "geometry-supported",
      recognizedFormat: "jt",
      geometryParsed: true,
      header: { majorVersion: 10, minorVersion: 3, tocOffset: 109 },
      toc: { entryCount: 9 },
      assembly: { nodeCount: 11, rootObjectIds: [0] },
      properties: { atomCount: 67 },
      geometry: {
        status: "decoded",
        meshCount: 3,
        lod0MeshCount: 1,
        lod0InstanceCount: 1,
        vertexCount: 8,
        triangleCount: 12,
        availableLods: [0, 1, 2],
      },
    });
    expect(inspection.materials).toHaveLength(3);
    expect(inspection.materials[0]?.diffuse).toEqual([
      0.5960631966590881,
      0.6666666865348816,
      0.6862592697143555,
    ]);
  });

  it("writes selectable LOD0 IDs into hierarchy and properties before GLB publication", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "bim-jt-inspection-"));
    await writeJtInspectionArtifacts(fixturePath, outputDir);
    const hierarchy = JSON.parse(await readFile(path.join(outputDir, "hierarchy.json"), "utf8")) as {
      root: { children: unknown[]; meshIds: string[] };
    };
    const properties = JSON.parse(await readFile(path.join(outputDir, "properties.json"), "utf8")) as {
      model: { geometryStatus: string; materialCount: number; meshCount: number; triangleCount: number };
      elements: Record<string, unknown>;
    };

    expect(hierarchy.root.children).toHaveLength(1);
    expect(hierarchy.root.meshIds).toEqual([expect.stringMatching(/^jt-instance:.*:lod-0:path-0\//)]);
    expect(properties.model).toMatchObject({ geometryStatus: "decoded", materialCount: 3, meshCount: 1, triangleCount: 12 });
    expect(Object.keys(properties.elements)).toHaveLength(23);
    expect(properties.elements[hierarchy.root.meshIds[0]!]).toBeDefined();
    await expect(access(path.join(outputDir, "geometry.glb"))).rejects.toThrow();
  });
});
