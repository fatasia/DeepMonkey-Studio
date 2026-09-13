import { GPU_LOD_MAX_LEVELS } from "./gpuLodTypes.js";

export const PACKET_LOD_WORKGROUP_SIZE = 256;
export const PACKET_LOD_INDIRECT_STRIDE = 20;
export const PACKET_LOD_BUDGET_RECORD_STRIDE = 16;
export const PACKET_LOD_BUDGET_UNIFORM_SIZE = 112;
export const PACKET_LOD_DRAW_UNIFORM_SIZE = 144;

export const PACKET_LOD_BUDGET_WGSL = /* wgsl */ `
struct SelectionRecord { selection: vec4u, meshlets: vec4u, metrics: vec4f }
struct ObjectInput { sphere: vec4f, metadata: vec4u }
struct BudgetRecord { data: vec4u }
struct Params { dispatch: vec4u, frustum: array<vec4f, 6> }

@group(0) @binding(0) var<storage, read> selections: array<SelectionRecord>;
@group(0) @binding(1) var<storage, read> objects: array<ObjectInput>;
@group(0) @binding(2) var<storage, read_write> localPrefix: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> blockOffsets: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> records: array<BudgetRecord>;
@group(0) @binding(5) var<uniform> params: Params;

fn addCost(left: vec4u, right: vec4u) -> vec4u {
  let low = left.y + right.y;
  return vec4u(left.x + right.x, low, left.z + right.z + select(0u, 1u, low < left.y), 0u);
}
fn inFrustum(sphere: vec4f) -> bool {
  for (var plane = 0u; plane < 6u; plane += 1u) {
    let value = params.frustum[plane];
    if (dot(value.xyz, sphere.xyz) + value.w < -sphere.w) { return false; }
  }
  return true;
}

@compute @workgroup_size(${PACKET_LOD_WORKGROUP_SIZE})
fn classifyBudget(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.dispatch.x) { return; }
  let selection = selections[id.x];
  let candidate = (selection.selection.w & 2u) != 0u && inFrustum(objects[id.x].sphere);
  records[id.x].data = vec4u(selection.selection.z, selection.meshlets.x, select(0u, 1u, candidate), 0u);
}

var<workgroup> costs: array<vec4u, ${PACKET_LOD_WORKGROUP_SIZE}>;
@compute @workgroup_size(${PACKET_LOD_WORKGROUP_SIZE})
fn scanBudgetLocal(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_id) local: vec3u,
  @builtin(workgroup_id) group: vec3u) {
  var value = vec4u(0u);
  if (id.x < params.dispatch.x && records[id.x].data.z != 0u) { value = vec4u(1u, records[id.x].data.y, 0u, 0u); }
  costs[local.x] = value; workgroupBarrier();
  var step = 1u;
  while (step < ${PACKET_LOD_WORKGROUP_SIZE}u) {
    var add = vec4u(0u); if (local.x >= step) { add = costs[local.x - step]; }
    workgroupBarrier(); costs[local.x] = addCost(costs[local.x], add); workgroupBarrier(); step *= 2u;
  }
  if (id.x < params.dispatch.x) { localPrefix[id.x] = costs[local.x]; }
  if (local.x == ${PACKET_LOD_WORKGROUP_SIZE - 1}u) { blockOffsets[group.x] = costs[local.x]; }
}

@compute @workgroup_size(1)
fn scanBudgetBlocks() {
  var running = vec4u(0u);
  for (var block = 0u; block < params.dispatch.y; block += 1u) {
    let count = blockOffsets[block]; blockOffsets[block] = running; running = addCost(running, count);
  }
}

@compute @workgroup_size(${PACKET_LOD_WORKGROUP_SIZE})
fn applyBudget(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.dispatch.x) { return; }
  let inclusive = addCost(blockOffsets[id.x / ${PACKET_LOD_WORKGROUP_SIZE}u], localPrefix[id.x]);
  let within = inclusive.x <= params.dispatch.z && inclusive.z == 0u && inclusive.y <= params.dispatch.w;
  records[id.x].data.w = select(0u, 1u, records[id.x].data.z != 0u && within);
}
`;

export const PACKET_LOD_INDIRECT_WGSL = /* wgsl */ `
struct BudgetRecord { data: vec4u }
struct InstanceRow {
  model0: vec4f, model1: vec4f, model2: vec4f,
  normal0: vec4f, normal1: vec4f, normal2: vec4f,
  material0: vec4f, material1: vec4f, material2: vec4f,
}
struct PreviousTransform { row0: vec4f, row1: vec4f, row2: vec4f }
struct Params { dispatch: vec4u, draws: array<vec4u, ${GPU_LOD_MAX_LEVELS}> }

@group(0) @binding(0) var<storage, read> records: array<BudgetRecord>;
@group(0) @binding(1) var<storage, read> instances: array<InstanceRow>;
@group(0) @binding(2) var<storage, read> previous: array<PreviousTransform>;
@group(0) @binding(3) var<storage, read_write> localPrefix: array<u32>;
@group(0) @binding(4) var<storage, read_write> blockOffsets: array<u32>;
@group(0) @binding(5) var<storage, read_write> compacted: array<InstanceRow>;
@group(0) @binding(6) var<storage, read_write> compactedPrevious: array<PreviousTransform>;
@group(0) @binding(7) var<storage, read_write> indirect: array<u32>;
@group(0) @binding(8) var<uniform> params: Params;

var<workgroup> counts: array<u32, ${PACKET_LOD_WORKGROUP_SIZE}>;
@compute @workgroup_size(${PACKET_LOD_WORKGROUP_SIZE})
fn scanLevelLocal(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_id) local: vec3u,
  @builtin(workgroup_id) group: vec3u) {
  for (var level = 0u; level < params.dispatch.w; level += 1u) {
    var present = 0u;
    if (id.x < params.dispatch.y) {
      let record = records[params.dispatch.x + id.x].data;
      present = select(0u, 1u, record.w != 0u && record.x == level);
    }
    counts[local.x] = present; workgroupBarrier();
    var step = 1u;
    while (step < ${PACKET_LOD_WORKGROUP_SIZE}u) {
      var add = 0u; if (local.x >= step) { add = counts[local.x - step]; }
      workgroupBarrier(); counts[local.x] += add; workgroupBarrier(); step *= 2u;
    }
    if (id.x < params.dispatch.y) { localPrefix[id.x * ${GPU_LOD_MAX_LEVELS}u + level] = counts[local.x] - present; }
    if (local.x == ${PACKET_LOD_WORKGROUP_SIZE - 1}u) {
      blockOffsets[(group.x * ${GPU_LOD_MAX_LEVELS}u) + level] = counts[local.x];
    }
    workgroupBarrier();
  }
}

@compute @workgroup_size(1)
fn scanLevelBlocks() {
  for (var level = 0u; level < ${GPU_LOD_MAX_LEVELS}u; level += 1u) {
    var running = 0u;
    if (level < params.dispatch.w) {
      for (var block = 0u; block < (params.dispatch.y + ${PACKET_LOD_WORKGROUP_SIZE - 1}u) / ${PACKET_LOD_WORKGROUP_SIZE}u; block += 1u) {
        let slot = block * ${GPU_LOD_MAX_LEVELS}u + level;
        let count = blockOffsets[slot]; blockOffsets[slot] = running; running += count;
      }
    }
    let command = level * 5u; let draw = params.draws[level];
    indirect[command] = draw.x; indirect[command + 1u] = running;
    indirect[command + 2u] = draw.y; indirect[command + 3u] = draw.z;
    // 各级实例段由顶点 buffer 的字节偏移选取，避免依赖 indirect-first-instance。
    indirect[command + 4u] = 0u;
  }
}

@compute @workgroup_size(${PACKET_LOD_WORKGROUP_SIZE})
fn compactLevels(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.dispatch.y) { return; }
  let record = records[params.dispatch.x + id.x].data;
  if (record.w == 0u || record.x >= params.dispatch.w) { return; }
  let slot = (id.x / ${PACKET_LOD_WORKGROUP_SIZE}u) * ${GPU_LOD_MAX_LEVELS}u + record.x;
  let destination = record.x * params.dispatch.z + blockOffsets[slot]
    + localPrefix[id.x * ${GPU_LOD_MAX_LEVELS}u + record.x];
  compacted[destination] = instances[id.x]; compactedPrevious[destination] = previous[id.x];
}
`;
