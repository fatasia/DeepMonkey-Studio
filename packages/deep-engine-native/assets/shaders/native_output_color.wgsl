// Native author six-channel grading. DeepOutputSettings grading has a separate contract.
struct AuthorGrading {
  switches: vec4f,
  grading: vec4f,
  whiteBalance: vec4f,
};
@group(0) @binding(6) var<uniform> author_grading: AuthorGrading;

fn author_grading_apply(source: vec3f) -> vec3f {
  var color = source;
  if (author_grading.switches.z > 0.5) {
    let grading = author_grading.grading;
    if (grading.x != 0.0) {
      // hue：Three r185 HueSaturation 旋转矩阵，π 与 TS 同款截断字面量。
      let angle = grading.x / 180.0 * 3.14159265;
      let s = sin(angle);
      let c = cos(angle);
      let weights = (vec3f(2.0 * c, -sqrt(3.0) * s - c, sqrt(3.0) * s - c) + 1.0) / 3.0;
      color = vec3f(dot(color, weights.xyz), dot(color, weights.zxy), dot(color, weights.yzx));
    }
    let average = (color.r + color.g + color.b) / 3.0;
    // saturation：正值走 (0,1) 压缩，其余（含 0 与负值）线性。
    if (grading.y > 0.0) {
      color += (average - color) * (1.0 - 1.0 / (1.001 - grading.y));
    } else {
      color += (average - color) * (-grading.y);
    }
    if (grading.z != 0.0 || grading.w != 0.0) {
      color += grading.z;
      color = (color - 0.5) * (grading.w + 1.0) + 0.5;
    }
    let wb = author_grading.whiteBalance;
    if (wb.x != 0.0 || wb.y != 0.0) {
      let gains = vec3f(1.0 + wb.x * 0.14 + wb.y * 0.07,
        1.0 - wb.y * 0.12, 1.0 - wb.x * 0.14 + wb.y * 0.07);
      let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
      color *= gains;
      // TS 仲裁基准：分母取 |balancedLuminance| 下限 1e-6，保持原亮度。
      color = color * luma / max(abs(dot(color, vec3f(0.2126, 0.7152, 0.0722))), 0.000001);
    }
  }
  return color;
}

fn aces(color: vec3f) -> vec3f {
  // Linear exposure was consumed upstream; never apply it twice.
  return deepAcesFit(color, 1.0);
}

fn linear_to_srgb(linear: vec3f) -> vec3f {
  return deepLinearToSrgb(linear);
}
