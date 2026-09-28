import { decodeTexturedGlb } from "@bim-studio/deep-engine/gltf";
import type { DecodedTexture, RenderPacket } from "@bim-studio/deep-engine/webgpu";
import { browserImageDecoder } from "./browserImageDecoder.js";
import { BENCHMARK_BACKGROUND, BENCHMARK_DPR, BENCHMARK_FLOOR, BENCHMARK_HEIGHT, BENCHMARK_LIGHT,
  BENCHMARK_WIDTH, type BenchmarkSceneFixture } from "./benchmarkScene.js";
import { benchmarkPacketSphere } from "./benchmarkPacketBounds.js";

/**
 * T00 多资产车间切片:从 Kenney Factory Kit 3.0(CC0)选 8 类资产组成确定性车间场景。
 * 布局完全确定性(6m×6m 车间 bay 模块平铺 + 南缘补齐机列),无随机、无时钟;
 * 语义分组按资产类型 = 按 geometry/draw 分簇。总实例数精确等于分档目标:
 * 每 bay 24 实例(15 个单实例资产 + 1 台 9 mesh 节点机械臂),余数用单实例机器补齐。
 */
export const WORKSHOP_COUNTS = Object.freeze([1_000, 5_000, 10_000] as const);
export type WorkshopInstanceCount = typeof WORKSHOP_COUNTS[number];

/** S1 已冻结的 machine 派生 GLB 直接复用,不重复派生。 */
const MACHINE_FILE = "FactoryMachine.glb";
const MACHINE_SHA256 = "7fd1f33c2b4cd6f9fbfe3cc1769cbc8aeb04c21c46d610d5d0105a21ef2995b4";

export interface WorkshopAssetDefinition {
  readonly id: WorkshopAssetId;
  readonly role: string;
  readonly file: string;
  /** 内嵌 colormap 后的派生 GLB SHA-256,浏览器侧逐字节复核。 */
  readonly sha256: string;
}

/** 派生哈希由 scripts/prepareT00Workshop.mjs 确定性再生;漂移即拒绝加载。 */
export const WORKSHOP_ASSETS = Object.freeze([
  Object.freeze({ id: "machine", role: "production machine", file: MACHINE_FILE, sha256: MACHINE_SHA256 }),
  Object.freeze({ id: "conveyor", role: "assembly conveyor line", file: "WorkshopConveyor.glb",
    sha256: "c0e7614b3e548f795414851c8ed4cf892e7b2b4a353ca3c6b36c07232009d9d7" }),
  Object.freeze({ id: "crate", role: "pallet crate / container", file: "WorkshopCrate.glb",
    sha256: "b19c4832b395b3bc5a2bd4ee0ef5c0662c3ae4d4608859fa0161e63f2ce5c544" }),
  Object.freeze({ id: "hopper", role: "material hopper", file: "WorkshopHopper.glb",
    sha256: "aaa5116ebcc0fdeabbbcb34967a39dfd8bfec82769ca7fe9e5307c9396806dd3" }),
  Object.freeze({ id: "column", role: "building structure column", file: "WorkshopColumn.glb",
    sha256: "d3239c145bd427938beb38eef369e56cb22c62328d660e208da909c34afd00d1" }),
  Object.freeze({ id: "catwalk", role: "elevated catwalk segment", file: "WorkshopCatwalk.glb",
    sha256: "1985dee1f58295bb98e605e6af71656a268803eba3e1d7e3f9add13850b3c9e3" }),
  Object.freeze({ id: "robotArm", role: "handling robot arm (9 mesh nodes)", file: "WorkshopRobotArm.glb",
    sha256: "67b6f2be98bb3933c1ea9afce9bdb10db77dd6931f77cc1d6c20d948f9f34189" }),
  Object.freeze({ id: "screen", role: "wall monitoring screen", file: "WorkshopScreen.glb",
    sha256: "40483ac0e377a4c78e30c5e0d56226e39414b2fc33b58c4a60568ed26c8985cb" }),
] as const satisfies readonly WorkshopAssetDefinition[]);
export type WorkshopAsset = typeof WORKSHOP_ASSETS[number];
/** 显式枚举,避免 interface↔typeof 循环引用;satisfies 保证与 WORKSHOP_ASSETS 字面量一致。 */
export type WorkshopAssetId = "machine" | "conveyor" | "crate" | "hopper" | "column" | "catwalk" | "robotArm" | "screen";

export const WORKSHOP_KIT_SOURCE = Object.freeze({
  archive: "data/external-assets/open-packs/factory.zip",
  archiveSha256: "7e31fb2308e90304672bd15cd18fa9d9f02c03731a8cbc57a8e3e1c181dfb0a7",
  colormapSha256: "35d7bd6900dde0208429eeaec87fa17fbf024ed59f3f4eab54bc92802eba9dd7",
  license: "CC0-1.0 (Kenney Factory Kit 3.0); derivatives documented by WorkshopKit.LICENSE.md",
});

export interface WorkshopPlacement { readonly asset: WorkshopAssetId; readonly x: number; readonly y: number; readonly z: number; readonly rotY: number }

/** 单个 6m×6m 车间 bay 的固定内容:16 个放置位 → 24 个渲染实例。 */
export const BAY_SIZE = 6;
export const BAY_PLACEMENTS: readonly WorkshopPlacement[] = Object.freeze([
  { asset: "machine", x: 1.5, y: 0, z: 1.5, rotY: 0 },
  { asset: "machine", x: 4.5, y: 0, z: 1.5, rotY: 0 },
  { asset: "conveyor", x: 1.0, y: 0, z: 3.0, rotY: 0 },
  { asset: "conveyor", x: 2.0, y: 0, z: 3.0, rotY: 0 },
  { asset: "conveyor", x: 3.0, y: 0, z: 3.0, rotY: 0 },
  { asset: "crate", x: 4.35, y: 0, z: 4.45, rotY: 0 },
  { asset: "crate", x: 5.45, y: 0, z: 4.45, rotY: 0 },
  { asset: "crate", x: 4.35, y: 0, z: 5.45, rotY: 0 },
  { asset: "crate", x: 5.45, y: 0, z: 5.45, rotY: 0 },
  { asset: "hopper", x: 1.5, y: 0, z: 4.5, rotY: 0 },
  { asset: "column", x: 0.15, y: 0, z: 0.55, rotY: 0 },
  { asset: "column", x: 0.15, y: 0, z: 5.45, rotY: 0 },
  { asset: "catwalk", x: 3.5, y: 2.2, z: 1.5, rotY: 0 },
  { asset: "catwalk", x: 3.5, y: 2.2, z: 4.5, rotY: 0 },
  { asset: "robotArm", x: 3.0, y: 0, z: 4.5, rotY: Math.PI / 4 },
  { asset: "screen", x: 5.85, y: 1.5, z: 3.0, rotY: -Math.PI / 2 },
]);

/** 每档的确定性 bay 数与南缘补齐机器数:总数精确命中 1,000/5,000/10,000。 */
const TIER_PLAN: Readonly<Record<WorkshopInstanceCount, { bays: number; fillMachines: number }>> = Object.freeze({
  1_000: { bays: 41, fillMachines: 16 },
  5_000: { bays: 208, fillMachines: 8 },
  10_000: { bays: 416, fillMachines: 16 },
});

export interface WorkshopAssetGroup { readonly asset: WorkshopAssetId; readonly placements: number; readonly instances: number }
export interface WorkshopLayout {
  readonly totalInstances: number;
  readonly bays: number;
  readonly bayColumns: number;
  readonly bayRows: number;
  readonly fillMachines: number;
  readonly extentMeters: { readonly x: number; readonly z: number };
  readonly placements: readonly WorkshopPlacement[];
  readonly groups: readonly WorkshopAssetGroup[];
}

/** 纯函数:同一 count 永远得到同一布局;无随机、无时钟、无浮点累积次序差。 */
export function buildWorkshopLayout(totalInstances: WorkshopInstanceCount): WorkshopLayout {
  if (!WORKSHOP_COUNTS.includes(totalInstances)) throw new RangeError("Workshop instance tier is not frozen.");
  const { bays, fillMachines } = TIER_PLAN[totalInstances];
  const bayColumns = Math.ceil(Math.sqrt(bays));
  const bayRows = Math.ceil(bays / bayColumns);
  const placements: WorkshopPlacement[] = [];
  for (let bay = 0; bay < bays; bay++) {
    const column = bay % bayColumns, row = Math.floor(bay / bayColumns);
    for (const local of BAY_PLACEMENTS) {
      placements.push({ asset: local.asset, y: local.y, rotY: local.rotY,
        x: column * BAY_SIZE + local.x, z: row * BAY_SIZE + local.z });
    }
  }
  for (let index = 0; index < fillMachines; index++) {
    placements.push({ asset: "machine", y: 0, rotY: 0, x: 0.75 + index * 1.5, z: bayRows * BAY_SIZE + 0.75 });
  }
  const instancesPerPlacement = new Map<WorkshopAssetId, number>([["robotArm" as const, 9]]);
  const groups = WORKSHOP_ASSETS.map(({ id }) => {
    const count = placements.filter(placement => placement.asset === id).length;
    return { asset: id, placements: count, instances: count * (instancesPerPlacement.get(id) ?? 1) };
  });
  const total = groups.reduce((sum, group) => sum + group.instances, 0);
  if (total !== totalInstances) throw new Error(`Workshop layout produced ${total} instances, expected ${totalInstances}.`);
  return { totalInstances: total, bays, bayColumns, bayRows, fillMachines,
    extentMeters: { x: bayColumns * BAY_SIZE, z: bayRows * BAY_SIZE + 1.5 }, placements, groups };
}

/** 列主序 4×4:placement = T(x,y,z)·R_y(rotY),与既有基准场景同一约定。 */
export function placementTransform(placement: WorkshopPlacement): number[] {
  const c = Math.cos(placement.rotY), s = Math.sin(placement.rotY);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, placement.x, placement.y, placement.z, 1];
}

/** 列主序 4×4 乘法 out = parent·child。 */
export function multiplyTransform(parent: readonly number[], child: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += parent[k * 4 + row]! * child[column * 4 + k]!;
    out[column * 4 + row] = sum;
  }
  return out;
}

const decodedByAsset = new Map<WorkshopAssetId, RenderPacket>();
const digest = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    item => item.toString(16).padStart(2, "0")).join("");

async function decodeWorkshopAsset(asset: WorkshopAsset, signal?: AbortSignal): Promise<RenderPacket> {
  const cached = decodedByAsset.get(asset.id);
  if (cached) return cached;
  const response = await fetch(`/assets/${asset.file}`, signal ? { signal } : {});
  if (!response.ok) throw new Error(`车间资产加载失败 ${asset.file} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await digest(bytes) !== asset.sha256) throw new Error(`车间资产字节漂移:${asset.file} 与冻结派生哈希不符。`);
  const packet = await decodeTexturedGlb(bytes, browserImageDecoder, {
    resourcePrefix: `Workshop/${asset.id}`, ...(signal ? { signal } : {}) });
  decodedByAsset.set(asset.id, packet);
  return packet;
}

interface TextureSlotLike { readonly texture: string }

function remapTextureSlots<T extends { baseColorTexture?: TextureSlotLike; metallicRoughnessTexture?: TextureSlotLike;
  normalTexture?: TextureSlotLike; occlusionTexture?: TextureSlotLike; emissiveTexture?: TextureSlotLike }>(
  material: T, remap: (id: string) => string): T {
  const remapSlot = (slot?: TextureSlotLike) => slot ? { ...slot, texture: remap(slot.texture) } : slot;
  return { ...material, baseColorTexture: remapSlot(material.baseColorTexture),
    metallicRoughnessTexture: remapSlot(material.metallicRoughnessTexture), normalTexture: remapSlot(material.normalTexture),
    occlusionTexture: remapSlot(material.occlusionTexture), emissiveTexture: remapSlot(material.emissiveTexture) };
}

/** 8 份派生 GLB 共享同一张 colormap;按内容哈希去重为单一纹理并重写材质引用。 */
async function mergeWorkshopTextures(parts: readonly { packet: RenderPacket }[])
  : Promise<{ textures: readonly DecodedTexture[]; remapByPart: readonly ((id: string) => string)[] }> {
  const collected: DecodedTexture[] = [];
  const remapByPart: ((id: string) => string)[] = [];
  const byContent = new Map<string, string>();
  for (const { packet } of parts) {
    const remap = new Map<string, string>();
    for (const texture of packet.textures ?? []) {
      const key = `${texture.width}x${texture.height}:${await digest(texture.data)}`;
      const existing = byContent.get(key);
      if (existing) { remap.set(texture.id, existing); continue; }
      const mergedId = `WorkshopKit/colormap-${byContent.size}`;
      byContent.set(key, mergedId);
      remap.set(texture.id, mergedId);
      collected.push({ ...texture, id: mergedId });
    }
    remapByPart.push(id => remap.get(id) ?? id);
  }
  return { textures: collected, remapByPart };
}

export function composeWorkshopPacket(layout: WorkshopLayout, parts: readonly { asset: WorkshopAssetId; packet: RenderPacket }[],
  textures: readonly DecodedTexture[], remapByPart: readonly ((id: string) => string)[]): RenderPacket {
  const geometries = parts.flatMap(({ packet }) => packet.geometries);
  const materials = parts.flatMap(({ packet }, index) =>
    packet.materials.map(material => remapTextureSlots(material, remapByPart[index]!)));
  const sourceByAsset = new Map<WorkshopAssetId, RenderPacket>(parts.map(({ asset, packet }) => [asset, packet] as const));
  const instances = layout.placements.flatMap((placement, placementIndex) => {
    const source = sourceByAsset.get(placement.asset);
    if (!source) throw new Error(`Workshop placement references unknown asset ${placement.asset}.`);
    const world = placementTransform(placement);
    return source.instances.map(instance => ({ ...instance,
      id: `${placementIndex}/${instance.id}`, transform: multiplyTransform(world, Array.from(instance.transform)) }));
  });
  return { geometries, materials, textures, instances };
}

export interface WorkshopResidencyEstimate {
  readonly geometryBytes: number;
  readonly textureBytes: number;
  readonly instanceTransformBytes: number;
  readonly totalBytes: number;
  readonly note: string;
}

/** packet 级驻留估算(上传字节数,非实际 VRAM 占用;后者以 deviceMemory 快照为准)。 */
export function estimateWorkshopResidency(packet: RenderPacket): WorkshopResidencyEstimate {
  const view = (value?: ArrayBufferView) => value?.byteLength ?? 0;
  const geometryBytes = packet.geometries.reduce((sum, geometry) => sum + view(geometry.vertices) + view(geometry.indices)
    + view(geometry.uv0) + view(geometry.uv1) + view(geometry.tangents) + view(geometry.colors), 0);
  const textureBytes = (packet.textures ?? []).reduce((sum, texture) => sum + view(texture.data)
    + (texture.mipmaps?.reduce((inner, level) => inner + view(level.data), 0) ?? 0), 0);
  const instanceTransformBytes = packet.instances.length * 64;
  return { geometryBytes, textureBytes, instanceTransformBytes,
    totalBytes: geometryBytes + textureBytes + instanceTransformBytes,
    note: "packet-level upload estimate (Float32/Uint32/RGBA arrays + 64 B per instance matrix); not actual VRAM" };
}

export async function loadFactoryWorkshopPacket(count: WorkshopInstanceCount, signal?: AbortSignal): Promise<RenderPacket> {
  const layout = buildWorkshopLayout(count);
  const parts: { asset: WorkshopAssetId; packet: RenderPacket }[] = [];
  for (const asset of WORKSHOP_ASSETS) {
    parts.push({ asset: asset.id, packet: await decodeWorkshopAsset(asset, signal) });
  }
  const { textures, remapByPart } = await mergeWorkshopTextures(parts);
  return composeWorkshopPacket(layout, parts, textures, remapByPart);
}

/**
 * 与 createAssetBenchmarkScene 同一合同的多资产版本:固定画布/灯光/地面常量,
 * 相机由完整实例集包围球推导;不经过外部 camera frame。fixture.instanceCount
 * 沿用共享 fixture 类型,车间分档(1,000/5,000/10,000)以 packet.instances.length 为权威。
 */
export async function createFactoryWorkshopScene(count: WorkshopInstanceCount,
  signal?: AbortSignal): Promise<BenchmarkSceneFixture & { layout: WorkshopLayout; residency: WorkshopResidencyEstimate }> {
  const layout = buildWorkshopLayout(count);
  const packet = await loadFactoryWorkshopPacket(count, signal);
  if (packet.instances.length !== count) throw new Error("Workshop fixture instance count drifted from the frozen tier.");
  const triangles = packet.geometries.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0);
  if (!packet.instances.length || !Number.isFinite(triangles) || triangles <= 0) throw new Error("Workshop fixture has no renderable triangles.");
  const sphere = benchmarkPacketSphere(packet);
  const extent = Math.max(0.1, sphere.radius);
  const center = sphere.center.toArray() as [number, number, number];
  const view = Object.freeze({ width: BENCHMARK_WIDTH, height: BENCHMARK_HEIGHT, pixelRatio: BENCHMARK_DPR,
    eye: [center[0] + extent * 1.4, center[1] + extent * 1.5, center[2] + extent * 1.8] as const,
    target: center, up: [0, 1, 0] as const, extent,
    background: BENCHMARK_BACKGROUND, floor: BENCHMARK_FLOOR, exposure: 1, roughness: 1,
    verticalFovRadians: Math.PI / 4, near: 0.1, far: extent * 20,
    lights: { directional: [BENCHMARK_LIGHT] } });
  const residency = estimateWorkshopResidency(packet);
  return Object.freeze({ id: `asset-FactoryWorkshop-${count}`, instanceCount: count, extent,
    transforms: Object.freeze(packet.instances.map(instance => Object.freeze(Array.from(instance.transform)))),
    packet, view, layout, residency });
}
