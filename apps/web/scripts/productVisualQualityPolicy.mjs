/** 固定三维夹具的语义区域；只随相机/夹具版本显式调整，不能按失败结果临时放宽。 */
export const FIXED_VIEWER_VISUAL_REGIONS = Object.freeze([
  {
    id: "hud",
    label: "HUD",
    rectangles: [
      { x: 0, y: 0, width: 0.19, height: 0.13 },
      { x: 0.82, y: 0.82, width: 0.18, height: 0.18 },
    ],
  },
  {
    id: "distant-grid",
    label: "远景网格",
    rectangles: [{ x: 0.19, y: 0.05, width: 0.63, height: 0.31 }],
  },
  {
    id: "objects-selection",
    label: "对象与选择",
    rectangles: [{ x: 0.18, y: 0.35, width: 0.64, height: 0.55 }],
  },
]);

// 分区阈值由 2026-08-30 固定相机、1440×900、完整效果 WebGL/WebGPU 证据校准：
// HUD 0.978/0.87%，对象与选择 0.984/1.24%，远景网格 0.816/4.74%（SSIM/严重像素）。
// 前两者留出小幅跨驱动抖动空间；远景网格的明显差异必须失败，不能按现状放宽成通过。
// 这些是防退化门槛，不是画质等价声明；画质签署仍需人工截图评审与长稳报告。
const REGION_POLICIES = Object.freeze({
  hud: { minimumSsim: 0.97, maximumSeverePixelRatio: 0.015 },
  "distant-grid": { minimumSsim: 0.90, maximumSeverePixelRatio: 0.04 },
  "objects-selection": { minimumSsim: 0.97, maximumSeverePixelRatio: 0.02 },
});

/**
 * 纯视觉质量策略。全局 severePixelRatio >2% 必须失败，1%–2% 必须警告；
 * 区域门槛用于阻断局部退化被背景平均值掩盖。
 */
export function assessProductVisualQuality(comparison) {
  const failures = [];
  const warnings = [];
  if (!finiteMetrics(comparison)) return { failures: ["完整产品 WebGL/WebGPU 画质指标缺失或非法"], warnings };

  if (comparison.ssim < 0.7) failures.push(`完整产品 WebGL/WebGPU 画面结构相似度仅 ${comparison.ssim.toFixed(3)}`);
  else if (comparison.ssim < 0.9) warnings.push(`完整产品 WebGL/WebGPU 画面存在可见差异：SSIM ${comparison.ssim.toFixed(3)}，需人工检查阴影、PBR、标签与后处理`);

  if (comparison.severePixelRatio > 0.02) {
    failures.push(`完整产品 WebGL/WebGPU 有 ${percent(comparison.severePixelRatio)} 像素存在明显差异，超过 2% 硬门槛`);
  } else if (comparison.severePixelRatio >= 0.01) {
    warnings.push(`完整产品 WebGL/WebGPU 仍有 ${percent(comparison.severePixelRatio)} 像素存在明显差异，请继续检查差异热图`);
  }

  const regions = new Map((comparison.regions ?? []).map((region) => [region.id, region]));
  for (const definition of FIXED_VIEWER_VISUAL_REGIONS) {
    const region = regions.get(definition.id);
    const policy = REGION_POLICIES[definition.id];
    if (!region || !finiteMetrics(region)) {
      failures.push(`${definition.label}区域画质指标缺失或非法`);
      continue;
    }
    if (region.ssim < policy.minimumSsim) {
      failures.push(`${definition.label}区域 SSIM ${region.ssim.toFixed(3)} 低于 ${policy.minimumSsim.toFixed(2)} 门槛`);
    }
    if (region.severePixelRatio > policy.maximumSeverePixelRatio) {
      failures.push(`${definition.label}区域明显差异 ${percent(region.severePixelRatio)} 超过 ${percent(policy.maximumSeverePixelRatio)} 门槛`);
    }
  }
  return { failures, warnings };
}

function finiteMetrics(value) {
  return value && Number.isFinite(value.ssim) && Number.isFinite(value.severePixelRatio)
    && value.ssim >= -1 && value.ssim <= 1 && value.severePixelRatio >= 0 && value.severePixelRatio <= 1;
}
function percent(value) { return `${(value * 100).toFixed(2)}%`; }
