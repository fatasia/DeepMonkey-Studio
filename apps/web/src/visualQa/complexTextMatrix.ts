/**
 * T21 复杂文本矩阵：虚拟滚动行内单一定义的样本集。
 * 组件测试（complexTextMatrix.test.tsx）、QA 路由（?text=1）与浏览器证据脚本共用，
 * 避免矩阵在测试与验收之间漂移。
 */
export interface ComplexTextSample { id: string; label: string; text: string }

const longUnbroken = `P4500-CENTRIFUGAL-PUMP-IMPELLER-DIAMETER-${"320MM-STAINLESS-STEEL-".repeat(24)}END`;

export const COMPLEX_TEXT_MATRIX: readonly ComplexTextSample[] = [
  { id: "cjk-baseline", label: "中文基线", text: "工业设备 00001（离心泵）" },
  { id: "arabic-rtl", label: "阿拉伯语 RTL", text: "مضخة طرد مركزي طراز P-4500/ثلاثية المراحل" },
  { id: "hebrew-rtl", label: "希伯来语 RTL", text: "משאבה צנטריפוגלית דגם P-4500/תלת-שלבי" },
  { id: "thai-combining", label: "泰文组合字符", text: "ปั๊มน้ำอุตสาหกรรมรุ่นที่๓ ฉบับปรับปรุงแก้ไข" },
  { id: "korean-nfd", label: "韩文 NFC+NFD 分解字母", text: "페프가\u1100\u1161\u11A8\u1102\u1161 공장 설비" },
  { id: "emoji-zwj", label: "emoji ZWJ 与旗标", text: "设备家族👨‍👩‍👧‍👦与旗标🇨🇳🇩🇪巡检" },
  { id: "surrogate-pair", label: "增补平面代理对", text: "𠀀𠀁𠂊𠂇 𝕏𝕐 数学字母" },
  { id: "mixed-bidi", label: "双向混排边界", text: "泵站P-4500חיפוש压力3.5MPa" },
  { id: "long-unbroken", label: "600 字符无空格长串", text: longUnbroken },
] as const;

/** 按行索引取矩阵样本；普通行走回退名称，保证 100,000 行规模下矩阵行稀疏且位置可预测。 */
export function complexTextFixtureName(index: number, fallback: string, stride = 8): string | undefined {
  if (index % stride !== 0) return undefined;
  return COMPLEX_TEXT_MATRIX[(index / stride) % COMPLEX_TEXT_MATRIX.length]?.text;
}
