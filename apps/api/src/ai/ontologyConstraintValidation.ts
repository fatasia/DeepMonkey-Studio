import type { OntologyObjectType, OntologyProperty } from "@bim-studio/contracts";

/**
 * Semantica 刀3「本体约束校验」：轻量 SHACL 式校验器（零依赖、纯函数）。
 *
 * 校验对象：OntologyObject 实例值（属性键 → 值）对 OntologyObjectType 声明的
 * 必填/类型/枚举/单位格式约束。violation 清单（code/path/message）随结果返回；
 * 默认只报告不阻断，调用方（ontologyActionService）提供 strict 选项阻断。
 *
 * 两种校验口径：
 * - full：完整实例写入——必填 + 类型 + 枚举 + 单位格式 + 合同外属性全部生效；
 * - partial：行动参数校验——只对「与对象属性同名的键」做类型/枚举/单位校验；
 *   不查必填（参数不是完整实例）、不报 unknown-property（合同外参数归
 *   inputSchema/网关层管，不属本体约束域）。
 *
 * 规则表是数据不是代码硬编码：ONTOLOGY_CONSTRAINT_RULE_TABLE 是缺省启用的规则
 * 清单，调用方可传入裁剪后的表（禁用某条 = 该类检查不跑），扩展不改校验器本体。
 */

export type OntologyConstraintCode =
  | "required-missing"
  | "type-mismatch"
  | "enum-invalid"
  | "unit-format-invalid"
  | "unknown-property";

export interface OntologyConstraintViolation {
  code: OntologyConstraintCode;
  /** 违规位置：属性键（对象实例域）或 `values.<key>`（行动参数域由服务层标注）。 */
  path: string;
  message: string;
}

/** 规则表行：校验器按 id 启停对应检查；id 即违规码（一一对应，无隐藏规则）。 */
export interface OntologyConstraintRule {
  id: OntologyConstraintCode;
  enabled: boolean;
}

/** 缺省规则表：五条全开。裁剪请传自定义表（数据驱动，不改校验器）。 */
export const ONTOLOGY_CONSTRAINT_RULE_TABLE: readonly OntologyConstraintRule[] = [
  { id: "required-missing", enabled: true },
  { id: "type-mismatch", enabled: true },
  { id: "enum-invalid", enabled: true },
  { id: "unit-format-invalid", enabled: true },
  { id: "unknown-property", enabled: true },
];

export interface OntologyConstraintOptions {
  /** 规则表；缺省 ONTOLOGY_CONSTRAINT_RULE_TABLE。 */
  rules?: readonly OntologyConstraintRule[];
  /** full = 完整实例；partial = 行动参数（缺省 partial，行动路径的保守口径）。 */
  mode?: "full" | "partial";
}

export interface OntologyConstraintReport {
  objectKey: string;
  mode: "full" | "partial";
  /** 本次实际执行的规则 id（规则表内 enabled 且在该口径下适用的）。 */
  checkedRules: OntologyConstraintCode[];
  /** 被规则表禁用的规则 id（如实披露，便于审计「为什么没查」）。 */
  disabledRules: OntologyConstraintCode[];
  valid: boolean;
  violations: OntologyConstraintViolation[];
}

/** datetime 属性的 ISO 8601（UTC Z 口径，与 contracts 指纹体系的 ISO 口径一致）。 */
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** 单位复合格式：数值 + 空白 + 声明单位（如 "42 kW"）；声明单位按字面量转义后整词匹配。 */
function unitPattern(unit: string): RegExp {
  const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?\\s*${escaped}$`);
}

export function validateOntologyObjectValues(
  objectType: Pick<OntologyObjectType, "key" | "properties">,
  values: Record<string, unknown>,
  options: OntologyConstraintOptions = {},
): OntologyConstraintReport {
  const mode = options.mode ?? "partial";
  const table = new Map((options.rules ?? ONTOLOGY_CONSTRAINT_RULE_TABLE).map((rule) => [rule.id, rule.enabled]));
  const enabled = (code: OntologyConstraintCode): boolean => table.get(code) ?? true;
  const properties = new Map(objectType.properties.map((property) => [property.key, property]));
  const violations: OntologyConstraintViolation[] = [];
  const checked: OntologyConstraintCode[] = [];
  const disabled = (["required-missing", "type-mismatch", "enum-invalid", "unit-format-invalid", "unknown-property"] as const)
    .filter((code) => !enabled(code) && (mode === "full" || code !== "required-missing"));

  if (mode === "full" && enabled("unknown-property")) {
    checked.push("unknown-property");
    for (const key of Object.keys(values)) {
      if (!properties.has(key)) {
        violations.push({ code: "unknown-property", path: key, message: `对象 ${objectType.key} 未声明属性 ${key}（合同外属性不得随实例写入）` });
      }
    }
  }
  if (mode === "full" && enabled("required-missing")) {
    checked.push("required-missing");
    for (const property of objectType.properties) {
      if (!property.required) continue;
      const value = values[property.key];
      if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
        violations.push({ code: "required-missing", path: property.key, message: `必填属性 ${property.key}（${property.label}）缺失或为空` });
      }
    }
  }
  if (enabled("type-mismatch") || enabled("enum-invalid") || enabled("unit-format-invalid")) {
    // 两种口径都只校验「对象已声明的属性键」：full 多出的合同外键已由 unknown-property 报告。
    for (const [key, value] of Object.entries(values)) {
      const property = properties.get(key);
      if (!property) continue;
      if (value === undefined || value === null) continue; // 缺值归 required-missing 管，不做双重报告
      validateValue(objectType.key, property, value, enabled, checked, violations);
    }
  }
  return {
    objectKey: objectType.key,
    mode,
    checkedRules: [...new Set(checked)],
    disabledRules: disabled,
    valid: violations.length === 0,
    violations,
  };
}

function validateValue(
  objectKey: string,
  property: OntologyProperty,
  value: unknown,
  enabled: (code: OntologyConstraintCode) => boolean,
  checked: OntologyConstraintCode[],
  violations: OntologyConstraintViolation[],
): void {
  const fail = (code: OntologyConstraintCode, message: string) => violations.push({ code, path: property.key, message });
  // 声明了 unit 的属性按「或」口径：数值（单位由 schema 承载）或「数值+声明单位」复合格式
  // 字符串皆合法——字符串走单位格式检查，不走裸类型检查（否则带单位字符串必判类型不符）。
  if (property.unit && typeof value === "string") {
    if (!checked.includes("unit-format-invalid") && enabled("unit-format-invalid")) checked.push("unit-format-invalid");
    if (enabled("unit-format-invalid") && !unitPattern(property.unit).test(value.trim())) {
      fail("unit-format-invalid", `属性 ${property.key} 声明单位 ${property.unit}，字符串值必须形如「数值 ${property.unit}」，收到 "${value}"`);
    }
    return;
  }
  if (property.type === "enum") {
    if (enabled("type-mismatch") && typeof value !== "string") {
      if (!checked.includes("type-mismatch")) checked.push("type-mismatch");
      fail("type-mismatch", `枚举属性 ${property.key} 的值必须是字符串，收到 ${typeof value}`);
      return;
    }
    if (enabled("enum-invalid") && !property.enumValues?.includes(value as string)) {
      if (!checked.includes("enum-invalid")) checked.push("enum-invalid");
      fail("enum-invalid", `属性 ${property.key} 取值 ${String(value)} 不在枚举 [${(property.enumValues ?? []).join(", ")}] 内`);
    }
    return;
  }
  if (enabled("type-mismatch") && !valueMatchesType(property.type, value)) {
    if (!checked.includes("type-mismatch")) checked.push("type-mismatch");
    fail("type-mismatch", `属性 ${property.key}（${property.label}）声明类型 ${property.type}，收到 ${describeValue(value)}`);
    return;
  }
  if (!checked.includes("type-mismatch") && enabled("type-mismatch")) checked.push("type-mismatch");
}

function valueMatchesType(type: OntologyProperty["type"], value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "datetime":
      return typeof value === "string" && ISO_DATETIME_PATTERN.test(value);
    case "json":
      return true; // json 仅作透传容器（contracts 既定边界），不做结构校验
    default:
      return true;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
