// F4 时域上采样核。空间项 = Catmull-Rom 16-tap(每轴 4 权重,textureLoad 语义,
// 边界 clamp);时域项 = UV 运动重投影 + 深度感知双线性历史 + YCoCg AABB 邻域
// 钳制(与 temporalAaWgsl 同式;窗口取内部 texel 网格)。历史失效帧(sizeHistory.z
// = 0)时域项权重为 0,输出退化为纯 Catmull-Rom —— fail-closed,无 ghosting 累积。
// flags.y = reactive 门:透明/粒子 reactive 覆盖(r8unorm,内部 texel 最近邻读)
// 处历史混合权重按 (1 - reactive) 降权(与 TAA binding 8 同式);flags.y = 0 时
// 不读 mask 绑定的 fallback(恒 0),历史权重不变 —— 无供给零行为变化。
//
// GHOST_GUARD 决策层(AA-M2 后续切片,编译期开关,与 temporalAa.wgsl 同名常量):
// 与 postprocess/temporalReprojection.ts accumulateTemporalFrameDetailed 决策分支
// 逐式同源,字面常量由 temporalUpscaleWgslChecksum.test.ts 与 GHOST_GUARD_REPROJECTION_POLICY
// 互钉。0 = 关:只走基线分支,输出与历史生产逐位一致;宿主开启经
// enableTemporalGhostGuardWgsl(TemporalUpscalePass ghostGuard 选项 / T07 探针)。
//
// 尺寸/坐标语义:sizeDisplay = 输出(画布)分辨率,sizeInternal = 渲染分辨率。
// motion 是 UV delta(分辨率无关),显示像素 delta = motion × sizeDisplay;
// jitter 是内部像素偏移,显示像素差 = Δjitter × scale(internalWidth/displayWidth)。
struct UpscaleParams {
  sizesA: vec4<u32>,
  flags: vec4<u32>,
  tuning: vec4<f32>,
  jitterDeltaScale: vec4<f32>,
};
@group(0) @binding(0) var currentColor: texture_2d<f32>;
@group(0) @binding(1) var currentDepth: texture_2d<f32>;
@group(0) @binding(2) var motionVectors: texture_2d<f32>;
@group(0) @binding(3) var previousColor: texture_2d<f32>;
@group(0) @binding(4) var previousDepth: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> upscaleParams: UpscaleParams;
@group(0) @binding(6) var outputColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var outputDepth: texture_storage_2d<r32float, write>;
@group(0) @binding(8) var reactiveMask: texture_2d<f32>;

const DEEP_TEMPORAL_GHOST_GUARD: u32 = 0u;

fn catmullRom(t: f32) -> f32 {
  let a = abs(t);
  if (a < 1.0) { return 1.5 * a * a * a - 2.5 * a * a + 1.0; }
  if (a < 2.0) { return -0.5 * a * a * a + 2.5 * a * a - 4.0 * a + 2.0; }
  return 0.0;
}

fn rgbToYCoCg(rgb: vec3f) -> vec3f {
  return vec3f(rgb.r * 0.25 + rgb.g * 0.5 + rgb.b * 0.25, rgb.r * 0.5 - rgb.b * 0.5,
    -rgb.r * 0.25 + rgb.g * 0.5 - rgb.b * 0.25);
}
fn yCoCgToRgb(value: vec3f) -> vec3f {
  return vec3f(value.x + value.y - value.z, value.x + value.z, value.x - value.y - value.z);
}

// 深度感知双线性历史:被拒 tap 不贡献颜色也不贡献权重(与 TAA sampleHistory 同式)。
fn sampleHistory(position: vec2f, size: vec2u, depth: f32, threshold: f32) -> vec4f {
  let samplePosition = position - 0.5;
  let base = vec2i(floor(samplePosition));
  let fraction = fract(samplePosition);
  var color = vec3f(0.0); var acceptedWeight = 0.0;
  for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let weight = select(1.0 - fraction.x, fraction.x, x == 1)
      * select(1.0 - fraction.y, fraction.y, y == 1);
    let coordinate = clamp(base + vec2i(x, y), vec2i(0), vec2i(size) - 1);
    let historicalDepth = textureLoad(previousDepth, coordinate, 0).x;
    if (weight > 0.0 && historicalDepth > 0.0 && abs(historicalDepth - depth) <= threshold) {
      color += textureLoad(previousColor, coordinate, 0).rgb * weight;
      acceptedWeight += weight;
    }
  } }
  if (acceptedWeight <= 0.0) { return vec4f(0.0); }
  return vec4f(color / acceptedWeight, acceptedWeight);
}

@compute @workgroup_size(8, 8)
fn upscaleTemporal(@builtin(global_invocation_id) id: vec3<u32>) {
  let sizeDisplay = upscaleParams.sizesA.xy;
  let sizeInternal = upscaleParams.sizesA.zw;
  if (id.x >= sizeDisplay.x || id.y >= sizeDisplay.y) { return; }
  let coordinate = vec2<i32>(id.xy);
  // 连续内部 texel 中心坐标与每轴 4 权重(与 temporalUpscaleCpu 同式)。
  let internalPosition = (vec2f(id.xy) + 0.5) / vec2f(sizeDisplay) * vec2f(sizeInternal) - 0.5;
  let base = vec2i(floor(internalPosition));
  let fraction = fract(internalPosition);
  let weightsX = vec4f(catmullRom(1.0 + fraction.x), catmullRom(fraction.x),
    catmullRom(1.0 - fraction.x), catmullRom(2.0 - fraction.x));
  let weightsY = vec4f(catmullRom(1.0 + fraction.y), catmullRom(fraction.y),
    catmullRom(1.0 - fraction.y), catmullRom(2.0 - fraction.y));
  var color = vec4f(0.0);
  for (var ty = 0; ty < 4; ty++) { for (var tx = 0; tx < 4; tx++) {
    let tap = clamp(base + vec2i(tx - 1, ty - 1), vec2i(0), vec2i(sizeInternal) - 1);
    let weight = weightsY[ty] * weightsX[tx];
    color += textureLoad(currentColor, tap, 0) * weight;
  } }
  color = max(color, vec4f(0.0));
  // 显式 4-tap 双线性视深(中心 2×2,权重和恒 1;不与颜色共享含负权重)。
  var depth = 0.0;
  for (var ty = 0; ty < 2; ty++) { for (var tx = 0; tx < 2; tx++) {
    let tap = clamp(base + vec2i(tx, ty), vec2i(0), vec2i(sizeInternal) - 1);
    let weight = select(1.0 - fraction.y, fraction.y, ty == 1)
      * select(1.0 - fraction.x, fraction.x, tx == 1);
    depth += textureLoad(currentDepth, tap, 0).x * weight;
  } }
  var resolved = color.rgb;
  if (upscaleParams.flags.x == 1u && depth > 0.0) {
    // 运动矢量与钳制窗中心都取当前像素中心所在的内部 texel(最近邻,与 CPU 参考一致)。
    let center = clamp(vec2i(round(internalPosition)), vec2i(0), vec2i(sizeInternal) - 1);
    let motion = textureLoad(motionVectors, center, 0).xy;
    let previousPosition = vec2f(id.xy) + 0.5 + motion * vec2f(sizeDisplay)
      + upscaleParams.jitterDeltaScale.xy;
    let inside = all(previousPosition >= vec2f(0.0)) && all(previousPosition < vec2f(sizeDisplay));
    if (inside) {
      let threshold = max(upscaleParams.tuning.y, depth * upscaleParams.tuning.z);
      let historicalColor = sampleHistory(previousPosition, sizeDisplay, depth, threshold);
      if (historicalColor.a > 0.0) {
        var minimum = vec3f(1e20); var maximum = vec3f(-1e20);
        for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
          let neighbor = clamp(center + vec2<i32>(x, y), vec2<i32>(0), vec2i(sizeInternal) - 1);
          let ycocg = rgbToYCoCg(textureLoad(currentColor, neighbor, 0).rgb);
          minimum = min(minimum, ycocg); maximum = max(maximum, ycocg);
        } }
        let history = rgbToYCoCg(historicalColor.rgb);
        let clampedHistory = yCoCgToRgb(clamp(history, minimum, maximum));
        if (DEEP_TEMPORAL_GHOST_GUARD == 0u) {
          // reactive 覆盖(内部 texel 最近邻,与 motion 同点):透明/粒子区域历史
          // 按 (1 - reactive) 降权,该帧更多采信当前帧 —— 与 TAA binding 8 同式。
          var blend = upscaleParams.tuning.x;
          if (upscaleParams.flags.y == 1u) {
            let reactive = clamp(textureLoad(reactiveMask, center, 0).x, 0.0, 1.0);
            blend = blend * (1.0 - reactive);
          }
          resolved = mix(color.rgb, clampedHistory, blend);
        } else {
          // GHOST_GUARD 决策层(与 accumulateTemporalFrameDetailed 决策分支同式;
          // box 邻域与钳制窗同取内部 texel 网格,reactive 降权在 decay 乘子之前生效):
          let acceptedRatio = historicalColor.a;
          if (acceptedRatio < 0.25) {
            var boxMean = vec3f(0.0);
            for (var oy = -1; oy <= 1; oy++) { for (var ox = -1; ox <= 1; ox++) {
              let neighbor = clamp(center + vec2<i32>(ox, oy), vec2<i32>(0), vec2<i32>(sizeInternal) - 1);
              boxMean = boxMean + textureLoad(currentColor, neighbor, 0).rgb / 9.0;
            } }
            resolved = max(boxMean, vec3f(0.0));
          } else {
            let historyError = dot(abs(clampedHistory - color.rgb), vec3f(1.0)) / 3.0;
            var feedback = upscaleParams.tuning.x;
            if (upscaleParams.flags.y == 1u) {
              let reactive = clamp(textureLoad(reactiveMask, center, 0).x, 0.0, 1.0);
              feedback = feedback * (1.0 - reactive);
            }
            if (historyError > 0.05) { feedback = feedback * 0.1; }
            resolved = mix(color.rgb, clampedHistory, feedback);
          }
        }
      }
    }
  }
  textureStore(outputColor, coordinate, vec4f(resolved, color.a));
  textureStore(outputDepth, coordinate, vec4f(max(depth, 0.0), 0.0, 0.0, 0.0));
}
