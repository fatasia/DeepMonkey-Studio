export type SceneColorRuleOperator =
  | "equals"
  | "notEquals"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "in"
  | "between"
  | "exists";

export type SceneColorRulePrimitive = string | number | boolean | null;
export type SceneColorRuleValue = SceneColorRulePrimitive | SceneColorRulePrimitive[];

export interface SceneColorRule {
  field: string;
  operator: SceneColorRuleOperator;
  value?: SceneColorRuleValue;
  color: string;
  priority: number;
  enabled: boolean;
}

export interface SceneColorRuleMatch {
  rule: SceneColorRule;
  ruleIndex: number;
}

export interface SceneColorRuleEvaluation {
  color?: string;
  matchedRule?: SceneColorRuleMatch;
  matches: SceneColorRuleMatch[];
}

interface ResolvedField {
  found: boolean;
  value?: unknown;
}

interface IndexedRule {
  rule: SceneColorRule;
  ruleIndex: number;
}

const operators = new Set<SceneColorRuleOperator>([
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "in",
  "between",
  "exists"
]);

/**
 * Evaluates enabled, valid rules without trusting persisted or remote input.
 * Higher priorities win; ties keep declaration order.
 */
export function evaluateSceneColorRules(data: unknown, rules: unknown): SceneColorRuleEvaluation {
  const matches: SceneColorRuleMatch[] = [];
  const candidates = copyArray(rules);
  if (!isObject(data) || !candidates) return { matches };

  for (let ruleIndex = 0; ruleIndex < candidates.length; ruleIndex += 1) {
    const indexedRule = normalizeRule(candidates[ruleIndex], ruleIndex);
    if (!indexedRule || !indexedRule.rule.enabled) continue;
    if (safelyMatchesRule(data, indexedRule.rule)) matches.push(indexedRule);
  }

  matches.sort((left, right) => right.rule.priority - left.rule.priority || left.ruleIndex - right.ruleIndex);
  const matchedRule = matches[0];
  return matchedRule
    ? { color: matchedRule.rule.color, matchedRule, matches }
    : { matches };
}

export function matchesSceneColorRule(data: unknown, rule: unknown): boolean {
  const normalized = normalizeRule(rule, 0);
  return Boolean(normalized?.rule.enabled && isObject(data) && safelyMatchesRule(data, normalized.rule));
}

function safelyMatchesRule(data: object, rule: SceneColorRule): boolean {
  try {
    return matchesRule(data, rule);
  } catch {
    return false;
  }
}

function normalizeRule(input: unknown, ruleIndex: number): IndexedRule | undefined {
  if (!isObject(input)) return undefined;
  const field = safeRead(input, "field");
  const operator = safeRead(input, "operator");
  const value = safeRead(input, "value");
  const color = safeRead(input, "color");
  const priority = safeRead(input, "priority");
  const enabled = safeRead(input, "enabled");

  if (!field.found || typeof field.value !== "string" || !field.value.trim()) return undefined;
  if (!operator.found || !isOperator(operator.value)) return undefined;
  if (!color.found || typeof color.value !== "string" || !color.value.trim()) return undefined;
  if (!priority.found || typeof priority.value !== "number" || !Number.isFinite(priority.value)) return undefined;
  if (!enabled.found || typeof enabled.value !== "boolean") return undefined;
  if (operator.value !== "exists" && (!value.found || !isRuleValue(value.value))) return undefined;
  if (!hasValidOperatorValue(operator.value, value.value)) return undefined;

  return {
    ruleIndex,
    rule: {
      field: field.value.trim(),
      operator: operator.value,
      ...(operator.value === "exists" ? {} : { value: cloneRuleValue(value.value as SceneColorRuleValue) }),
      color: color.value.trim(),
      priority: priority.value,
      enabled: enabled.value
    }
  };
}

function matchesRule(data: object, rule: SceneColorRule): boolean {
  const resolved = resolveField(data, rule.field);
  if (rule.operator === "exists") return resolved.found;
  if (!resolved.found) return false;

  switch (rule.operator) {
    case "equals":
      return valuesEqual(resolved.value, rule.value);
    case "notEquals":
      return !valuesEqual(resolved.value, rule.value);
    case "contains":
      return containsValue(resolved.value, rule.value as SceneColorRulePrimitive);
    case "in":
      return (rule.value as SceneColorRulePrimitive[]).some((candidate) => valuesEqual(resolved.value, candidate));
    case "between": {
      const actual = finiteNumber(resolved.value);
      const range = rule.value as SceneColorRulePrimitive[];
      const first = finiteNumber(range[0]);
      const second = finiteNumber(range[1]);
      if (actual === undefined || first === undefined || second === undefined) return false;
      return actual >= Math.min(first, second) && actual <= Math.max(first, second);
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compareNumbers(resolved.value, rule.value, rule.operator);
  }
}

function resolveField(data: object, field: string): ResolvedField {
  const direct = safeRead(data, field);
  if (direct.found) return direct;

  const path = field.split(".");
  if (path.length < 2 || path.some((segment) => !segment)) return { found: false };
  let current: unknown = data;
  for (const segment of path) {
    if (!isObject(current)) return { found: false };
    const next = safeRead(current, segment);
    if (!next.found) return { found: false };
    current = next.value;
  }
  return { found: true, value: current };
}

function safeRead(target: object, key: string): ResolvedField {
  try {
    if (!Object.prototype.hasOwnProperty.call(target, key)) return { found: false };
    return { found: true, value: (target as Record<string, unknown>)[key] };
  } catch {
    return { found: false };
  }
}

function compareNumbers(actualValue: unknown, expectedValue: unknown, operator: "gt" | "gte" | "lt" | "lte"): boolean {
  const actual = finiteNumber(actualValue);
  const expected = finiteNumber(expectedValue);
  if (actual === undefined || expected === undefined) return false;
  if (operator === "gt") return actual > expected;
  if (operator === "gte") return actual >= expected;
  if (operator === "lt") return actual < expected;
  return actual <= expected;
}

function containsValue(actual: unknown, expected: SceneColorRulePrimitive): boolean {
  if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
  if (Array.isArray(actual)) return actual.some((item) => valuesEqual(item, expected));
  return false;
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  return isPrimitive(actual) && isPrimitive(expected) && Object.is(actual, expected);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasValidOperatorValue(operator: SceneColorRuleOperator, value: unknown): boolean {
  if (operator === "exists") return true;
  if (operator === "in") return Array.isArray(value);
  if (operator === "between") {
    return Array.isArray(value)
      && value.length === 2
      && finiteNumber(value[0]) !== undefined
      && finiteNumber(value[1]) !== undefined;
  }
  if (operator === "contains") return isPrimitive(value);
  if (operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") {
    return finiteNumber(value) !== undefined;
  }
  return isPrimitive(value);
}

function cloneRuleValue(value: SceneColorRuleValue): SceneColorRuleValue {
  return Array.isArray(value) ? [...value] : value;
}

function isRuleValue(value: unknown): value is SceneColorRuleValue {
  return isPrimitive(value) || (Array.isArray(value) && value.every(isPrimitive));
}

function isPrimitive(value: unknown): value is SceneColorRulePrimitive {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function isOperator(value: unknown): value is SceneColorRuleOperator {
  return typeof value === "string" && operators.has(value as SceneColorRuleOperator);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function copyArray(value: unknown): unknown[] | undefined {
  try {
    return Array.isArray(value) ? [...value] : undefined;
  } catch {
    return undefined;
  }
}
