// Deep Engine native GPU occlusion compaction contract v1 (R4 second slice).
//
// 消费 native_gpu_occlusion_v1.wgsl 输出的 per-instance u32 可见标志,产出
// 按 instance id 升序紧凑的 draw 输出:compact_visible(行槽 = 批次
// instance_start + 批次内幸存序)+ compact_indirect(per 批次 instance_count)。
// 与 frustum pass 的输出逐槽兼容(行 144B、indirect 20B、槽位基于批次区域),
// 主视锥 draw 侧只需换绑缓冲对即可减少 draw/顶点工作量。
//
// 确定性纪律(R4 第二切片门禁):
//   - 全定序:所有归约/扫描按下标升序固定方向展开;输出槽位是输入的确定函数;
//   - 无 workgroup 共享内存、无原子操作(每个写槽位由唯一 invocation 写);
//   - 五个 entry point 依次派发(独立 compute pass,依赖经 pass 边界屏障)。
// 复杂度(如实):块内前缀 O(64)/实例;block_offsets 为单线程 O(block_count)
// 顺序扫(block_count ≤ 1048576/64 = 16384,预算内常数量级),换取零原子。
struct InstanceRow {
  model_0: vec4f, model_1: vec4f, model_2: vec4f,
  normal_0: vec4f, normal_1: vec4f, normal_2: vec4f,
  material_0: vec4f, material_1: vec4f, material_2: vec4f,
};
struct IndirectCommand {
  index_count: u32,
  instance_count: u32,
  first_index: u32,
  base_vertex: i32,
  first_instance: u32,
};
struct CompactParams {
  // [instance_count, block_count, batch_count, 0](块 = 64 实例,与
  // GPU_CULLING_WORKGROUP_SIZE 一致)
  dims: vec4u,
};

@group(0) @binding(0) var<storage, read> visibility_flags: array<u32>;
@group(0) @binding(1) var<storage, read_write> block_sums: array<u32>;
@group(0) @binding(2) var<storage, read_write> block_offsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> instance_prefix: array<u32>;
@group(0) @binding(4) var<storage, read> source_instances: array<InstanceRow>;
@group(0) @binding(5) var<storage, read> metadata: array<vec4u>;
@group(0) @binding(6) var<storage, read_write> compact_visible: array<InstanceRow>;
@group(0) @binding(7) var<storage, read> batch_ranges: array<vec4u>;
@group(0) @binding(8) var<storage, read_write> compact_indirect: array<IndirectCommand>;
@group(0) @binding(9) var<uniform> compact: CompactParams;

// 每个 entry point 只静态使用自己的缓冲;Rust 侧按 entry point 拆分
// bind group(max_storage_buffers_per_shader_stage 默认上限 8)。

// K1:每 invocation 固定负责一个 64 实例块,升序累加块内标志 → block_sums。
@compute @workgroup_size(64)
fn scan_blocks(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= compact.dims.y) { return; }
  var total = 0u;
  let base = id.x * 64u;
  for (var j = 0u; j < 64u; j++) {
    let index = base + j;
    if (index >= compact.dims.x) { break; }
    total += visibility_flags[index];
  }
  block_sums[id.x] = total;
}

// K2:单 invocation 对 block_sums 做升序独占前缀扫描 → block_offsets。
@compute @workgroup_size(64)
fn scan_block_offsets(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }
  var running = 0u;
  for (var block = 0u; block < compact.dims.y; block++) {
    block_offsets[block] = running;
    running += block_sums[block];
  }
}

// K3:每 invocation 产出本实例的独占前缀;最后一个实例补写 prefix[N] = 总数。
@compute @workgroup_size(64)
fn scan_instance_prefix(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= compact.dims.x) { return; }
  let block_base = (id.x / 64u) * 64u;
  var in_block = 0u;
  for (var index = block_base; index < id.x; index++) {
    in_block += visibility_flags[index];
  }
  instance_prefix[id.x] = block_offsets[id.x / 64u] + in_block;
  if (id.x == compact.dims.x - 1u) {
    instance_prefix[compact.dims.x] = instance_prefix[id.x] + visibility_flags[id.x];
  }
}

// K4:幸存实例写入 compact_visible。槽位 = 批次 instance_start + 批次内
// 幸存序(prefix[id] − prefix[批次首实例]),落点严格在批次区域内。
@compute @workgroup_size(64)
fn compact_instances(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= compact.dims.x) { return; }
  if (visibility_flags[id.x] == 0u) { return; }
  let batch_start = metadata[id.x].z;
  let slot = batch_start + (instance_prefix[id.x] - instance_prefix[batch_start]);
  compact_visible[slot] = source_instances[id.x];
}

// K5:每批次重写 compact_indirect 的 instance_count;其余 4 字段由 CPU 侧
// 每次 encode 前写入的模板保证(compact_indirect 不被 GPU 触碰)。
@compute @workgroup_size(64)
fn write_indirect(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= compact.dims.z) { return; }
  let range = batch_ranges[id.x];
  compact_indirect[id.x].instance_count = instance_prefix[range.y] - instance_prefix[range.x];
}
