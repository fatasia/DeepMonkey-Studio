import type { OwasPostureInput, OwasPostureScore } from "@bim-studio/contracts";

/**
 * OWAS(Ovako Working Posture Analysis System,Karhu, Kansi & Kuorinka 1977)动作类别查表。
 *
 * 表值来源:公开的开源数字化实现(如 GitHub Leoronus/Pose-Evaluation-Project 等通用采用的
 * 标准动作类别矩阵,即 Karhu et al. 1977 原表的开源数字化版本);锚点单元已与公开文献对拍:
 * - 直立背/双臂低/双腿伸直站立/<10kg → AC1(良性基线,通行教材结论);
 * - 扭转背/单臂高/跪姿/<10kg → AC3(wits.ac.za 学位论文实例);
 * - 弯扭背/双臂高/双膝弯/>20kg → AC4(通行教材结论)。
 * 原表为姿态观察评级,含摄入口径不确定性;输出为筛查参考,不是认证结论。
 *
 * 已知偏差声明(保守修正,共 1 个单元):所用开源数字化版本中 背弯2/单臂高2/单膝弯5/10-20kg
 * 单元为 [3,4,3](重载反而降档),与同表 腿4=[3,4,4] 及其整体"腿5≥腿4"模式矛盾,判为转录笔误;
 * 本实现按保守原则取 [3,4,4](同 back=2/arm=2 的腿4 值),其余 251 个单元与源逐值一致。
 */

const BACK_LABELS: Record<OwasPostureInput["back"], string> = {
  1: "背直立",
  2: "背前弯",
  3: "背扭转",
  4: "背弯且扭",
};
const ARM_LABELS: Record<OwasPostureInput["arm"], string> = {
  1: "双臂低于肩",
  2: "单臂不低于肩",
  3: "双臂不低于肩",
};
const LEG_LABELS: Record<OwasPostureInput["leg"], string> = {
  1: "坐姿",
  2: "双腿伸直站立",
  3: "单腿承重站立",
  4: "双膝弯曲",
  5: "单膝弯曲承重",
  6: "跪姿",
  7: "行走/移动",
};
const ACTION_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: "姿态正常,无需措施",
  2: "轻度有害,应尽快安排改进",
  3: "明显有害,应尽早改进",
  4: "严重有害,须立即改进",
};

export const OWAS_NOTE =
  "OWAS 动作类别查表(Karhu et al. 1977 开源数字化版本,锚点已对拍);筛查参考,不是认证结论。未知载荷归入最重组。";

/**
 * AC 表:OWAS_ACTION_CATEGORIES[背-1][臂-1][腿-1] = [载荷1, 载荷2, 载荷3]。
 * 载荷组:1 = ≤10kg;2 = 10-20kg;3 = >20kg 或未知。
 */
const OWAS_ACTION_CATEGORIES: readonly (readonly (readonly [number, number, number])[][])[] = [
  [
    [[1, 1, 1], [1, 1, 1], [1, 1, 1], [2, 2, 2], [2, 2, 2], [1, 1, 1], [1, 1, 1]],
    [[1, 1, 1], [1, 1, 1], [1, 1, 1], [2, 2, 2], [2, 2, 2], [1, 1, 1], [1, 1, 1]],
    [[1, 1, 1], [1, 1, 1], [1, 1, 1], [2, 2, 3], [2, 2, 3], [1, 1, 1], [1, 1, 2]],
  ],
  [
    [[2, 2, 3], [2, 2, 3], [2, 2, 3], [3, 3, 3], [3, 3, 3], [2, 2, 2], [2, 3, 3]],
    [[2, 2, 3], [2, 2, 3], [2, 3, 3], [3, 4, 4], [3, 4, 4], [3, 3, 4], [2, 3, 4]],
    [[3, 3, 4], [2, 2, 3], [3, 3, 3], [3, 4, 4], [4, 4, 4], [4, 4, 4], [2, 3, 4]],
  ],
  [
    [[1, 1, 1], [1, 1, 1], [1, 1, 2], [3, 3, 3], [4, 4, 4], [1, 1, 1], [1, 1, 1]],
    [[2, 2, 3], [1, 1, 1], [1, 1, 2], [4, 4, 4], [4, 4, 4], [3, 3, 3], [1, 1, 1]],
    [[2, 2, 3], [1, 1, 1], [2, 3, 3], [4, 4, 4], [4, 4, 4], [4, 4, 4], [1, 1, 1]],
  ],
  [
    [[2, 3, 3], [2, 2, 3], [2, 2, 3], [4, 4, 4], [4, 4, 4], [4, 4, 4], [2, 3, 4]],
    [[3, 3, 4], [2, 3, 4], [3, 3, 4], [4, 4, 4], [4, 4, 4], [4, 4, 4], [2, 3, 4]],
    [[4, 4, 4], [2, 3, 4], [3, 3, 4], [4, 4, 4], [4, 4, 4], [4, 4, 4], [2, 3, 4]],
  ],
] as readonly (readonly (readonly [number, number, number])[][])[];

/** 把载荷 kg 映射到 OWAS 载荷组;未知载荷(缺省)归入第 3 组。 */
export function resolveOwasLoadCategory(loadMassKg: number | undefined): 1 | 2 | 3 {
  if (loadMassKg === undefined) return 3;
  if (!Number.isFinite(loadMassKg) || loadMassKg < 0) throw new Error(`OWAS 载荷 ${loadMassKg} 非法`);
  if (loadMassKg <= 10) return 1;
  if (loadMassKg <= 20) return 2;
  return 3;
}

/** 确定性查表:姿态四元组 → 动作类别 AC1-AC4。非法编码直接抛错。 */
export function classifyOwasPosture(posture: OwasPostureInput): OwasPostureScore {
  const { back, arm, leg, loadMassKg } = posture;
  requireCode("back", back, 4);
  requireCode("arm", arm, 3);
  requireCode("leg", leg, 7);
  const loadCategory = resolveOwasLoadCategory(loadMassKg);
  const actionCategory = OWAS_ACTION_CATEGORIES[back - 1]![arm - 1]![leg - 1]![loadCategory - 1]! as 1 | 2 | 3 | 4;
  return {
    standard: "OWAS",
    code: `${back}${arm}${leg}${loadCategory}`,
    actionCategory,
    actionLabel: ACTION_LABELS[actionCategory],
    note: OWAS_NOTE,
  };
}

export function formatOwasPosture(posture: OwasPostureInput): string {
  const { back, arm, leg } = posture;
  return `${BACK_LABELS[back]}、${ARM_LABELS[arm]}、${LEG_LABELS[leg]}`;
}

function requireCode(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`OWAS 编码 ${name}=${value} 非法,须为 1-${maximum} 整数`);
  }
}
