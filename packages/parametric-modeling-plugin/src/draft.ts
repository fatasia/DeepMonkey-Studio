import type { ParametricCadDefinition } from "@bim-studio/contracts";
import { assertParametricCadDefinition } from "./validation.js";

/** AI 只负责生成受限 DSL 草案，不得输出脚本、CAD 指令或可执行代码。 */
export const PARAMETRIC_DRAFT_INSTRUCTIONS = `你是工业附件参数化建模助手。只返回一个 JSON 对象，不要 Markdown。
对象必须符合 ParametricCadDefinition schemaVersion=1，单位只能是 mm。
primitive 只能是 box、cylinder、sphere、ellipsoid；operation 只能是 base、union、cut、intersect。
表达式只能引用已声明参数，并使用数字、+、-、*、/、括号；禁止函数、属性访问、脚本和任意代码。
首个 feature 必须是 base，后续 feature 不能是 base。尺寸必须为正，参数必须包含合理 min/max/step。
优先生成可制造、简洁、低特征数量的设备附件，并用 semanticBindings 描述有价值的尺寸含义。`;

export function parseParametricDraft(text: string): ParametricCadDefinition {
  if (typeof text !== "string" || !text.trim()) throw new Error("AI 未返回参数化草案");
  if (text.length > 256 * 1024) throw new Error("AI 参数化草案超过 256 KiB");
  const normalized = stripJsonFence(text.trim());
  let input: unknown;
  try { input = JSON.parse(normalized); }
  catch { throw new Error("AI 参数化草案不是有效 JSON"); }
  return assertParametricCadDefinition(input);
}

function stripJsonFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? value;
}
