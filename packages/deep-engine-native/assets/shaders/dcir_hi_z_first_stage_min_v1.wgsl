// Deep Compute IR v0 (schema 1); generated deterministically. Kernel: hi_z_first_stage
// IR sha256: 2356435319d8607f08fd589261837cff774b96b64ca14c7cdc640316d182b6e6
struct DeepKernelUniforms {
  sourceSize: vec2u,
  targetSize: vec2u,
};

@group(0) @binding(0) var deepSource: texture_2d<f32>;
@group(0) @binding(1) var deepTarget: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> deepUniforms: DeepKernelUniforms;

@compute @workgroup_size(8, 8, 1)
fn hi_z_first_stage(@builtin(global_invocation_id) deepGlobalId: vec3u) {
  let n_gid: vec2u = deepGlobalId.xy;
  let n_tx: u32 = n_gid.x;
  let n_ty: u32 = n_gid.y;
  let n_sourceSize: vec2u = deepUniforms.sourceSize;
  let n_targetSize: vec2u = deepUniforms.targetSize;
  let n_sw: u32 = n_sourceSize.x;
  let n_sh: u32 = n_sourceSize.y;
  let n_tw: u32 = n_targetSize.x;
  let n_th: u32 = n_targetSize.y;
  let n_inx: bool = (n_tx < n_tw);
  let n_iny: bool = (n_ty < n_th);
  let n_inside_f: bool = false;
  let n_inside: bool = select(n_inside_f, n_inx, n_iny);
  let n_one: u32 = 1u;
  let n_two: u32 = 2u;
  let n_swm1: u32 = n_sw - n_one;
  let n_shm1: u32 = n_sh - n_one;
  let n_bx: u32 = n_tx * n_two;
  let n_by: u32 = n_ty * n_two;
  let n_bx1: u32 = n_bx + n_one;
  let n_by1: u32 = n_by + n_one;
  let n_vx0: bool = (n_bx < n_sw);
  let n_vy0: bool = (n_by < n_sh);
  let n_vx1: bool = (n_bx1 < n_sw);
  let n_vy1: bool = (n_by1 < n_sh);
  let n_cx0: u32 = select(n_swm1, n_bx, n_vx0);
  let n_cy0: u32 = select(n_shm1, n_by, n_vy0);
  let n_cx1: u32 = select(n_swm1, n_bx1, n_vx1);
  let n_cy1: u32 = select(n_shm1, n_by1, n_vy1);
  let n_c00: vec2u = vec2u(n_cx0, n_cy0);
  let n_c10: vec2u = vec2u(n_cx1, n_cy0);
  let n_c01: vec2u = vec2u(n_cx0, n_cy1);
  let n_c11: vec2u = vec2u(n_cx1, n_cy1);
  let n_s00: f32 = textureLoad(deepSource, vec2i(n_c00), 0).x;
  let n_s10: f32 = textureLoad(deepSource, vec2i(n_c10), 0).x;
  let n_s01: f32 = textureLoad(deepSource, vec2i(n_c01), 0).x;
  let n_s11: f32 = textureLoad(deepSource, vec2i(n_c11), 0).x;
  let n_a1: f32 = select(n_s00, n_s10, n_vx1);
  let n_v1: f32 = min(n_s00, n_a1);
  let n_a2: f32 = select(n_v1, n_s01, n_vy1);
  let n_v2: f32 = min(n_v1, n_a2);
  let n_valid11_f: bool = false;
  let n_valid11: bool = select(n_valid11_f, n_vx1, n_vy1);
  let n_a3: f32 = select(n_v2, n_s11, n_valid11);
  let n_v3: f32 = min(n_v2, n_a3);
  let n_value: f32 = select(n_v3, 0.0, n_v3 == 0.0);
  if (!(n_inside)) { return; }
  textureStore(deepTarget, vec2i(n_gid), vec4f(n_value, 0.0, 0.0, 0.0));
}
