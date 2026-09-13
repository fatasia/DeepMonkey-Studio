export const MESHLET_INDIRECT_WORKGROUP_SIZE = 64;

export const MESHLET_INDIRECT_WGSL = /* wgsl */ `
struct PlannerRecord { header: vec4<u32>, draw: vec4<u32> };
struct DrawIndexedIndirect { indexCount: u32, instanceCount: u32, firstIndex: u32, baseVertex: i32, firstInstance: u32 };
struct Parameters { limits: vec4<u32>, mapping: vec4<u32> };
@group(0) @binding(0) var<storage, read> records: array<PlannerRecord>;
@group(0) @binding(1) var<storage, read> visibleCount: array<u32>;
@group(0) @binding(2) var<storage, read_write> commands: array<DrawIndexedIndirect>;
@group(0) @binding(3) var<uniform> params: Parameters;

fn clearCommand(index: u32) {
  commands[index].indexCount = 0u; commands[index].instanceCount = 0u;
  commands[index].firstIndex = 0u; commands[index].baseVertex = 0; commands[index].firstInstance = 0u;
}

@compute @workgroup_size(64)
fn writeCommands(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.limits.y) { return; }
  clearCommand(id.x);
  let count = min(min(visibleCount[0], params.limits.x), params.limits.y);
  if (id.x >= count) { return; }
  let record = records[id.x];
  if (record.header.x >= params.mapping.w || record.header.z == 0u || record.header.z > 64u
    || record.draw.x == 0u || record.draw.x > 126u || record.draw.x > 0x55555555u
    || record.draw.y != record.draw.x * 3u || record.header.w > 0x55555555u
    || record.draw.z != record.header.w * 3u || record.draw.w != 0u
    || record.draw.z > params.limits.z || record.draw.y > params.limits.z - record.draw.z
    || record.draw.z > 0xffffffffu - params.limits.w) { return; }
  var instanceOffset = 0u;
  if (params.mapping.z == 1u) { instanceOffset = record.header.x; }
  if (params.mapping.z == 2u) { instanceOffset = id.x; }
  if (instanceOffset > 0xffffffffu - params.mapping.y) { return; }
  commands[id.x].indexCount = record.draw.y;
  commands[id.x].instanceCount = 1u;
  commands[id.x].firstIndex = params.limits.w + record.draw.z;
  commands[id.x].baseVertex = bitcast<i32>(params.mapping.x);
  commands[id.x].firstInstance = params.mapping.y + instanceOffset;
}
`;
