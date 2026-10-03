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
    // AA-M1 后 MSAA×4 达容许档(3.844<6),ratchet 同步锁档(旧 diagnostic)。
    role: "standard", expectedTier: "tolerant", minCoverage: 40000,
    // AA-M1(2026-10-04)基线刷新:Deep 主通路 MSAA4 上线(引擎默认档,spatialAa 由
    // MSAA 取代,parity 探针按场景镜像 three 侧 MSAA 配置)。RMSE 6.05→3.84、SSIM
    // .9917→.9964、over8 1.88%→0.85%;残差 = three 侧 SMAAPass 的显示域边缘补刀,
    // Deep 侧 SMAA 移植在 AA-M2(antialiasing-master-plan L3),届时关闭本缺口。
    baseline: {"rmse":3.84435688524246,"deltaE2000Mean":0.16459803721805358,"deltaE2000P99":1.2349649812701455,"ssimMean":0.9964353169948542,"over8Fraction":0.008463541666666666},
    knownGap: {
      "cause": "three 产品链为 composer 目标 MSAA×4 + SMAAPass;Deep 侧 AA-M1 已对齐 MSAA×4(硬件 resolve),SMAA 档位在 AA-M2 移植,当前无显示域兜底。Bloom 本身在合约参数下与 UnrealBloomPass 一致(见 bloom-only)",
      "evidence": "AA-M1 校准(2026-10-04,RTX 4060):Deep MSAA4 vs three MSAA4+SMAA,RMSE 3.844 / ΔE00 均值 .165 / SSIM .9964 / over8 0.85%(旧基线 1x+spatialAa 为 6.05/.755/.9917/1.88%);差异图只剩高对比轮廓像素(byteMax 196)",
      "action": "AA-M2 SMAA T2x 移植到 WGSL 后重判目标 RMSE<2(引擎改动,不在门范围内)"
    },
  },
  "transparency": {
    role: "standard", expectedTier: "tolerant", minCoverage: 11000,
    baseline: {"rmse":1.49688,"deltaE2000Mean":0.196882,"deltaE2000P99":8.60998,"ssimMean":0.999295,"over8Fraction":0.0222656,"hdrRelativeRmse":0.0273369},
    knownGap: {
      "cause": "已对齐（口径修正）：产品 three 作者路径是 EffectComposer+OutputPass，透明在线性 HDR 目标内混合后统一色调映射，与 Deep 加权 OIT 的线性合成同口径；残余为加权 OIT 与精确排序混合的近似差（p99 ΔE00 8.6，未逐像素归因）",
      "evidence": "three 侧 = 产品 composer 链（AA/MSAA 关闭以隔离混合语义）；RMSE 1.50 / ΔE00 均值 .20 / SSIM .9993；线性域 HDR 相对 RMSE 2.7%。透射（transmission）桥层拒绝，只覆盖 alpha 简化",
      "action": "无需产品决策；若要升严格档需缩小 OIT 近似差（引擎改动）"
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
  "transparency-direct": {
    role: "diagnostic", expectedTier: "diagnostic", minCoverage: 11000,
    baseline: {"rmse":13.4142,"deltaE2000Mean":2.48941,"deltaE2000P99":27.7862,"ssimMean":0.978704,"over8Fraction":0.176595,"hdrRelativeRmse":0.0273369},
    knownGap: {
      "cause": "非产品路径，仅诊断：three renderer 直出（逐片元 ACES+sRGB 编码后再 alpha 混合，显示空间混合）对比 Deep 线性合成；产品作者路径走 composer，不会出现该差异",
      "evidence": "与 transparency 同场景同 Deep 帧，差距 RMSE 13.4 / ΔE00 均值 2.49；证明 transparency 的残余只来自混合空间，已被产品 composer 路径消除",
      "action": "无（保留为口径对照与回归守卫）"
    },
  },
};
