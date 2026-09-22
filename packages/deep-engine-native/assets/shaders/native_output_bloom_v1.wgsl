// Deep Engine native HDR bloom output shader contract v1.
@group(0) @binding(0) var hdr_color: texture_2d<f32>;
@group(0) @binding(1) var bloom_color: texture_2d<f32>;
@group(0) @binding(2) var bloom_sampler: sampler;

struct OutputParams {
  values: vec4f,
};
@group(0) @binding(3) var<uniform> output: OutputParams;

struct OutputVertex {
  @builtin(position) position: vec4f,
};

@vertex fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> OutputVertex {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var result: OutputVertex;
  result.position = vec4f(positions[vertex_index], 0.0, 1.0);
  return result;
}

fn aces(color: vec3f) -> vec3f {
  return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14),
    vec3f(0.0), vec3f(1.0));
}

// 作者色彩分级六通道（hue/saturation/brightness/contrast/temperature/tint）。
// 逐式镜像 Web applyPbrAuthorColorEffects（TS 仲裁基准），在固定 ACES 之前的
// HDR 线性域应用；全零 uniform 下有限输入逐位恒等（精确中性）。
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

fn linear_to_srgb(linear: vec3f) -> vec3f {
  let low = linear * 12.92;
  let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3f(0.0031308));
}

fn combined_hdr(position: vec4f) -> vec4f {
  let pixel = vec2i(position.xy);
  let hdr = textureLoad(hdr_color, pixel, 0);
  let uv = (vec2f(pixel) + 0.5) / vec2f(textureDimensions(hdr_color));
  let glow = textureSampleLevel(bloom_color, bloom_sampler, uv, 0.0).rgb
    * output.values.x;
  return vec4f(hdr.rgb + glow, hdr.a);
}

@fragment fn fragment_srgb_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = combined_hdr(input.position);
  return vec4f(aces(author_grading_apply(hdr.rgb)), hdr.a);
}

@fragment fn fragment_unorm_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = combined_hdr(input.position);
  return vec4f(linear_to_srgb(aces(author_grading_apply(hdr.rgb))), hdr.a);
}
