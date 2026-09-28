import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import type { GeometryResource, RenderPacket } from "@bim-studio/deep-engine";
import { extractHlodInstancesFromGlb, extractHlodInstancesFromRenderPacket } from "./hlodPackageSceneInput.js";

const FACTORY_ZIP = path.resolve(import.meta.dirname, "../../../data/external-assets/open-packs/factory.zip");
/** T00 冻结的 machine.glb(T00-s1 报告):25,620 B,464 顶点 / 804 索引 / 268 三角形,米制。 */
const MACHINE_SHA256 = "a39e3042bcb7789274428357383317d70e1c31906e5301c99e7d9e90ac584863";
const MACHINE_ENTRY = "Models/GLB format/machine.glb";

const tempDirectories: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** 立方体几何(stride-6 位置+法线,36 索引):与 packetBoundsHlod 盒代理同布局的最小合成件。 */
function cubeGeometry(id: string, scale = 1): GeometryResource {
  const cornerRows: readonly (readonly [number, number, number])[] = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const corners = cornerRows.map(([x, y, z]) => [x * scale, y * scale, z * scale] as const);
  const vertices = new Float32Array(corners.length * 6);
  corners.forEach(([x, y, z], index) => vertices.set([x, y, z, 0, 0, 1], index * 6));
  const quads: readonly (readonly [number, number, number, number])[] = [
    [0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  return { id, revision: 0, vertices, indices: new Uint32Array(indices) };
}

const packet = (transforms: readonly (readonly number[])[]): RenderPacket => ({
  geometries: [cubeGeometry("geo:cube", 2)],
  materials: [{ id: "mat:default", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
  instances: transforms.map((transform, index) => ({
    id: `inst:${index}`, geometry: "geo:cube", material: "mat:default", transform,
  })),
});

const TRANSLATE_X_5: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
/** 绕 Y 轴 90°(列主序;系数 0/±1 ⇒ 角点变换精确无舍入)。 */
const ROTATE_Y_90: readonly number[] = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("T26 hlodPackage scene input adapters", () => {
  it("extracts per-node instances from a frozen GLB with real triangle counts and stable ids", async () => {
    const zip = await JSZip.loadAsync(await readFile(FACTORY_ZIP));
    const entry = zip.file(MACHINE_ENTRY);
    expect(entry).not.toBeNull();
    const bytes = await entry!.async("nodebuffer");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(MACHINE_SHA256);
    const directory = await mkdtemp(path.join(tmpdir(), "hlod-package-glb-"));
    tempDirectories.push(directory);
    const file = path.join(directory, "machine.glb");
    await writeFile(file, bytes);
    // Kenney 包内纹理位于 Models/GLB format/Textures/,按 GLB 的 URI 视角落盘(同 T17 口径)。
    const texturePrefix = "Models/GLB format/Textures/";
    for (const textureName of Object.keys(zip.files).filter(name => name.startsWith(texturePrefix))) {
      const textureEntry = zip.file(textureName);
      if (!textureEntry || textureEntry.dir) continue;
      const relative = textureName.slice(texturePrefix.length);
      if (relative.length === 0) continue;
      const destination = path.join(directory, "Textures", ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await textureEntry.async("nodebuffer"));
    }

    const first = await extractHlodInstancesFromGlb(file);
    const second = await extractHlodInstancesFromGlb(file);
    expect(first.instances.length).toBeGreaterThan(0);
    expect(first.skippedNonTrianglePrimitives).toBe(0);
    const totalTriangles = first.instances.reduce((sum, instance) => sum + instance.triangles, 0);
    expect(totalTriangles).toBe(268);
    // 确定性:同文件两次提取逐位同结果。
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    for (const instance of first.instances) {
      expect(instance.sphereRadius).toBeGreaterThanOrEqual(0);
      for (let axis = 0; axis < 3; axis++) {
        expect(instance.min[axis]!).toBeLessThanOrEqual(instance.max[axis]!);
        expect(Number.isFinite(instance.sphereCenter[axis]!)).toBe(true);
      }
    }
  });

  it("derives packet-instance world boxes exactly (identity / translation / 90° rotation)", () => {
    // 单位立方体几何 scale=2 ⇒ 局部盒 [0,2]³,24 顶点 36 索引。
    const instances = extractHlodInstancesFromRenderPacket(packet([IDENTITY, TRANSLATE_X_5, ROTATE_Y_90]));
    expect(instances).toHaveLength(3);
    const [identity, translated, rotated] = instances;
    expect(identity!.min).toEqual([0, 0, 0]);
    expect(identity!.max).toEqual([2, 2, 2]);
    expect(identity!.sphereCenter).toEqual([1, 1, 1]);
    expect(identity!.sphereRadius).toBeCloseTo(Math.hypot(1, 1, 1), 12);
    expect(identity!.triangles).toBe(12);
    expect(translated!.min).toEqual([5, 0, 0]);
    expect(translated!.max).toEqual([7, 2, 2]);
    // 绕 Y 90°:局部盒 [0,2]³ → x'=z, z'=-x ⇒ 世界盒 [0,2]×[0,2]×[-2,0]。
    expect(rotated!.min).toEqual([0, 0, -2]);
    expect(rotated!.max).toEqual([2, 2, 0]);
  });

  it("fails closed on missing geometry references, bad transforms and duplicate instance ids", () => {
    const broken = {
      ...packet([IDENTITY]),
      instances: [{ id: "inst:0", geometry: "geo:missing", material: "mat:default", transform: IDENTITY }],
    } as RenderPacket;
    expect(() => extractHlodInstancesFromRenderPacket(broken)).toThrow(/missing geometry/);
    const badTransform = packet([[1, 0, 0]]) as RenderPacket;
    expect(() => extractHlodInstancesFromRenderPacket(badTransform)).toThrow(/invalid transform/);
    const duplicated = {
      ...packet([IDENTITY, IDENTITY]),
      instances: [
        { id: "same", geometry: "geo:cube", material: "mat:default", transform: IDENTITY },
        { id: "same", geometry: "geo:cube", material: "mat:default", transform: TRANSLATE_X_5 },
      ],
    } as RenderPacket;
    expect(() => extractHlodInstancesFromRenderPacket(duplicated)).toThrow(/Duplicate/);
  });
});
