import type { SceneFireCurveKey, SceneVfxEffectState, SceneVfxTemplateId } from "@bim-studio/contracts";

/**
 * VFX 模板库：数字孪生真实需求收窄后的 8 个预制效果，不做通用 VFX Graph。
 *
 * 运动档与 deep-engine T20 参数面的映射（只读引用，不改引擎）：
 * - rise/fall/burst/drift → fire runtime 同族的 progress 参数化上升/下落/抛射；
 * - ring → `GpuParticleEmitter` 的 alarm-pulse / expanding-ring 预设语义；
 * - flow → `flow-line` 预设语义（start→end 定向流动）。
 * 引擎 GPU 发射器的 count/lifetime/color/size 与模板 rate/lifetime/color/maxParticles
 * 一一对应；gravity/drag 在参数化轨迹中以 progress 形状等价表达（burst/fall 下坠）。
 */

/** 运动档：上升 / 滴落 / 抛射 / 扩散环 / 扬尘 / 定向流。 */
export type VfxMotion = "rise" | "fall" | "burst" | "ring" | "drift" | "flow";

export interface VfxTemplateDefinition {
  readonly id: SceneVfxTemplateId;
  readonly motion: VfxMotion;
  /** 界面名称与一句话说明 [中文, 英文]。 */
  readonly label: readonly [string, string];
  readonly hint: readonly [string, string];
  /** range 滑杆的语义标签 [中文, 英文]。 */
  readonly rangeLabel: readonly [string, string];
  /** 挂载即写入场景的完整合法状态。 */
  readonly defaults: SceneVfxEffectState;
  /** 基础点尺寸系数（乘 range 语义量得到粒子基准尺寸）。 */
  readonly pointScale: number;
}

const curve = (frames: readonly (readonly [number, number])[]): SceneFireCurveKey[] =>
  frames.map(([time, value]) => ({ time, value }));

/** 8 个模板。defaults 必须是完整 SceneVfxEffectState（单测强制校验完整性）。 */
export const VFX_TEMPLATES: readonly VfxTemplateDefinition[] = [
  {
    id: "exhaust-steam", motion: "rise",
    label: ["排气蒸汽", "Exhaust steam"], hint: ["设备排气口白色蒸汽，向上扩散", "White steam rising from vents"],
    rangeLabel: ["上升高度", "Rise height"],
    pointScale: 0.16,
    defaults: {
      template: "exhaust-steam", enabled: true, color: "#cfd8dc", intensity: 1.2, rate: 1,
      range: 2.5, lifetime: 2.4, blend: "alpha", maxParticles: 160,
      curves: {
        size: curve([[0, 0.35], [0.4, 0.8], [1, 1.2]]),
        alpha: curve([[0, 0], [0.15, 0.55], [0.7, 0.3], [1, 0]]),
        color: curve([[0, 0.35], [1, 0.2]]),
      },
    },
  },
  {
    id: "leak-drip", motion: "fall",
    label: ["泄漏滴液", "Leak drip"], hint: ["法兰/管件底部滴落液滴", "Droplets falling from flanges"],
    rangeLabel: ["下落距离", "Drop distance"],
    pointScale: 0.06,
    defaults: {
      template: "leak-drip", enabled: true, color: "#4fc3f7", intensity: 1, rate: 0.6,
      range: 1.5, lifetime: 1.6, blend: "alpha", maxParticles: 64,
      curves: {
        size: curve([[0, 0.5], [1, 0.5]]),
        alpha: curve([[0, 0.9], [0.9, 0.9], [1, 0]]),
        color: curve([[0, 0.5], [1, 0.3]]),
      },
    },
  },
  {
    id: "sparks", motion: "burst",
    label: ["火花迸溅", "Sparks"], hint: ["打磨/短路的火星抛射", "Sparks from grinding or shorts"],
    rangeLabel: ["迸溅半径", "Splash radius"],
    pointScale: 0.05,
    defaults: {
      template: "sparks", enabled: true, color: "#ffb347", intensity: 2, rate: 0.8,
      range: 1.2, lifetime: 0.9, blend: "additive", maxParticles: 96,
      curves: {
        size: curve([[0, 0.9], [0.3, 0.5], [1, 0.1]]),
        alpha: curve([[0, 1], [0.5, 0.8], [1, 0]]),
        color: curve([[0, 1], [0.4, 0.7], [1, 0.1]]),
      },
    },
  },
  {
    id: "alarm-ring", motion: "ring",
    label: ["告警脉冲环", "Alarm pulse ring"], hint: ["地面扩散的告警光环，可被行为触发", "Alarm ring on the ground; triggerable by behaviors"],
    rangeLabel: ["扩散半径", "Pulse radius"],
    pointScale: 0.08,
    defaults: {
      template: "alarm-ring", enabled: true, color: "#ff3b30", intensity: 1.8, rate: 1,
      range: 3, lifetime: 1.6, blend: "additive", maxParticles: 96,
      curves: {
        size: curve([[0, 0.8], [1, 0.5]]),
        alpha: curve([[0, 0], [0.2, 1], [0.6, 0.5], [1, 0]]),
        color: curve([[0, 1], [0.5, 0.6], [1, 0.2]]),
      },
    },
  },
  {
    id: "dust", motion: "drift",
    label: ["灰尘扬起", "Dust puff"], hint: ["装卸/行走扬起的缓慢灰尘", "Slow dust from handling or traffic"],
    rangeLabel: ["扬起高度", "Puff height"],
    pointScale: 0.22,
    defaults: {
      template: "dust", enabled: true, color: "#b0a08a", intensity: 0.8, rate: 0.8,
      range: 1.8, lifetime: 3.2, blend: "alpha", maxParticles: 96,
      curves: {
        size: curve([[0, 0.6], [1, 1]]),
        alpha: curve([[0, 0], [0.25, 0.35], [1, 0]]),
        color: curve([[0, 0.3], [1, 0.15]]),
      },
    },
  },
  {
    id: "airflow", motion: "flow",
    label: ["气流线", "Airflow line"], hint: ["沿对象长轴的定向气流示踪", "Directional flow tracers along the long axis"],
    rangeLabel: ["流线长度", "Stream length"],
    pointScale: 0.07,
    defaults: {
      template: "airflow", enabled: true, color: "#64d8ff", intensity: 1, rate: 1,
      range: 4, lifetime: 2, blend: "additive", maxParticles: 96,
      curves: {
        size: curve([[0, 0.5], [0.5, 0.9], [1, 0.5]]),
        alpha: curve([[0, 0], [0.2, 0.7], [0.8, 0.7], [1, 0]]),
        color: curve([[0, 0.6], [1, 0.6]]),
      },
    },
  },
  {
    id: "smoke-leak", motion: "rise",
    label: ["烟雾泄漏", "Smoke leak"], hint: ["暗色烟雾缓慢上涌", "Dark smoke seeping upward"],
    rangeLabel: ["上升高度", "Rise height"],
    pointScale: 0.24,
    defaults: {
      template: "smoke-leak", enabled: true, color: "#8d99a0", intensity: 1, rate: 1,
      range: 3, lifetime: 3, blend: "alpha", maxParticles: 160,
      curves: {
        size: curve([[0, 0.4], [1, 1.3]]),
        alpha: curve([[0, 0], [0.2, 0.6], [1, 0]]),
        color: curve([[0, 0.25], [1, 0.1]]),
      },
    },
  },
  {
    id: "spray-mist", motion: "burst",
    label: ["喷雾水雾", "Spray mist"], hint: ["喷淋/加湿的柔和雾锥", "Soft mist cone from sprays"],
    rangeLabel: ["喷雾半径", "Spray radius"],
    pointScale: 0.12,
    defaults: {
      template: "spray-mist", enabled: true, color: "#a7d8f0", intensity: 1.2, rate: 1,
      range: 1.6, lifetime: 1.4, blend: "alpha", maxParticles: 128,
      curves: {
        size: curve([[0, 0.5], [1, 1]]),
        alpha: curve([[0, 0], [0.2, 0.5], [1, 0]]),
        color: curve([[0, 0.5], [1, 0.3]]),
      },
    },
  },
];

export const VFX_TEMPLATE_MAP: Readonly<Record<SceneVfxTemplateId, VfxTemplateDefinition>> = Object.fromEntries(
  VFX_TEMPLATES.map((template) => [template.id, template]),
) as Readonly<Record<SceneVfxTemplateId, VfxTemplateDefinition>>;

export function isVfxTemplateId(value: unknown): value is SceneVfxTemplateId {
  return typeof value === "string" && value in VFX_TEMPLATE_MAP;
}
