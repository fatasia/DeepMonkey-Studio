import { FORWARD_PLUS_CLUSTER_ABI_WGSL } from "./clusterAbiWgsl.js";
import { FORWARD_PLUS_LIGHT_ABI_WGSL } from "./lightAbiWgsl.js";

export const FORWARD_PLUS_CLUSTER_WORKGROUP_SIZE = 64;

/** One workgroup owns one cluster and compacts 64-light batches in ABI order. */
export const FORWARD_PLUS_CLUSTER_ASSIGN_WGSL = /* wgsl */ `${FORWARD_PLUS_LIGHT_ABI_WGSL}
${FORWARD_PLUS_CLUSTER_ABI_WGSL}
struct LightBounds {
  minTileX: u32, maxTileX: u32, minTileY: u32, maxTileY: u32,
  minSlice: u32, maxSlice: u32, valid: u32,
};
@group(0) @binding(0) var<storage, read> localLights: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> params: ClusterParamsAbi;
@group(0) @binding(2) var<storage, read_write> headers: array<ClusterHeaderAbi>;
@group(0) @binding(3) var<storage, read_write> lightIndices: array<u32>;
@group(0) @binding(4) var<storage, read_write> overflowCount: atomic<u32>;
var<workgroup> acceptedPrefix: array<u32, ${FORWARD_PLUS_CLUSTER_WORKGROUP_SIZE}>;

fn depthSlice(depth: f32) -> u32 {
  let slices = params.grid1.z;
  let near = params.projection.x;
  let far = params.projection.y;
  let normalized = log(clamp(depth, near, far) / near) / log(far / near);
  return min(slices - 1u, u32(floor(normalized * f32(slices))));
}

fn tileAt(ndc: f32, viewport: u32, tileSize: u32, tileCount: u32) -> u32 {
  let pixel = clamp((ndc * 0.5 + 0.5) * f32(viewport), 0.0, f32(viewport) - 0.0001);
  return min(tileCount - 1u, u32(floor(pixel / f32(tileSize))));
}

fn boundsForSphere(sphere: vec4<f32>) -> LightBounds {
  let viewportWidth = params.grid0.x; let viewportHeight = params.grid0.y;
  let tileSizeX = params.grid0.z; let tileSizeY = params.grid0.w;
  let tilesX = params.grid1.x; let tilesY = params.grid1.y;
  let near = params.projection.x; let far = params.projection.y;
  let tanHalfFovY = params.projection.z; let aspect = params.projection.w;
  let depth = -sphere.z; let range = sphere.w;
  if (range == 0.0) { return LightBounds(0u, tilesX - 1u, 0u, tilesY - 1u, 0u, params.grid1.z - 1u, 1u); }
  if (depth + range < near || depth - range > far) { return LightBounds(0u, 0u, 0u, 0u, 0u, 0u, 0u); }
  let minSlice = depthSlice(max(near, depth - range));
  let maxSlice = depthSlice(min(far, depth + range));
  if (depth <= range || depth - range <= near) {
    return LightBounds(0u, tilesX - 1u, 0u, tilesY - 1u, minSlice, maxSlice, 1u);
  }
  let tanHalfFovX = tanHalfFovY * aspect;
  let closestDepth = max(near, depth - range);
  let centerX = sphere.x / (depth * tanHalfFovX); let centerY = sphere.y / (depth * tanHalfFovY);
  let radiusX = range / (closestDepth * tanHalfFovX); let radiusY = range / (closestDepth * tanHalfFovY);
  let minX = centerX - radiusX; let maxX = centerX + radiusX;
  let minY = centerY - radiusY; let maxY = centerY + radiusY;
  if (maxX < -1.0 || minX > 1.0 || maxY < -1.0 || minY > 1.0) { return LightBounds(0u, 0u, 0u, 0u, 0u, 0u, 0u); }
  return LightBounds(
    tileAt(max(-1.0, minX), viewportWidth, tileSizeX, tilesX),
    tileAt(min(1.0, maxX), viewportWidth, tileSizeX, tilesX),
    // Fragment coordinates use a top-left origin, so projected view +Y maps toward tile zero.
    tileAt(max(-1.0, -maxY), viewportHeight, tileSizeY, tilesY),
    tileAt(min(1.0, -minY), viewportHeight, tileSizeY, tilesY),
    minSlice, maxSlice, 1u);
}

@compute @workgroup_size(64)
fn assignClusters(
  @builtin(workgroup_id) workgroup: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(num_workgroups) workgroupCount: vec3<u32>,
) {
  let clusterCount = params.limits.y; let maxPerCluster = params.limits.x;
  let xyCount = params.grid1.x * params.grid1.y;
  for (var cluster = workgroup.x; cluster < clusterCount; cluster += workgroupCount.x) {
    let xy = cluster % xyCount; let tileX = xy % params.grid1.x; let tileY = xy / params.grid1.x;
    let slice = cluster / xyCount; let outputOffset = cluster * maxPerCluster;
    if (local.x == 0u) { headers[cluster].offset = outputOffset; headers[cluster].count = 0u; }
    for (var slot = local.x; slot < maxPerCluster; slot += ${FORWARD_PLUS_CLUSTER_WORKGROUP_SIZE}u) {
      lightIndices[outputOffset + slot] = 0xffffffffu;
    }
    workgroupBarrier();

    var count = 0u;
    for (var base = 0u; base < params.grid1.w; base += ${FORWARD_PLUS_CLUSTER_WORKGROUP_SIZE}u) {
      let light = base + local.x;
      var inside = false;
      if (light < params.grid1.w) {
        let bounds = boundsForSphere(localLights[light]);
        inside = bounds.valid == 1u && tileX >= bounds.minTileX && tileX <= bounds.maxTileX
          && tileY >= bounds.minTileY && tileY <= bounds.maxTileY && slice >= bounds.minSlice && slice <= bounds.maxSlice;
      }
      acceptedPrefix[local.x] = select(0u, 1u, inside);
      workgroupBarrier();
      for (var scanOffset = 1u; scanOffset < ${FORWARD_PLUS_CLUSTER_WORKGROUP_SIZE}u; scanOffset *= 2u) {
        var addend = 0u;
        if (local.x >= scanOffset) { addend = acceptedPrefix[local.x - scanOffset]; }
        workgroupBarrier();
        acceptedPrefix[local.x] += addend;
        workgroupBarrier();
      }
      let rank = acceptedPrefix[local.x];
      let batchCount = acceptedPrefix[${FORWARD_PLUS_CLUSTER_WORKGROUP_SIZE - 1}u];
      if (inside && count + rank <= maxPerCluster) {
        lightIndices[outputOffset + count + rank - 1u] = light;
      }
      if (local.x == 0u && count + batchCount > maxPerCluster) {
        atomicAdd(&overflowCount, count + batchCount - max(maxPerCluster, count));
      }
      count += batchCount;
      workgroupBarrier();
    }
    if (local.x == 0u) { headers[cluster].count = min(count, maxPerCluster); }
    workgroupBarrier();
  }
}
`;
