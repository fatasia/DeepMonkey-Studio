// I 级 C2 集群光源剔除(light-centric,MegaLights 同族)——共享单源。
// 与 B1 clusterCompute(cluster-centric,每簇扫全部灯,O(簇数×灯数))的语义相同输出,
// 成本换成 O(灯数×平均触达簇数):每灯只做一次视锥球投影,再原子追加到重叠簇。
// 输出 ABI 与 FORWARD_PLUS_CLUSTER_ABI_WGSL v2 逐字一致(headers+offset/count 固定步长
// 索引表),group-3 片段着色(deepClusterHeaders/deepClusterLightIndices)零改动可消费。
// 同一 encoder 内三个有序 compute pass(pass 边界内存序是 WebGPU 规范强保证;
// 同 pass 多 dispatch 可见性存在实现分歧,实测真机全簇计数归零,故逐 pass 括夹):
//   resetLists(清零/哨兵) → cullLights(灯心原子追加) → finalizeCounts(预算钳制)。
struct ClusterParamsAbi {
  grid0: vec4<u32>,
  grid1: vec4<u32>,
  limits: vec4<u32>,
  projection: vec4<f32>,
  area: vec4<u32>,
};
struct ClusterHeaderAbi { offset: u32, count: u32 };
struct LightCullBounds {
  minTileX: u32, maxTileX: u32, minTileY: u32, maxTileY: u32,
  minSlice: u32, maxSlice: u32, valid: u32,
};
@group(0) @binding(0) var<storage, read> localLights: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> params: ClusterParamsAbi;
// headers 以扁平 atomic<u32> 视图声明:atomic<u32> 的内存表示与 u32 相同,[offset,count]
// 交错布局逐字节不变,B1 消费端(ClusterHeaderAbi)按 struct 解释同一 buffer。
@group(0) @binding(2) var<storage, read_write> headers: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> lightIndices: array<u32>;
@group(0) @binding(4) var<storage, read_write> overflowCount: atomic<u32>;

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

fn boundsForSphere(sphere: vec4<f32>) -> LightCullBounds {
  let viewportWidth = params.grid0.x; let viewportHeight = params.grid0.y;
  let tileSizeX = params.grid0.z; let tileSizeY = params.grid0.w;
  let tilesX = params.grid1.x; let tilesY = params.grid1.y;
  let near = params.projection.x; let far = params.projection.y;
  let tanHalfFovY = params.projection.z; let aspect = params.projection.w;
  let depth = -sphere.z; let range = sphere.w;
  if (range == 0.0) { return LightCullBounds(0u, tilesX - 1u, 0u, tilesY - 1u, 0u, params.grid1.z - 1u, 1u); }
  if (depth + range < near || depth - range > far) { return LightCullBounds(0u, 0u, 0u, 0u, 0u, 0u, 0u); }
  let minSlice = depthSlice(max(near, depth - range));
  let maxSlice = depthSlice(min(far, depth + range));
  if (depth <= range || depth - range <= near) {
    return LightCullBounds(0u, tilesX - 1u, 0u, tilesY - 1u, minSlice, maxSlice, 1u);
  }
  let tanHalfFovX = tanHalfFovY * aspect;
  let closestDepth = max(near, depth - range);
  let centerX = sphere.x / (depth * tanHalfFovX); let centerY = sphere.y / (depth * tanHalfFovY);
  let radiusX = range / (closestDepth * tanHalfFovX); let radiusY = range / (closestDepth * tanHalfFovY);
  let minX = centerX - radiusX; let maxX = centerX + radiusX;
  let minY = centerY - radiusY; let maxY = centerY + radiusY;
  if (maxX < -1.0 || minX > 1.0 || maxY < -1.0 || minY > 1.0) { return LightCullBounds(0u, 0u, 0u, 0u, 0u, 0u, 0u); }
  return LightCullBounds(
    tileAt(max(-1.0, minX), viewportWidth, tileSizeX, tilesX),
    tileAt(min(1.0, maxX), viewportWidth, tileSizeX, tilesX),
    // 片元坐标原点在左上,视空间 +Y 投影朝 tile 0(与 B1 同一符号约定)。
    tileAt(max(-1.0, -maxY), viewportHeight, tileSizeY, tilesY),
    tileAt(min(1.0, -minY), viewportHeight, tileSizeY, tilesY),
    minSlice, maxSlice, 1u);
}

@compute @workgroup_size(64)
fn resetLists(
  @builtin(workgroup_id) workgroup: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(num_workgroups) workgroupCount: vec3<u32>,
) {
  let clusterCount = params.limits.y; let maxPerCluster = params.limits.x;
  for (var cluster = workgroup.x; cluster < clusterCount; cluster += workgroupCount.x) {
    atomicStore(&headers[cluster * 2u], cluster * maxPerCluster);
    atomicStore(&headers[cluster * 2u + 1u], 0u);
    for (var slot = local.x; slot < maxPerCluster; slot += 64u) {
      lightIndices[cluster * maxPerCluster + slot] = 0xffffffffu;
    }
  }
}

@compute @workgroup_size(64)
fn cullLights(
  @builtin(workgroup_id) workgroup: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
) {
  let light = workgroup.x * 64u + local.x;
  if (light >= params.grid1.w) { return; }
  let bounds = boundsForSphere(localLights[light]);
  if (bounds.valid == 0u) { return; }
  let maxPerCluster = params.limits.x;
  let xyCount = params.grid1.x * params.grid1.y;
  for (var slice = bounds.minSlice; slice <= bounds.maxSlice; slice += 1u) {
    let sliceBase = slice * xyCount;
    for (var tileY = bounds.minTileY; tileY <= bounds.maxTileY; tileY += 1u) {
      let rowBase = sliceBase + tileY * params.grid1.x;
      for (var tileX = bounds.minTileX; tileX <= bounds.maxTileX; tileX += 1u) {
        let cluster = rowBase + tileX;
        let rank = atomicAdd(&headers[cluster * 2u + 1u], 1u);
        if (rank < maxPerCluster) { lightIndices[cluster * maxPerCluster + rank] = light; }
        else { atomicAdd(&overflowCount, 1u); }
      }
    }
  }
}

@compute @workgroup_size(64)
fn finalizeCounts(
  @builtin(workgroup_id) workgroup: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(num_workgroups) workgroupCount: vec3<u32>,
) {
  let clusterCount = params.limits.y; let maxPerCluster = params.limits.x;
  for (var cluster = workgroup.x; cluster < clusterCount; cluster += workgroupCount.x) {
    if (local.x == 0u) {
      let count = atomicLoad(&headers[cluster * 2u + 1u]);
      atomicStore(&headers[cluster * 2u + 1u], min(count, maxPerCluster));
    }
  }
}
