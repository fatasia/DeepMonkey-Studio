import { VIRTUAL_SHADOW_MIP_COUNT, VIRTUAL_SHADOW_PAGE_EDGE, VIRTUAL_SHADOW_PAGE_GRID,
  VIRTUAL_SHADOW_VIRTUAL_EDGE } from "../shadows/virtualShadowClipmap.js";
import { VIRTUAL_SHADOW_ATLAS_TILES } from "../shadows/virtualShadowPages.js";

/**
 * B1 Brief-VSM 着色端虚拟阴影采样(页表查询合同 + PCSS WGSL 库)。
 *
 * 页表绑定合同与 F4 virtualTextureSampling 的 tile-lookup 同形(params/meta/layers
 * 三段、-1 缺页哨兵、页内相对 uv × texel 基准),差异仅在消费侧:
 * - meta 按 (ring, mip) 而非 (texture, mip);layers 存打包物理 slot(layer·256+ty·16+tx);
 * - atlas 为 r32float depth-as-float(depth-as-float 降级方案:WebGPU 不能对 depth
 *   attachment 做页级 viewport 写出后再按普通 f32 采样;r32float 渲染附件核心可写、
 *   textureLoad 无过滤需求,绕开 float32-filterable 扩展,证据见验收④ harness);
 * - 采样 textureLoad 手动 tap(页内 clamp,零跨页渗色),无 comparison sampler。
 *
 * WGSL 组合点:pbrShader.ts 以 `${CASCADED_SHADOW_WGSL}\n${VIRTUAL_SHADOW_WGSL}`
 * 前置注入;级联档 params2.x=0 时全部函数不进入采样分支(既有路径逐字节等价)。
 */

/** 页表 GPU 装载:params 常量段 + 每 (ring, mip) 元数据行 + 页→打包 slot 段。 */
export interface VirtualShadowPageTablePacking {
  readonly params: Uint32Array<ArrayBuffer>;
  readonly meta: Uint32Array<ArrayBuffer>;
  readonly layers: Int32Array<ArrayBuffer>;
}

/** 物理 slot 打包:layer·256 + tileY·16 + tileX(与 layers 数组同一编码,-1 = 缺页)。 */
export function packVirtualShadowSlot(layer: number, tileX: number, tileY: number): number {
  if (!Number.isSafeInteger(layer) || layer < 0 || layer >= 256
    || !Number.isSafeInteger(tileX) || tileX < 0 || tileX >= VIRTUAL_SHADOW_ATLAS_TILES
    || !Number.isSafeInteger(tileY) || tileY < 0 || tileY >= VIRTUAL_SHADOW_ATLAS_TILES) {
    throw new RangeError("Virtual shadow slot components are out of range.");
  }
  return layer * 256 + tileY * VIRTUAL_SHADOW_ATLAS_TILES + tileX;
}

/**
 * 页表 CPU 打包:布局与 packVirtualTexturePageTable 同一合同——
 * meta 每 (ring, mip) 一行 [gridW, gridH, layersBase, 0],layers 段 -1 = 缺页。
 * slotOfPage 返回该页的打包物理 slot(layer·256 + slotY·16 + slotX;undefined = 缺页)
 * —— 物理 atlas tile(0..15)与页表虚拟 tile(0..127)是两个坐标系,由驻留层
 * (VirtualShadowPageTable)持有物理槽位,打包器只透传,不二次编码。
 */
export function packVirtualShadowPageTable(ringCount: number,
  slotOfPage: (ring: number, mip: number, tileX: number, tileY: number) => number | undefined):
    VirtualShadowPageTablePacking {
  if (!Number.isSafeInteger(ringCount) || ringCount < 1 || ringCount > 4) {
    throw new RangeError("Virtual shadow ring count must be a safe integer 1..4.");
  }
  if (typeof slotOfPage !== "function") throw new TypeError("Virtual shadow page table expects a slotOfPage provider.");
  const metaRows = ringCount * VIRTUAL_SHADOW_MIP_COUNT;
  // layers 段 = ringCount × Σ(grid²):少乘 ringCount 会让 ring1+ 的页表写入越界
  // 被TypedArray 静默丢弃(真机教训:全部采样回退失败 → 全图受光)。
  let layerCount = 0;
  const grids: number[] = [];
  for (let mip = 0; mip < VIRTUAL_SHADOW_MIP_COUNT; mip++) {
    const grid = VIRTUAL_SHADOW_PAGE_GRID >> mip;
    grids.push(grid);
  }
  layerCount = ringCount * grids.reduce((total, grid) => total + grid * grid, 0);
  const meta = new Uint32Array(metaRows * 4);
  const layers = new Int32Array(layerCount).fill(-1);
  let cursor = 0;
  for (let ring = 0; ring < ringCount; ring++) {
    for (let mip = 0; mip < VIRTUAL_SHADOW_MIP_COUNT; mip++) {
      const grid = grids[mip]!;
      const row = (ring * VIRTUAL_SHADOW_MIP_COUNT + mip) * 4;
      meta[row] = grid; meta[row + 1] = grid; meta[row + 2] = cursor; meta[row + 3] = 0;
      for (let tileY = 0; tileY < grid; tileY++) {
        for (let tileX = 0; tileX < grid; tileX++) {
          const packed = slotOfPage(ring, mip, tileX, tileY);
          if (packed === undefined) continue;
          layers[cursor + tileY * grid + tileX] = packed;
        }
      }
      cursor += grid * grid;
    }
  }
  const params = new Uint32Array([ringCount, VIRTUAL_SHADOW_MIP_COUNT, VIRTUAL_SHADOW_PAGE_EDGE,
    VIRTUAL_SHADOW_VIRTUAL_EDGE]);
  return { params, meta, layers };
}

/**
 * 虚拟阴影采样库(WGSL,依赖 DeepCascadeShadowData.params2 与 binding 3..5)。
 * - 环回退:近环足迹内页缺失 → 同环粗 mip → 上一环;三环全缺 → 1.0(覆盖域外,
 *   与 CSM beyond-last-split 同语义;环内足迹由顶 mip 钉住保证有叶,零洞);
 * - PCSS:遮挡搜索 + 半影估计,软化随 (receiver−blocker) 遮挡距离;texelWorld1.x=0 退 3×3 PCF;
 * - fwidth 只在一致控制流预计算(环梯度数组),回退链内不再取导数。
 */
export const VIRTUAL_SHADOW_WGSL = /* wgsl */ `
const DEEP_VSM_MAX_RINGS: u32 = 3u;
const DEEP_VSM_ATLAS_TILES: u32 = ${VIRTUAL_SHADOW_ATLAS_TILES}u;

@group(0) @binding(12) var<storage, read> deepVsmMeta : array<vec4u>;
@group(0) @binding(13) var<storage, read> deepVsmLayers : array<i32>;
@group(0) @binding(14) var deepVsmAtlas : texture_2d_array<f32>;

struct DeepVsmHit {
  found : bool,
  slot : i32,
  pageTexel : vec2f,
  texelWorld : f32,
  receiverDepth : f32,
  depthSpan : f32,
};

fn deepVsmRingCount() -> u32 { return clamp(u32(deepCascade.params2.y), 1u, DEEP_VSM_MAX_RINGS); }
fn deepVsmTopMip() -> u32 { return clamp(u32(deepCascade.params2.z), 0u, 7u); }
fn deepVsmPageEdge() -> f32 { return max(deepCascade.params2.w, 1.0); }

fn deepVsmMetaRow(ring: u32, mip: u32) -> vec4u {
  return deepVsmMeta[ring * (deepVsmTopMip() + 1u) + mip];
}

fn deepVsmMiss() -> DeepVsmHit {
  var hit : DeepVsmHit;
  hit.found = false; hit.slot = -1; hit.pageTexel = vec2f(0.0);
  hit.texelWorld = 0.0; hit.receiverDepth = 0.0; hit.depthSpan = 1.0;
  return hit;
}

/** 页内单点取深(slot 解码页原点;页内 clamp 防跨页渗色)。slot = layer·256+ty·16+tx。 */
fn deepVsmFetch(slot: i32, pageTexel: vec2f) -> f32 {
  let edge = deepVsmPageEdge();
  let local = clamp(pageTexel, vec2f(0.5), vec2f(edge - 0.5));
  let packed = u32(max(slot, 0));
  let tileX = packed % DEEP_VSM_ATLAS_TILES;
  let tileY = (packed / DEEP_VSM_ATLAS_TILES) % DEEP_VSM_ATLAS_TILES;
  let layer = packed / (DEEP_VSM_ATLAS_TILES * DEEP_VSM_ATLAS_TILES);
  let coords = vec3i(vec2i(vec2u(tileX, tileY) * u32(edge)), i32(layer));
  // texture_2d_array 的 load 形参是 (coords.xy, array_index, level),vec3 打包需显式拆分。
  return textureLoad(deepVsmAtlas, coords.xy, coords.z, 0).r;
}

/** 环内解析:期望 mip(fwidth 梯度)→ 粗 mip 链回退;全缺返回 miss。 */
fn deepVsmResolveRing(ring: u32, receiver: vec3f, px: vec2f) -> DeepVsmHit {
  let clip = deepCascade.matrices[ring] * vec4f(receiver, 1.0);
  if (clip.w <= 0.0) { return deepVsmMiss(); }
  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) { return deepVsmMiss(); }
  // 期望 mip 与 CPU 物化端同一 round 合同(Math.round(log2(期望texel/环texel))):
  // ceil 会使着色端比物化端粗一档,细页命中失败退到粗环,边缘锯齿恶化(真机①门教训)。
  let pixelsPerVirtualTexel = max(max(px.x, px.y), 0.000001) * deepCascade.texelWorld0.w;
  let mipLog = log2(pixelsPerVirtualTexel);
  let desired = clamp(u32(select(0.0, floor(mipLog + 0.5), mipLog >= 0.0)), 0u, deepVsmTopMip());
  let ringTexel = deepCascade.texelWorld0[ring];
  var hit = deepVsmMiss();
  var mip = desired;
  loop {
    // meta 是 WGSL 保留字,局部重命名为 metaRow(语义不变)。
    let metaRow = deepVsmMetaRow(ring, mip);
    let tileUv = uv * vec2f(metaRow.xy);
    let tile = floor(tileUv);
    let layer = deepVsmLayers[metaRow.z + u32(tile.y) * u32(metaRow.x) + u32(tile.x)];
    if (layer >= 0) {
      hit.found = true; hit.slot = layer;
      hit.pageTexel = (tileUv - tile) * deepVsmPageEdge();
      hit.texelWorld = ringTexel * exp2(f32(mip));
      hit.receiverDepth = ndc.z;
      hit.depthSpan = deepCascade.splitDepths0[ring];
      break;
    }
    if (mip >= deepVsmTopMip()) { break; }
    mip = mip + 1u;
  }
  // 粗向走查全缺时回试一档更细页(梯度与 CPU 物化 ±1 的残差;细页只提升密度,
  // tap 半径按命中页 texelWorld 自缩放,无欠采样风险)。
  if (!hit.found && desired > 0u) {
    let metaRow = deepVsmMetaRow(ring, desired - 1u);
    let tileUv = uv * vec2f(metaRow.xy);
    let tile = floor(tileUv);
    let layer = deepVsmLayers[metaRow.z + u32(tile.y) * u32(metaRow.x) + u32(tile.x)];
    if (layer >= 0) {
      hit.found = true; hit.slot = layer;
      hit.pageTexel = (tileUv - tile) * deepVsmPageEdge();
      hit.texelWorld = ringTexel * exp2(f32(desired - 1u));
      hit.receiverDepth = ndc.z;
      hit.depthSpan = deepCascade.splitDepths0[ring];
    }
  }
  return hit;
}

/** 交错梯度噪声(旋转 PCSS 盘,去带状)。 */
fn deepVsmNoise(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

fn deepVsmFilter(hit: DeepVsmHit, nDotL: f32, pixel: vec2f) -> f32 {
  let edge = deepVsmPageEdge();
  let bias = deepCascade.texelWorld1.y;
  let receiverDepth = hit.receiverDepth - bias;
  let lightWorld = max(deepCascade.texelWorld1.x, 0.0);
  let pageWorld = hit.texelWorld * edge;
  // PCSS 遮挡搜索:光世界尺寸映射到页 uv;命中遮挡取平均 blocker 深度。
  var blockerSum = 0.0; var blockerCount = 0.0;
  let searchWorld = max(lightWorld, hit.texelWorld * 1.5);
  let searchPageUv = min(searchWorld / max(pageWorld, 0.000001), 0.25);
  let phi = deepVsmNoise(pixel) * 6.283185307179586;
  for (var index = 0u; index < 4u; index = index + 1u) {
    let angle = phi + f32(index) * 1.5707963267948966;
    let offset = vec2f(cos(angle), sin(angle)) * searchPageUv * 0.7;
    let depth = deepVsmFetch(hit.slot, hit.pageTexel + offset * edge);
    if (depth < receiverDepth) { blockerSum += depth; blockerCount += 1.0; }
  }
  var filterWorld = hit.texelWorld;
  if (lightWorld > 0.0 && blockerCount > 0.5) {
    let blocker = max(blockerSum / blockerCount, 0.0001);
    let penumbraWorld = lightWorld * max(receiverDepth - blocker, 0.0) / max(receiverDepth, 0.0001);
    filterWorld = clamp(penumbraWorld, hit.texelWorld, pageWorld * 0.25);
  }
  let filterTexels = clamp(filterWorld / max(hit.texelWorld, 0.000001), 1.0, 24.0);
  let radius = filterTexels * 0.5;
  // WGSL 无三目运算符,条件取值用 select(语义不变)。
  var visibility = select(0.0, 1.0, deepVsmFetch(hit.slot, hit.pageTexel) >= receiverDepth);
  for (var index = 0u; index < 8u; index = index + 1u) {
    let angle = phi + f32(index) * 0.7853981633974483;
    let offset = vec2f(cos(angle), sin(angle)) * (radius / edge);
    visibility += f32(select(0.0, 1.0, deepVsmFetch(hit.slot, hit.pageTexel + offset * edge) >= receiverDepth));
  }
  return visibility / 9.0;
}

/** 虚拟阴影入口:近→远环回退链;全缺 = 1.0(覆盖域外无阴影)。 */
fn deepVirtualShadow(world: vec3f, normal: vec3f, nDotL: f32, pixel: vec2f,
  grad0: vec2f, grad1: vec2f, grad2: vec2f) -> f32 {
  // 环梯度由调用方在一致控制流内预取后传入(fwidth 合法性:调用链在进入本函数前
  // 不能穿越非一致分支;环回退链本身是发散控制流,禁止在链内取导数)。
  let rings = deepVsmRingCount();
  let slopeBias = 1.0 - clamp(nDotL, 0.0, 1.0);
  var result = 1.0;
  var resolved = false;
  var ring = 0u;
  loop {
    if (resolved || ring >= rings) { break; }
    // 接收器斜率偏移按本环 texel(CSM 同式),环内粗 mip 由解析期放大 texelWorld 覆盖。
    let ringTexel = deepCascade.texelWorld0[ring];
    let offset = ringTexel * (0.75 + slopeBias);
    var hit = deepVsmMiss();
    if (ring == 0u) { hit = deepVsmResolveRing(0u, world + normal * offset, grad0); }
    else if (ring == 1u) { hit = deepVsmResolveRing(1u, world + normal * offset, grad1); }
    else { hit = deepVsmResolveRing(2u, world + normal * offset, grad2); }
    if (hit.found) { result = deepVsmFilter(hit, nDotL, pixel); resolved = true; }
    ring = ring + 1u;
  }
  return result;
}
`;
