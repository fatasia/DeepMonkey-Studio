import { PBR_DISPLAY_COLOR_WGSL } from "./pbrDisplayColorWgsl.js";
import { PBR_AUTHOR_COLOR_EFFECTS_WGSL } from "./pbrAuthorColorEffectsWgsl.js";

/**
 * I-C21 HDR 显示输出 WGSL 增量 —— present 终点的 HDR 编码核(PQ/HLG/headroom)。
 *
 * == 与 SDR 链同源 ==
 * 复用 `PBR_DISPLAY_COLOR_WGSL`(exposure/grading/ACES 与 `deepLinearToSrgb` 单源)与
 * `PBR_AUTHOR_COLOR_EFFECTS_WGSL`(作者效果链);HDR 策略只替换最后一阶
 * "压缩到 0..1 + sRGB" —— 上游能量链零改动,白炉守恒边界由 pbrHdrDisplay CPU 镜像背书。
 *
 * == 字面量纪律 ==
 * PQ/HLG 系数必须与 `pbrHdrDisplay.ts` 逐位同源(测试以源文本对拍钉住,同
 * pbrOutputShaderProvenance 的文本级独立网先例);数值出处 BT.2100 Table 5。
 */
export const PBR_HDR_DISPLAY_FUNCTIONS_WGSL = /* wgsl */ `
const PQ_M1 = 0.1593017578125;
const PQ_M2 = 78.84375;
const PQ_C1 = 0.8359375;
const PQ_C2 = 18.8515625;
const PQ_C3 = 18.6875;
fn deepLinearNitsToPq(nits: f32) -> f32 {
  let y = clamp(nits, 0.0, 10000.0) / 10000.0;
  let powered = pow(y, PQ_M1);
  return select(pow((PQ_C1 + PQ_C2 * powered) / (1.0 + PQ_C3 * powered), PQ_M2), 0.0, y <= 0.0);
}
const HLG_A = 0.17883277;
const HLG_B = 0.28466892;
const HLG_C = 0.55991073;
fn deepLinearToHlg(sceneLinear: f32) -> f32 {
  let e = clamp(sceneLinear, 0.0, 1.0);
  // select(假分支, 真分支, 条件):e ≤ 1/12 走 sqrt 段,否则走 a·ln 段(BT.2100 OETF)。
  return select(sqrt(3.0 * e), HLG_A * log(12.0 * e - HLG_B) + HLG_C, e > (1.0 / 12.0));
}
fn deepExtendedLinearHeadroom(color: vec3f, headroom: f32) -> vec3f {
  let positive = max(color, vec3f(0.0));
  let room = max(headroom - 1.0, 1e-6);
  let over = positive - vec3f(1.0);
  let shoulder = vec3f(1.0) + vec3f(room) * tanh(over / vec3f(room));
  return select(shoulder, positive, positive <= vec3f(1.0));
}
`;

/** HDR 变体 present 着色器:bind group 0/1 布局与 outputShader 同形 + 追加 binding 3。 */
export const hdrDisplayOutputShader = /* wgsl */ `${PBR_DISPLAY_COLOR_WGSL}
${PBR_AUTHOR_COLOR_EFFECTS_WGSL}
${PBR_HDR_DISPLAY_FUNCTIONS_WGSL}
struct DeepHdrOutputSettings { strategy: f32, referenceWhiteNits: f32, peakNits: f32, headroom: f32 };
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> settings: DeepOutputSettings;
@group(0) @binding(3) var<uniform> hdrSettings: DeepHdrOutputSettings;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> Vertex {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: Vertex; out.position = vec4f(positions[i], 0.0, 1.0);
  out.uv = positions[i] * vec2f(0.5, -0.5) + 0.5; return out;
}
fn deepHdrDisplayColor(colorIn: vec3f, settings: DeepOutputSettings, hdr: DeepHdrOutputSettings) -> vec3f {
  var color = colorIn; var toneExposure = settings.exposure;
  if (settings.temperature != 0.0 || settings.tint != 0.0
    || settings.contrast != 1.0 || settings.saturation != 1.0) {
    color *= toneExposure; color = deepApplyColorGrading(color, settings); toneExposure = 1.0;
  }
  let expanded = clamp(color * toneExposure, vec3f(0.0), vec3f(65504.0));
  if (hdr.strategy < 0.5) { return deepExtendedLinearHeadroom(expanded, hdr.headroom); }
  if (hdr.strategy < 1.5) {
    let nits = min(expanded * vec3f(hdr.referenceWhiteNits), vec3f(hdr.peakNits));
    return vec3f(deepLinearNitsToPq(nits.r), deepLinearNitsToPq(nits.g), deepLinearNitsToPq(nits.b));
  }
  return vec3f(deepLinearToHlg(expanded.r), deepLinearToHlg(expanded.g), deepLinearToHlg(expanded.b));
}
@fragment fn fragmentMain(v: Vertex) -> @location(0) vec4f {
  var color = textureSample(source, sourceSampler, v.uv).rgb;
  if (authorEffects.switches.x > 0.5) {
    let authorSettings = DeepOutputSettings(settings.exposure, 0.0, 0.0, settings.toneMapping, 0.0, 0.0, 1.0, 1.0);
    return vec4f(deepHdrDisplayColor(deepAuthorColor(color, v.uv), authorSettings, hdrSettings), 1.0);
  }
  let radial = dot(v.uv - 0.5, v.uv - 0.5);
  color *= 1.0 - settings.vignette * smoothstep(0.05, 0.5, radial);
  return vec4f(deepHdrDisplayColor(color, settings, hdrSettings), 1.0);
}
`;
