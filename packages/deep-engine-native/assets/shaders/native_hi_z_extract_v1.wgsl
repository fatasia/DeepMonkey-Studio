// Deep Engine native Hi-Z level-0 extraction v1 (R4 生产接线切片)。
//
// 输入:主视锥 4x MSAA Depth24Plus 深度(opaque pass 写完后按纹理读,
// RENDER_ATTACHMENT → TEXTURE_BINDING 转换由 wgpu 在 pass 间自动插入屏障)。
// 输出:金字塔第 0 层 r32float(标准 Z,越小越近)。
//
// 为什么是手写内核(如实):源是 multisampled depth24plus,超出 DCIR v0
// r32float texel-load 合同(与 webgpu 侧 copy 内核保留手写的同一理由);
// 第 1 级起的缩减链复用已认证的 DCIR 工件(dcir_hi_z_*_min_v1.wgsl)。
//
// 转换方案(记录在 docs/development.md §HiZ):
// copy_texture 不可行(multisampled 禁 COPY_SRC 且格式须一致),wgpu render
// pass 的 resolve_target 不支持深度;本内核在一次全屏 render pass 内采样
// MSAA 深度重写为 r32float 颜色,免中间 depth32float 纹理与 frag_depth。
//
// 确定性纪律(docs/development.md §4):
//   - 4 样本按 0..3 固定次序 min 展开(定序,与样本数常量 4 = 4x MSAA 一致);
//   - 无共享内存、无原子;±0 由 min 保持,缩减链内核负责 +0 规范化。

struct VsOutput {
  @builtin(position) position: vec4f,
};

@vertex
fn vs_extract(@builtin(vertex_index) index: u32) -> VsOutput {
  var corners = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  return VsOutput(vec4f(corners[index], 0.0, 1.0));
}

@group(0) @binding(0) var source_depth: texture_depth_multisampled_2d;

@fragment
fn fs_extract(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let coord = vec2<i32>(position.xy);
  // nearest = 4 样本最近值:遮挡判定的保守输入(样本间不可能有更近面)。
  var nearest = textureLoad(source_depth, coord, 0u);
  nearest = min(nearest, textureLoad(source_depth, coord, 1u));
  nearest = min(nearest, textureLoad(source_depth, coord, 2u));
  nearest = min(nearest, textureLoad(source_depth, coord, 3u));
  return vec4f(nearest, 0.0, 0.0, 0.0);
}
