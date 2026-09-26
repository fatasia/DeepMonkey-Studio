/**
 * Plant 类库与层级建模合同(西门子 Plant Simulation Class Library 的对位,平替矩阵 P0-A)。
 * 语义基线:docs/reports/siemens-pps-deep-dive-2026-09-26.md 第 1.2 节——
 * - 类改 → 实例传播:类模板属性变更向继承链上全部未断继承的实例传播;
 * - 实例改 → 该属性断继承:实例覆写过的属性脱离类,后续改类不再影响它;
 * - 粒度是属性级开关,不是实例级整体拷贝(西门子属性级 Inherit 开关的等价物)。
 * 类模板只声明节点/资源(建模积木);拓扑连线(edges)与产品类型在模型层编写,不属类。
 * 实例化产物是完整的平面 PlantLiteNode/PlantLiteResource,直接走既有校验与求解,
 * 求解内核不感知类库。实现见 plant-lite-simulation/src/classLibraryRuntime.ts。
 */

import type { PlantLiteNode, PlantLiteResource } from "./plantLiteModel.js";

/**
 * 类可继承属性值域:标量或 JSON 结构(分布、班次窗口、功率、故障档案、换型表、看板卡等)。
 * 函数、undefined、NaN、bigint 等非 JSON 值在运行时显式拒绝;
 * 无法收窄为字段枚举,是因为分布/班次等核心继承属性本身是对象,标量域会让属性级开关残废。
 */
export type PlantClassPropertyValue = string | number | boolean | object;

/** 类库条目:一组节点/资源模板;extendsClassId 支持多级继承(禁止环)。 */
export interface PlantClassDefinition {
  classId: string;
  name: string;
  /**
   * 父类;省略为根类。链合并规则(西门子 derive 语义):
   * 子类与祖先同 id 的实体按顶层属性逐项合并(子类声明的属性覆写,未声明的继承),
   * 同 id 实体必须同 kind;子类独有实体按序追加。
   */
  extendsClassId?: string;
  /**
   * 类模板节点。实体 id 不得包含"."——实例 id 采用
   * `${classId}.${实例序号}.${模板实体id}` 三段式,模板 id 含点会破坏模板 id 反解。
   */
  nodes: PlantLiteNode[];
  resources?: PlantLiteResource[];
}

/** 改类动作;set 键为 `${模板实体id}.${属性名}`,值为替换后的完整属性值(整值替换,不做深合并)。 */
export interface PlantClassMutation {
  set: Record<string, PlantClassPropertyValue>;
}

/**
 * 传播结果。affectedInstances 口径:本次传播中至少一个属性值实际发生变化的实例数;
 * 实例已覆写全部被改属性时其值不变,不计入——该计数本身就是"断继承是否生效"的直接证据。
 */
export interface PlantClassPropagationResult {
  classId: string;
  affectedInstances: number;
}
