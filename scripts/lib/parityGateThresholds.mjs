// 像素一致性门的声明：每个场景的期望档位、覆盖下限与回归基线。
// 严格档场景必须保持严格；"已知缺口"场景的阈值 = 当前实测基线 + REGRESSION_MARGIN（见 parityGateMetrics.mjs），只能不变或变好。
// 基线刷新流程：node scripts/gate-parity.mjs --calibrate → test-output/parity-gate/calibration.json 的 candidate；
// 档位提升时（门输出 ratchet 提示）同步上调 expectedTier。禁止通过放宽 tiers 或基线掩盖回归。
// 基线来自 2026-10-03 NVIDIA RTX 4060（Chrome WebGPU，Windows），其它 GPU/驱动首次接入需重新标定并在文档登记。
export const PARITY_EXPECTATIONS = {
  "pbr-matrix": {
    role: "standard", expectedTier: "strict", minCoverage: 12000,
    baseline: {"rmse":0.257589,"deltaE2000Mean":0.015281,"deltaE2000P99":0.506601,"ssimMean":0.999888,"over8Fraction":0.000146484,"hdrRelativeRmse":0.00123624},
    knownGap: null,
  },
  "ibl": {
    role: "standard", expectedTier: "tolerant", minCoverage: 14000,
    baseline: {"rmse":4.72953,"deltaE2000Mean":0.769096,"deltaE2000P99":7.7215,"ssimMean":0.985028,"over8Fraction":0.115186,"hdrRelativeRmse":0.242831},
    knownGap: {
      "cause": "Deep radiance-hdr 预滤波（128 样本蒙特卡洛，漫反射 32²）在小而亮的太阳盘上产生橘皮噪点；镜面链与 three PMREM cubeUV 滤波核不同",
      "evidence": "ibl-hq（256/64/256）噪点基本消失，SSIM .985→.9886，但金属低粗糙度反射仍有滤波核差异；HDR 相对 RMSE 24% 由太阳反射主导",
      "action": "Deep 侧提高默认漫反射预滤波样本或改用确定性卷积；或统一采用同一 PMREM 产物（引擎改动，不在门范围内）"
    },
  },
  "directional-shadow": {
    role: "standard", expectedTier: "strict", minCoverage: 24000,
    baseline: {"rmse":0.0917613,"deltaE2000Mean":0.0162029,"deltaE2000P99":0.871135,"ssimMean":0.999947,"over8Fraction":0,"hdrRelativeRmse":0.000347996},
    knownGap: null,
  },
  "aa-bloom": {
    role: "standard", expectedTier: "diagnostic", minCoverage: 40000,
    baseline: {"rmse":6.31289,"deltaE2000Mean":0.285831,"deltaE2000P99":5.68724,"ssimMean":0.993347,"over8Fraction":0.0174805},
    knownGap: {
      "cause": "边缘抗锯齿算法不同：three SMAAPass vs Deep spatialAa；Bloom 本身与 three UnrealBloomPass 在合约参数下一致（见 bloom-only）",
      "evidence": "bloom-only（两侧均关 AA）RMSE .18 / ΔE00 均值 .05 达到严格档；差异图只剩高对比轮廓像素（byteMax 178）",
      "action": "对齐 Deep spatialAa 与 SMAA 的边缘权重，或将作者视图的 SMAA 换为同一算法"
    },
  },
  "transparency": {
    role: "standard", expectedTier: "diagnostic", minCoverage: 11000,
    baseline: {"rmse":13.4142,"deltaE2000Mean":2.48941,"deltaE2000P99":27.7862,"ssimMean":0.978704,"over8Fraction":0.176595,"hdrRelativeRmse":0.0273369},
    knownGap: {
      "cause": "混合空间不同：three 在默认帧缓冲里对每个透明片元先 ACES+sRGB 编码再 alpha 混合（显示空间混合）；Deep OIT 在线性 HDR 里合成后统一色调映射。透射（transmission）桥层直接拒绝，只验证 alpha 简化",
      "evidence": "transparency-linear（three 改为线性 HDR 混合后 OutputPass）降到 RMSE 1.5 / ΔE00 均值 .20，证明着色一致、差距全部来自混合空间；HDR 线性域相对 RMSE 仅 2.7%",
      "action": "产品决策：以线性合成为准（Unity/UE 口径）并让作者视图透明材质走 OutputPass，或让 Deep 提供显示空间混合开关"
    },
  },
  "ibl-hq": {
    role: "diagnostic", expectedTier: "tolerant", minCoverage: 14000,
    baseline: {"rmse":4.53569,"deltaE2000Mean":0.72037,"deltaE2000P99":7.83954,"ssimMean":0.988628,"over8Fraction":0.0908854,"hdrRelativeRmse":0.243889},
    knownGap: {
      "cause": "ibl 的高质量预滤波对照（specular 256 / diffuse 64 / 256 样本）",
      "evidence": "用于证明 ibl 噪点来自默认样本数",
      "action": "随 ibl 缺口一并关闭"
    },
  },
  "bloom-only": {
    role: "diagnostic", expectedTier: "strict", minCoverage: 40000,
    baseline: {"rmse":0.18336,"deltaE2000Mean":0.0485673,"deltaE2000P99":1.02525,"ssimMean":0.999888,"over8Fraction":0.0000488281},
    knownGap: null,
  },
  "transparency-linear": {
    role: "diagnostic", expectedTier: "tolerant", minCoverage: 11000,
    baseline: {"rmse":1.49688,"deltaE2000Mean":0.196882,"deltaE2000P99":8.60998,"ssimMean":0.999295,"over8Fraction":0.0222656},
    knownGap: {
      "cause": "three 线性混合对照（先线性 HDR 混合再 OutputPass）；残余未逐像素归因，推测为加权 OIT 与精确排序混合的近似差",
      "evidence": "RMSE 1.5 / ΔE00 均值 .20 / p99 8.6（落在 tolerant 档，未达 strict 的是 p99）",
      "action": "随 transparency 缺口一并评估"
    },
  },
};
