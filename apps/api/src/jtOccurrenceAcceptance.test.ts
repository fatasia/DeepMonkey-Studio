import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";
import { writeJtInspectionArtifacts } from "./jtInspection.js";
import { convertJtLod0ToGlb } from "./jtGlbConverter.js";
import { auditConverterOutput } from "./converterOutputAudit.js";

const fixture = fileURLToPath(new URL("../../../data/external-assets/format-fixtures/jt/voyager-coffee-maker-jt9.5.jt", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
interface TreeNode { id: string; prototypeId?: string; assemblyPath?: number[]; meshIds: string[]; children: TreeNode[] }
function flatten(node: TreeNode): TreeNode[] { return [node, ...node.children.flatMap(flatten)]; }

describe("real JT occurrence artifact closure", () => {
  it("keeps all 336 source occurrences unique and aligns selection, properties and shared GLB meshes", async () => {
    expect(createHash("sha256").update(await readFile(fixture)).digest("hex")).toBe("ea7a1ecbba1c1f04fe11049e8537fca8e9bc0f02af354cd01ea8bb9740c46172");
    const attempts: string[] = [];
    for (let run = 0; run < 2; run++) {
      const dir = await mkdtemp(path.join(tmpdir(), "jt-occurrence-")); directories.push(dir); attempts.push(dir);
      const { document, inspection } = await writeJtInspectionArtifacts(fixture, dir);
      const result = await convertJtLod0ToGlb(document, dir, "CoffeeMaker.jt", inspection.materials);
      expect(result).toMatchObject({ meshCount: 44, instanceCount: 64, triangleCount: 47_962 });
      expect(await auditConverterOutput(dir, true)).toMatchObject({ geometry: { meshCount: 44, triangleCount: 47_962 } });
      const hierarchy = JSON.parse(await readFile(path.join(dir, "hierarchy.json"), "utf8")) as { root: TreeNode };
      const properties = JSON.parse(await readFile(path.join(dir, "properties.json"), "utf8"));
      const rows = flatten(hierarchy.root), occurrences = rows.slice(1);
      expect(rows).toHaveLength(337);
      expect(new Set(rows.map((x) => x.id)).size).toBe(337);
      const prototypeCounts = new Map<string, number>();
      for (const row of occurrences) {
        prototypeCounts.set(row.prototypeId!, (prototypeCounts.get(row.prototypeId!) ?? 0) + 1);
        expect(properties.elements[row.id]).toMatchObject({ elementId: row.id, prototypeElementId: row.prototypeId, assemblyPath: row.assemblyPath });
        expect(properties.elements[row.prototypeId!]).toBeDefined();
      }
      expect(prototypeCounts.size).toBe(256);
      expect([...prototypeCounts.values()].filter((x) => x > 1)).toHaveLength(36);
      expect(Math.max(...prototypeCounts.values())).toBe(10);
      expect(Object.keys(properties.elements)).toHaveLength(656);
      const glb = await new NodeIO().read(path.join(dir, "geometry.glb"));
      const meshNodes = glb.getRoot().listNodes().filter((node) => node.getMesh());
      expect(meshNodes).toHaveLength(64);
      expect(new Set(meshNodes.map((node) => node.getMesh())).size).toBe(44);
      const glbIds = meshNodes.map((node) => String(node.getExtras().ElementId));
      expect(new Set(glbIds).size).toBe(64);
      expect([...hierarchy.root.meshIds].sort()).toEqual([...glbIds].sort());
      expect(occurrences.flatMap((x) => x.meshIds).sort()).toEqual([...glbIds].sort());
      for (const meshNode of meshNodes) {
        const id = String(meshNode.getExtras().ElementId);
        const owner = occurrences.filter((row) => row.meshIds.includes(id));
        expect(owner).toHaveLength(1);
        expect(owner[0]!.assemblyPath!.join("/")).toBe(meshNode.getExtras().AssemblyPath);
        expect(properties.elements[id].elementId).toBe(id);
      }
    }
    for (const file of ["hierarchy.json", "properties.json", "geometry.glb"]) {
      expect(await readFile(path.join(attempts[0]!, file))).toEqual(await readFile(path.join(attempts[1]!, file)));
    }
  });
});
