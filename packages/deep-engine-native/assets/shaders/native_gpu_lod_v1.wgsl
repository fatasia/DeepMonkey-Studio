// Deep Engine native GPU LOD contract v1: 144-byte instances, firstInstance = 0.
struct InstanceRow {
    model0: vec4f, model1: vec4f, model2: vec4f,
    normal0: vec4f, normal1: vec4f, normal2: vec4f,
    color: vec4f, pbr: vec4f, emissive: vec4f,
}
struct LodRecord { info: vec4u, bound: vec4f, tuning: vec4f }
struct LodView {
    planes: array<vec4f, 6>, eye: vec4f, forward: vec4f,
    params: vec4u, projection: vec4f,
}
struct IndirectCommand {
    index_count: u32, instance_count: atomic<u32>,
    first_index: u32, base_vertex: i32, first_instance: u32,
}
@group(0) @binding(0) var<storage, read> source: array<InstanceRow>;
@group(0) @binding(1) var<storage, read> objects: array<LodRecord>;
@group(0) @binding(2) var<storage, read> levels: array<LodRecord>;
@group(0) @binding(3) var<uniform> view: LodView;
@group(0) @binding(4) var<storage, read_write> history: array<u32>;
@group(0) @binding(5) var<storage, read_write> visible: array<InstanceRow>;
@group(0) @binding(6) var<storage, read_write> indirect: array<IndirectCommand>;

fn world_center(row: InstanceRow, local: vec3f) -> vec3f {
    let point = vec4f(local, 1.0);
    return vec3f(dot(row.model0, point), dot(row.model1, point), dot(row.model2, point));
}

fn affine_scale(row: InstanceRow) -> f32 {
    let a = row.model0.xyz;
    let b = row.model1.xyz;
    let c = row.model2.xyz;
    let x = vec3f(a.x, b.x, c.x);
    let y = vec3f(a.y, b.y, c.y);
    let z = vec3f(a.z, b.z, c.z);
    let xy = abs(dot(x, y));
    let xz = abs(dot(x, z));
    let yz = abs(dot(y, z));
    let gram = max(dot(x,x) + xy + xz, max(dot(y,y) + xy + yz, dot(z,z) + xz + yz));
    let ones = vec3f(1.0);
    let norm1 = max(dot(abs(x), ones), max(dot(abs(y), ones), dot(abs(z), ones)));
    let norm_inf = max(dot(abs(a), ones), max(dot(abs(b), ones), dot(abs(c), ones)));
    // Both are upper bounds on the largest singular value squared. The margin
    // covers float32 rounding; rotations do not inflate to a box diagonal.
    return sqrt(max(0.0, min(gram, norm1 * norm_inf))) * 1.000001;
}

fn sphere_visible(row: InstanceRow, bound: vec4f) -> bool {
    let center = world_center(row, bound.xyz);
    for (var plane = 0u; plane < 6u; plane++) {
        let p = view.planes[plane];
        let distance = dot(p.xyz, center) + p.w;
        let local_normal = p.x * row.model0.xyz + p.y * row.model1.xyz + p.z * row.model2.xyz;
        if distance < 0.0 && distance * distance > bound.w * bound.w * dot(local_normal, local_normal) {
            return false;
        }
    }
    return true;
}

@compute @workgroup_size(64)
fn select_lod(@builtin(global_invocation_id) invocation: vec3u) {
    let object_index = invocation.x;
    if object_index >= view.params.x { return; }
    let object = objects[object_index];
    if (object.info.w & view.params.y) == 0u { return; }
    let row = source[object.info.x];
    let radius = object.bound.w * affine_scale(row);
    let depth = dot(world_center(row, object.bound.xyz) - view.eye.xyz, view.forward.xyz);
    var pixels_per_world = view.projection.x;
    if view.params.z == 0u { pixels_per_world /= max(depth, view.projection.y); }
    let diameter = 2.0 * radius * pixels_per_world;
    let start = object.info.y;
    let count = object.info.z;
    var base = count - 1u;
    for (var index = 0u; index < count; index++) {
        if diameter >= levels[start + index].tuning.x { base = index; break; }
    }
    var desired = history[object_index];
    if desired >= count { desired = base; }
    let ratio = object.tuning.x;
    while desired > base {
        if diameter < levels[start + desired - 1u].tuning.x * (1.0 + ratio) { break; }
        desired--;
    }
    while desired < base {
        if diameter >= levels[start + desired].tuning.x * (1.0 - ratio) { break; }
        desired++;
    }
    // Keep desired history independently of residency; fallback must not poison it.
    history[object_index] = desired;
    var selected = desired;
    while selected + 1u < count && levels[start + selected].info.z == 0u { selected++; }
    let level = levels[start + selected];
    if level.info.z == 0u || !sphere_visible(row, level.bound) { return; }
    let slot = atomicAdd(&indirect[level.info.x].instance_count, 1u);
    visible[level.info.y + slot] = row;
}
