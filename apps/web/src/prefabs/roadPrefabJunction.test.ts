import type { IndustrialPrefabInstanceState, PrimitiveState } from "@bim-studio/contracts";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { compileLinearPrefabRenderPacket } from "../delivery/compileLinearPrefabRenderPacket";
import { buildLinearPrefabGeometry } from "./linearPrefabGeometry";
import { roadJunctionPlates } from "./roadPrefabJunction";

/** T 型交汇道路：主路两点 + 支路端点标记为路口中心；车行道 7m、单侧路肩 0.75m。 */
const roadState = (markJunction: boolean) => ({ definitionId: "road.straight", definitionVersion: "1.0.0",
  kind: "road" as const, operatingState: "idle" as const,
  parameters: { lengthM: 20, carriagewayWidthM: 7, laneCount: 2, shoulderWidthM: 0.75, surface: "asphalt", marking: "center" },
  placementPath: { points: [
    { id: "a", position: { x: 0, y: 0, z: 0 } },
    { id: "b", position: { x: 12, y: 0, z: 0 } },
    { id: "c", position: { x: 12, y: 0, z: 9 }, ...(markJunction ? { junction: true } : {}) },
  ], interpolation: "linear" as const, closed: false, snapToGround: false, seed: 9 } });

const materials = () => {
  const surface = new THREE.MeshStandardMaterial();
  return { surface, shoulder: surface.clone(), marking: surface.clone() };
};

describe("road junction plates", () => {
  it("只解析道路的 junction 标记，等宽取车行道加双路肩并保持点序", () => {
    const plates = roadJunctionPlates(roadState(true));
    expect(plates).toHaveLength(1);
    expect(plates[0]).toMatchObject({ center: { x: 12, y: 0, z: 9 }, widthM: 7 + 2 * 0.75, pointId: "c" });
    // 未标记与围栏标记都必须为空：路口是道路专属语义。
    expect(roadJunctionPlates(roadState(false))).toEqual([]);
    expect(roadJunctionPlates({ ...roadState(true), kind: "fence" } as IndustrialPrefabInstanceState)).toEqual([]);
    const { placementPath: _removed, ...withoutPath } = roadState(true);
    expect(roadJunctionPlates(withoutPath)).toEqual([]);
  });

  it("作者预览几何在标记点生成同材质方形盖板，尺寸与抬高确定性落位", () => {
    const roadMaterialsValue = materials();
    const root = buildLinearPrefabGeometry(roadState(true), roadMaterialsValue)!;
    const plates = root.children.filter(child => child.name === "路口盖板") as THREE.Mesh[];
    expect(plates).toHaveLength(1);
    const plate = plates[0]!;
    // 盖板为等宽方形板：边长 = 全铺装宽度，厚度与路面板一致（0.08）。
    plate.geometry.computeBoundingBox();
    const size = plate.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(8.5);
    expect(size.z).toBeCloseTo(8.5);
    expect(size.y).toBeCloseTo(0.08);
    // 中心在被标记路径点正上方，顶面 = 路面顶(0.08) + 抬高(0.004)，避免与路面板共面闪烁。
    expect(plate.position).toMatchObject({ x: 12, y: 0.044, z: 9 });
    expect(plate.material).toBe(roadMaterialsValue.surface);
    expect(plate.userData.junctionPointId).toBe("c");
    // 未标记道路不产生任何盖板。
    const plain = buildLinearPrefabGeometry(roadState(false), roadMaterialsValue)!;
    expect(plain.children.filter(child => child.name === "路口盖板")).toHaveLength(0);
  });

  it("同输入重复构建几何字节级确定（矩阵逐元素一致）", () => {
    const serialize = (markJunction: boolean) => {
      const root = buildLinearPrefabGeometry(roadState(markJunction), materials())!;
      root.updateMatrixWorld(true);
      const frames: string[] = [];
      root.traverse(object => frames.push(`${object.name}:${object.matrixWorld.elements.join(",")}`));
      return frames.join("|");
    };
    expect(serialize(true)).toBe(serialize(true));
    expect(serialize(false)).toBe(serialize(false));
    // 标记改变输出（多出盖板），证明对比不是恒真。
    expect(serialize(true)).not.toBe(serialize(false));
  });

  it("发布编译与作者预览同源：盖板以独立实例进入 render packet", () => {
    const compile = (markJunction: boolean) => {
      const item = { modelId: "road-1", name: "道路", kind: "box", visible: true, opacity: 1, color: "#808080",
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        prefab: roadState(markJunction) } satisfies PrimitiveState;
      return compileLinearPrefabRenderPacket(item, new THREE.Matrix4());
    };
    const withJunction = compile(true), withoutJunction = compile(false);
    // 盖板至少多出一个实例，且实例身份保持稳定前缀（同源下译）。
    expect(withJunction.instances.length).toBeGreaterThan(withoutJunction.instances.length);
    // 找到盖板实例：几何包围盒为 8.5 × 0.08 × 8.5 的方形板，平移到标记点 (12, 0.044, 9)。
    const plateGeometry = withJunction.geometries.map(geometry => {
      let index = 0;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      while (index < geometry.vertices.length) {
        for (let axis = 0; axis < 3; axis++) {
          const value = geometry.vertices[index + axis]!;
          min[axis] = Math.min(min[axis]!, value);
          max[axis] = Math.max(max[axis]!, value);
        }
        index += 6;
      }
      return { id: geometry.id, size: [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!] as const };
    }).find(geometry => Math.abs(geometry.size[0] - 8.5) < 1e-4 && Math.abs(geometry.size[1] - 0.08) < 1e-4
      && Math.abs(geometry.size[2] - 8.5) < 1e-4);
    expect(plateGeometry).toBeDefined();
    const plateInstance = withJunction.instances.find(instance => instance.geometry === plateGeometry!.id)!;
    expect(plateInstance.transform[12]).toBeCloseTo(12);
    expect(plateInstance.transform[13]).toBeCloseTo(0.044);
    expect(plateInstance.transform[14]).toBeCloseTo(9);
  });
});
