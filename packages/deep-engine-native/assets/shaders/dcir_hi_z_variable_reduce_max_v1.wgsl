// Deep Compute IR v0 (schema 1); generated deterministically. Kernel: hi_z_variable_reduce
// IR sha256: 05955055f03ecf148b2e1ffa7296c5ea0232b952d5c3ec56334717f8e8346215
struct DeepKernelUniforms {
  sourceSize: vec2u,
  targetSize: vec2u,
};

@group(0) @binding(0) var deepSource: texture_2d<f32>;
@group(0) @binding(1) var deepTarget: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> deepUniforms: DeepKernelUniforms;

@compute @workgroup_size(8, 8, 1)
fn hi_z_variable_reduce(@builtin(global_invocation_id) deepGlobalId: vec3u) {
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
  let n_off1: u32 = 1u;
  let n_off2: u32 = 2u;
  let n_xp: u32 = n_tx * n_sw;
  let n_xb: u32 = n_xp / n_tw;
  let n_xn: u32 = n_xp + n_sw;
  let n_xm: u32 = n_tw - n_one;
  let n_xq: u32 = n_xn + n_xm;
  let n_xe: u32 = n_xq / n_tw;
  let n_xm1: u32 = n_sw - n_one;
  let n_yp: u32 = n_ty * n_sh;
  let n_yb: u32 = n_yp / n_th;
  let n_yn: u32 = n_yp + n_sh;
  let n_ym: u32 = n_th - n_one;
  let n_yq: u32 = n_yn + n_ym;
  let n_ye: u32 = n_yq / n_th;
  let n_ym1: u32 = n_sh - n_one;
  let n_vx0: bool = (n_xb < n_xe);
  let n_cx0: u32 = select(n_xm1, n_xb, n_vx0);
  let n_bx1: u32 = n_xb + n_off1;
  let n_vx1: bool = (n_bx1 < n_xe);
  let n_cx1: u32 = select(n_xm1, n_bx1, n_vx1);
  let n_bx2: u32 = n_xb + n_off2;
  let n_vx2: bool = (n_bx2 < n_xe);
  let n_cx2: u32 = select(n_xm1, n_bx2, n_vx2);
  let n_vy0: bool = (n_yb < n_ye);
  let n_cy0: u32 = select(n_ym1, n_yb, n_vy0);
  let n_by1: u32 = n_yb + n_off1;
  let n_vy1: bool = (n_by1 < n_ye);
  let n_cy1: u32 = select(n_ym1, n_by1, n_vy1);
  let n_by2: u32 = n_yb + n_off2;
  let n_vy2: bool = (n_by2 < n_ye);
  let n_cy2: u32 = select(n_ym1, n_by2, n_vy2);
  let n_co_cx0_cy0: vec2u = vec2u(n_cx0, n_cy0);
  let n_s_cx0_cy0: f32 = textureLoad(deepSource, vec2i(n_co_cx0_cy0), 0).x;
  let n_co_cx0_cy1: vec2u = vec2u(n_cx0, n_cy1);
  let n_s_cx0_cy1: f32 = textureLoad(deepSource, vec2i(n_co_cx0_cy1), 0).x;
  let n_co_cx0_cy2: vec2u = vec2u(n_cx0, n_cy2);
  let n_s_cx0_cy2: f32 = textureLoad(deepSource, vec2i(n_co_cx0_cy2), 0).x;
  let n_co_cx1_cy0: vec2u = vec2u(n_cx1, n_cy0);
  let n_s_cx1_cy0: f32 = textureLoad(deepSource, vec2i(n_co_cx1_cy0), 0).x;
  let n_co_cx1_cy1: vec2u = vec2u(n_cx1, n_cy1);
  let n_s_cx1_cy1: f32 = textureLoad(deepSource, vec2i(n_co_cx1_cy1), 0).x;
  let n_co_cx1_cy2: vec2u = vec2u(n_cx1, n_cy2);
  let n_s_cx1_cy2: f32 = textureLoad(deepSource, vec2i(n_co_cx1_cy2), 0).x;
  let n_co_cx2_cy0: vec2u = vec2u(n_cx2, n_cy0);
  let n_s_cx2_cy0: f32 = textureLoad(deepSource, vec2i(n_co_cx2_cy0), 0).x;
  let n_co_cx2_cy1: vec2u = vec2u(n_cx2, n_cy1);
  let n_s_cx2_cy1: f32 = textureLoad(deepSource, vec2i(n_co_cx2_cy1), 0).x;
  let n_co_cx2_cy2: vec2u = vec2u(n_cx2, n_cy2);
  let n_s_cx2_cy2: f32 = textureLoad(deepSource, vec2i(n_co_cx2_cy2), 0).x;
  let n_w00_f: bool = false;
  let n_w00: bool = select(n_w00_f, n_vx0, n_vy0);
  let n_a00: f32 = select(n_s_cx0_cy0, n_s_cx0_cy0, n_w00);
  let n_r00: f32 = max(n_s_cx0_cy0, n_a00);
  let n_w10_f: bool = false;
  let n_w10: bool = select(n_w10_f, n_vx1, n_vy0);
  let n_a10: f32 = select(n_r00, n_s_cx1_cy0, n_w10);
  let n_r10: f32 = max(n_r00, n_a10);
  let n_w20_f: bool = false;
  let n_w20: bool = select(n_w20_f, n_vx2, n_vy0);
  let n_a20: f32 = select(n_r10, n_s_cx2_cy0, n_w20);
  let n_r20: f32 = max(n_r10, n_a20);
  let n_w01_f: bool = false;
  let n_w01: bool = select(n_w01_f, n_vx0, n_vy1);
  let n_a01: f32 = select(n_r20, n_s_cx0_cy1, n_w01);
  let n_r01: f32 = max(n_r20, n_a01);
  let n_w11_f: bool = false;
  let n_w11: bool = select(n_w11_f, n_vx1, n_vy1);
  let n_a11: f32 = select(n_r01, n_s_cx1_cy1, n_w11);
  let n_r11: f32 = max(n_r01, n_a11);
  let n_w21_f: bool = false;
  let n_w21: bool = select(n_w21_f, n_vx2, n_vy1);
  let n_a21: f32 = select(n_r11, n_s_cx2_cy1, n_w21);
  let n_r21: f32 = max(n_r11, n_a21);
  let n_w02_f: bool = false;
  let n_w02: bool = select(n_w02_f, n_vx0, n_vy2);
  let n_a02: f32 = select(n_r21, n_s_cx0_cy2, n_w02);
  let n_r02: f32 = max(n_r21, n_a02);
  let n_w12_f: bool = false;
  let n_w12: bool = select(n_w12_f, n_vx1, n_vy2);
  let n_a12: f32 = select(n_r02, n_s_cx1_cy2, n_w12);
  let n_r12: f32 = max(n_r02, n_a12);
  let n_w22_f: bool = false;
  let n_w22: bool = select(n_w22_f, n_vx2, n_vy2);
  let n_a22: f32 = select(n_r12, n_s_cx2_cy2, n_w22);
  let n_r22: f32 = max(n_r12, n_a22);
  let n_value: f32 = select(n_r22, 0.0, n_r22 == 0.0);
  if (!(n_inside)) { return; }
  textureStore(deepTarget, vec2i(n_gid), vec4f(n_value, 0.0, 0.0, 0.0));
}
