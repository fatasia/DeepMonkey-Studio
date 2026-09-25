// Deep Engine native GPU occlusion decision contract v1 (R4 first slice).
//
// 与 native_gpu_culling_v1.wgsl 的 frustum pass 串联:frustum 先、遮挡后。
// 本 pass 对每个候选 instance 重放与 frustum pass 逐位一致的可见性判定
// (同输入同算式,确定性等价),再做 HiZ 遮挡判定,输出 u32 标志:
//   visibility_flags[id] = 1 表示「视锥内且未被遮挡」;其余槽位保持 0
//   (flags 由 CPU 侧每次 encode 前整段清零,见 GpuOcclusionStage::encode)。
//
// 确定性纪律(docs/development.md §4):
//   - 全步定序:判定只依赖本线程输入;矩形最小值采样按 y/x 固定次序展开;
//   - 无 workgroup 共享内存、无原子操作(写槽位按 invocation id 一一对应);
//   - 深度约定:标准 Z(clip.z/w ∈ [0,1],越小越近),HiZ 为 min 缩减
//     (与 webgpu 侧 hiZPyramid 的 conservative/min 档语义一致)。
// 边界:深度金字塔由调用方提供(r32float,textureLoad 按显式 mip 读取);
// 本档按 TS hiZOcclusionMip 同式逐实例定档:足迹长边像素 → [0, top] 层,
// rect 采样按本实例层读取(top 由 OcclusionSource.mip_level 传入)。
struct InstanceRow {
  model_0: vec4f, model_1: vec4f, model_2: vec4f,
  normal_0: vec4f, normal_1: vec4f, normal_2: vec4f,
  material_0: vec4f, material_1: vec4f, material_2: vec4f,
};
struct Frustum {
  planes: array<vec4f, 6>,
  params: vec4u,
};
struct OcclusionParams {
  // [instance_count, hiz_width_at_level0, hiz_height_at_level0, top_mip_level]
  dims: vec4u,
  // [reversed_z(0=标准Z), rect_side_cap, 0, 0]
  config: vec4u,
  // [depth_scale = far/(far-near), near, focal_x = focal/aspect, focal]
  projection: vec4f,
  // [viewport_width_px, viewport_height_px, margin(1e-6), 0]
  viewport: vec4f,
  // 主视锥 view-projection,列主序,与 FrameUniform frame[0..4] 一一对应。
  view_projection_0: vec4f,
  view_projection_1: vec4f,
  view_projection_2: vec4f,
  view_projection_3: vec4f,
};

@group(0) @binding(0) var<storage, read> source_instances: array<InstanceRow>;
@group(0) @binding(1) var<storage, read> bounds: array<vec4f>;
@group(0) @binding(2) var<storage, read> metadata: array<vec4u>;
@group(0) @binding(3) var<uniform> frustum: Frustum;
@group(0) @binding(4) var<storage, read_write> visibility_flags: array<u32>;
@group(0) @binding(5) var<uniform> occlusion: OcclusionParams;
@group(0) @binding(6) var hiz: texture_2d<f32>;

fn view_projection() -> mat4x4f {
  return mat4x4f(occlusion.view_projection_0, occlusion.view_projection_1,
    occlusion.view_projection_2, occlusion.view_projection_3);
}

// 与 frustum pass 的 is_visible 逐位一致(同输入同算式),保证串联判定
// 等价于「frustum 幸存者再做遮挡」,不引入第二套视锥数学。
fn is_visible(instance: InstanceRow, bound: vec4f) -> bool {
  let local = vec4f(bound.xyz, 1.0);
  let center = vec3f(dot(instance.model_0, local), dot(instance.model_1, local),
    dot(instance.model_2, local));
  let radius = max(bound.w, 0.0);
  for (var plane = 0u; plane < 6u; plane++) {
    let value = frustum.planes[plane];
    let distance = dot(value.xyz, center) + value.w;
    if (distance >= 0.0) { continue; }
    let local_normal = value.x * instance.model_0.xyz
      + value.y * instance.model_1.xyz + value.z * instance.model_2.xyz;
    if (distance * distance > radius * radius * dot(local_normal, local_normal)) { return false; }
  }
  return true;
}

// 局部球半径经模型线性部分的最大列范数放大,得到世界半径保守上界
// (均匀缩放下精确,剪切/非均匀缩放下偏大——只少剔不误剔)。
fn world_radius(instance: InstanceRow, local_radius: f32) -> f32 {
  let column_0 = vec3f(instance.model_0.x, instance.model_1.x, instance.model_2.x);
  let column_1 = vec3f(instance.model_0.y, instance.model_1.y, instance.model_2.y);
  let column_2 = vec3f(instance.model_0.z, instance.model_1.z, instance.model_2.z);
  let largest = max(max(length(column_0), length(column_1)), length(column_2));
  return max(local_radius, 0.0) * largest;
}

@compute @workgroup_size(64)
fn occlude_instances(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= frustum.params.x) { return; }
  let item = metadata[id.x];
  if ((item.y & frustum.params.y) == 0u) { return; }
  let source = source_instances[id.x];
  let bound = bounds[id.x];
  if (!is_visible(source, bound)) { return; }
  let local = vec4f(bound.xyz, 1.0);
  let center = vec3f(dot(source.model_0, local), dot(source.model_1, local),
    dot(source.model_2, local));
  let radius = world_radius(source, bound.w);
  let clip = view_projection() * vec4f(center, 1.0);
  // 球心在相机之后(或贴合)无法可靠投影:保守保留。
  if (clip.w <= 0.0) {
    visibility_flags[id.x] = 1u;
    return;
  }
  let depth_scale = occlusion.projection.x;
  let near = occlusion.projection.y;
  // 球体最近视深 = 球心视深(clip.w) − 世界半径,再夹到近平面:
  // 取更近的判定深度只会减少剔除,保守。
  let nearest_w = max(clip.w - radius, near);
  // 标准 Z:depth(w) = depth_scale * (w - near) / w。
  let instance_depth = depth_scale * (nearest_w - near) / nearest_w;
  // 保守屏幕矩形:逐轴像素半径用 focal * r / w(轴对齐上界)。
  let ndc = clip.xy / clip.w;
  let pixel = (ndc * vec2f(0.5, 0.5) + vec2f(0.5, 0.5)) * occlusion.viewport.xy;
  let radius_px = vec2f(occlusion.projection.z, occlusion.projection.w)
    * (vec2f(radius, radius) / vec2f(clip.w, clip.w)) * (occlusion.viewport.xy * vec2f(0.5, 0.5));
  // 逐实例 mip 定档(TS hiZOcclusionMip 同式):足迹长边像素数 →
  // min(ceil(log2(longest_side)), top)。小足迹落细层(精度),大足迹落粗层
  // (rect 迭代成本有界)。粗层 texel = 区域 min,层内 rect 由同一足迹折算,
  // 覆盖恒不小于细层足迹,判定保守性不变;NaN/inf 经 max/min 的非 NaN
  // 分支落 0 层或顶层,均在保守侧。
  let footprint_px = max(2.0 * max(radius_px.x, radius_px.y), 1.0);
  let level = u32(min(ceil(log2(footprint_px)), f32(occlusion.dims.w)));
  let bin = exp2(f32(level));
  let mip_dims = vec2i(
    i32(max(occlusion.dims.y >> level, 1u)),
    i32(max(occlusion.dims.z >> level, 1u)),
  );
  let side_cap = i32(occlusion.config.y);
  let low = max(vec2i(0, 0),
    min(vec2i(floor((pixel - radius_px) / vec2f(bin, bin))), mip_dims - vec2i(1, 1)));
  let high = max(vec2i(0, 0),
    min(vec2i(ceil((pixel + radius_px) / vec2f(bin, bin))), mip_dims - vec2i(1, 1)));
  let low_capped = max(low, high - vec2i(side_cap - 1, side_cap - 1));
  // 定序最小值:固定 y 外层、x 内层;空矩形(理论不可达)保持 1.0 = 远平面,保守保留。
  var scene_min = 1.0;
  for (var y = low_capped.y; y <= high.y; y++) {
    for (var x = low_capped.x; x <= high.x; x++) {
      scene_min = min(scene_min, textureLoad(hiz, vec2i(x, y), i32(level)).x);
    }
  }
  // 遮挡判定(标准 Z):足迹内最近场景深度比球的最近判定深度还近,
  // 带 1e-6 裕量,才认定整球被遮挡。
  if (scene_min + occlusion.viewport.z < instance_depth) { return; }
  visibility_flags[id.x] = 1u;
}
