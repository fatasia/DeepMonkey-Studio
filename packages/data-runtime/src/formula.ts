export type FormulaValue = string | number | boolean | null;

export type FormulaExpression =
  | { kind: "literal"; value: FormulaValue; start: number; end: number }
  | { kind: "field"; path: string[]; start: number; end: number }
  | { kind: "unary"; operator: "!" | "+" | "-"; value: FormulaExpression; start: number; end: number }
  | { kind: "binary"; operator: string; left: FormulaExpression; right: FormulaExpression; start: number; end: number }
  | { kind: "call"; name: string; arguments: FormulaExpression[]; start: number; end: number };

export interface CompiledFormula {
  readonly source: string;
  readonly expression: FormulaExpression;
  readonly dependencies: readonly string[];
}

export class FormulaError extends Error {
  constructor(message: string, readonly start: number, readonly end = start + 1) {
    super(`${message}（位置 ${start + 1}）`);
    this.name = "FormulaError";
  }
}

type TokenKind = "number" | "string" | "identifier" | "operator" | "punctuation" | "eof";
interface Token { kind: TokenKind; value: string; start: number; end: number; }

const PRECEDENCE: Readonly<Record<string, number>> = { "||": 1, "&&": 2, "==": 3, "!=": 3, ">": 4, ">=": 4, "<": 4, "<=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
const SAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function compileFormula(source: string): CompiledFormula {
  const parser = new Parser(source);
  const expression = parser.parse();
  const dependencies = [...collectDependencies(expression)].sort();
  return { source, expression, dependencies };
}

export function evaluateFormula(compiled: CompiledFormula | FormulaExpression, record: Readonly<Record<string, unknown>>): FormulaValue {
  return evaluate("expression" in compiled ? compiled.expression : compiled, record);
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(private readonly source: string) {
    this.tokens = tokenize(source);
  }

  parse(): FormulaExpression {
    if (this.peek().kind === "eof") throw new FormulaError("公式不能为空", 0, 0);
    const expression = this.parseExpression(0);
    const trailing = this.peek();
    if (trailing.kind !== "eof") throw new FormulaError(`无法识别“${trailing.value}”`, trailing.start, trailing.end);
    return expression;
  }

  private parseExpression(minimumPrecedence: number): FormulaExpression {
    let left = this.parseUnary();
    while (true) {
      const operator = this.peek();
      const precedence = operator.kind === "operator" ? PRECEDENCE[operator.value] : undefined;
      if (precedence === undefined || precedence < minimumPrecedence) break;
      this.index += 1;
      const right = this.parseExpression(precedence + 1);
      left = { kind: "binary", operator: operator.value, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseUnary(): FormulaExpression {
    const token = this.peek();
    if (token.kind === "operator" && ["!", "+", "-"].includes(token.value)) {
      this.index += 1;
      const value = this.parseUnary();
      return { kind: "unary", operator: token.value as "!" | "+" | "-", value, start: token.start, end: value.end };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaExpression {
    const token = this.consume();
    if (token.kind === "number") return { kind: "literal", value: Number(token.value), start: token.start, end: token.end };
    if (token.kind === "string") return { kind: "literal", value: token.value, start: token.start, end: token.end };
    if (token.kind === "identifier") {
      const keyword = token.value.toLocaleLowerCase();
      if (["true", "false", "null"].includes(keyword)) return { kind: "literal", value: keyword === "null" ? null : keyword === "true", start: token.start, end: token.end };
      if (this.match("(")) {
        const args: FormulaExpression[] = [];
        if (!this.match(")")) {
          do args.push(this.parseExpression(0)); while (this.match(","));
          this.expect(")");
        }
        return { kind: "call", name: token.value.toLocaleUpperCase(), arguments: args, start: token.start, end: this.previous().end };
      }
      const path = [token.value];
      let end = token.end;
      while (this.match(".")) {
        const segment = this.consume();
        if (segment.kind !== "identifier") throw new FormulaError("字段路径缺少名称", segment.start, segment.end);
        path.push(segment.value);
        end = segment.end;
      }
      if (path.some((segment) => SAFE_PATH_SEGMENTS.has(segment))) throw new FormulaError("字段路径包含禁止访问的名称", token.start, end);
      return { kind: "field", path, start: token.start, end };
    }
    if (token.value === "(") {
      const expression = this.parseExpression(0);
      this.expect(")");
      return expression;
    }
    throw new FormulaError(`此处需要值，实际为“${token.value || "公式结尾"}”`, token.start, token.end);
  }

  private peek(): Token { return this.tokens[this.index]!; }
  private previous(): Token { return this.tokens[Math.max(0, this.index - 1)]!; }
  private consume(): Token { return this.tokens[this.index++]!; }
  private match(value: string): boolean { if (this.peek().value !== value) return false; this.index += 1; return true; }
  private expect(value: string): void { const token = this.consume(); if (token.value !== value) throw new FormulaError(`需要“${value}”`, token.start, token.end); }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/u.test(char)) { index += 1; continue; }
    const start = index;
    if (/[0-9]/u.test(char) || (char === "." && /[0-9]/u.test(source[index + 1] ?? ""))) {
      index += 1;
      while (/[0-9_]/u.test(source[index] ?? "")) index += 1;
      if (source[index] === ".") { index += 1; while (/[0-9_]/u.test(source[index] ?? "")) index += 1; }
      if (/[eE]/u.test(source[index] ?? "")) { index += 1; if (/[+-]/u.test(source[index] ?? "")) index += 1; while (/[0-9]/u.test(source[index] ?? "")) index += 1; }
      const value = source.slice(start, index).replaceAll("_", "");
      if (!Number.isFinite(Number(value))) throw new FormulaError("数字格式无效", start, index);
      tokens.push({ kind: "number", value, start, end: index });
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          index += 1;
          const escaped = source[index];
          if (escaped === undefined) break;
          value += ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escaped] ?? escaped;
          index += 1;
        } else value += source[index++]!;
      }
      if (source[index] !== quote) throw new FormulaError("字符串缺少结束引号", start, index);
      index += 1;
      tokens.push({ kind: "string", value, start, end: index });
      continue;
    }
    if (/[A-Za-z_$\p{L}]/u.test(char)) {
      index += 1;
      while (/[\w$\p{L}\p{N}]/u.test(source[index] ?? "")) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index), start, end: index });
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (["&&", "||", "==", "!=", ">=", "<="].includes(pair)) { tokens.push({ kind: "operator", value: pair, start, end: index + 2 }); index += 2; continue; }
    if (["+", "-", "*", "/", "%", "!", ">", "<"].includes(char)) { tokens.push({ kind: "operator", value: char, start, end: ++index }); continue; }
    if (["(", ")", ",", "."].includes(char)) { tokens.push({ kind: "punctuation", value: char, start, end: ++index }); continue; }
    throw new FormulaError(`不支持的字符“${char}”`, start, start + 1);
  }
  tokens.push({ kind: "eof", value: "", start: source.length, end: source.length });
  return tokens;
}

function collectDependencies(expression: FormulaExpression, output = new Set<string>()): Set<string> {
  if (expression.kind === "field") output.add(expression.path.join("."));
  if (expression.kind === "unary") collectDependencies(expression.value, output);
  if (expression.kind === "binary") { collectDependencies(expression.left, output); collectDependencies(expression.right, output); }
  if (expression.kind === "call") for (const argument of expression.arguments) collectDependencies(argument, output);
  return output;
}

function evaluate(expression: FormulaExpression, record: Readonly<Record<string, unknown>>): FormulaValue {
  if (expression.kind === "literal") return expression.value;
  if (expression.kind === "field") {
    let value: unknown = record;
    for (const segment of expression.path) value = value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, segment) ? (value as Record<string, unknown>)[segment] : null;
    return normalizeValue(value, expression);
  }
  if (expression.kind === "unary") {
    const value = evaluate(expression.value, record);
    if (expression.operator === "!") return !truthy(value);
    const number = numeric(value, expression);
    return expression.operator === "-" ? -number : number;
  }
  if (expression.kind === "binary") {
    if (expression.operator === "&&") return truthy(evaluate(expression.left, record)) && truthy(evaluate(expression.right, record));
    if (expression.operator === "||") return truthy(evaluate(expression.left, record)) || truthy(evaluate(expression.right, record));
    const left = evaluate(expression.left, record);
    const right = evaluate(expression.right, record);
    if (expression.operator === "+" && (typeof left === "string" || typeof right === "string")) return String(left ?? "") + String(right ?? "");
    if (expression.operator === "+") return numeric(left, expression.left) + numeric(right, expression.right);
    if (expression.operator === "-") return numeric(left, expression.left) - numeric(right, expression.right);
    if (expression.operator === "*") return numeric(left, expression.left) * numeric(right, expression.right);
    if (expression.operator === "/") { const divisor = numeric(right, expression.right); if (divisor === 0) throw new FormulaError("不能除以零", expression.right.start, expression.right.end); return numeric(left, expression.left) / divisor; }
    if (expression.operator === "%") return numeric(left, expression.left) % numeric(right, expression.right);
    if (expression.operator === "==") return left === right;
    if (expression.operator === "!=") return left !== right;
    if (expression.operator === ">") return comparable(left) > comparable(right);
    if (expression.operator === ">=") return comparable(left) >= comparable(right);
    if (expression.operator === "<") return comparable(left) < comparable(right);
    if (expression.operator === "<=") return comparable(left) <= comparable(right);
    throw new FormulaError(`不支持运算符 ${expression.operator}`, expression.start, expression.end);
  }
  const name = expression.name;
  if (name === "IF") { requireArguments(expression, 3, 3); return truthy(evaluate(expression.arguments[0]!, record)) ? evaluate(expression.arguments[1]!, record) : evaluate(expression.arguments[2]!, record); }
  if (name === "COALESCE") { for (const argument of expression.arguments) { const value = evaluate(argument, record); if (value !== null && value !== "") return value; } return null; }
  const values = expression.arguments.map((argument) => evaluate(argument, record));
  if (name === "ROUND") { requireArguments(expression, 1, 2); const digits = values[1] === undefined ? 0 : numeric(values[1]!, expression.arguments[1]!); const factor = 10 ** digits; return Math.round(numeric(values[0]!, expression.arguments[0]!) * factor) / factor; }
  if (name === "ABS") { requireArguments(expression, 1, 1); return Math.abs(numeric(values[0]!, expression.arguments[0]!)); }
  if (name === "MIN" || name === "MAX") { requireArguments(expression, 1); const numbers = values.map((value, index) => numeric(value, expression.arguments[index]!)); return name === "MIN" ? Math.min(...numbers) : Math.max(...numbers); }
  if (name === "CONCAT") return values.map((value) => String(value ?? "")).join("");
  if (name === "UPPER" || name === "LOWER") { requireArguments(expression, 1, 1); const value = String(values[0] ?? ""); return name === "UPPER" ? value.toLocaleUpperCase() : value.toLocaleLowerCase(); }
  throw new FormulaError(`未知函数 ${name}`, expression.start, expression.end);
}

function requireArguments(expression: Extract<FormulaExpression, { kind: "call" }>, minimum: number, maximum = Number.POSITIVE_INFINITY): void {
  if (expression.arguments.length < minimum || expression.arguments.length > maximum) throw new FormulaError(`${expression.name} 参数数量应为 ${minimum}${maximum === minimum ? "" : ` 至 ${maximum}`}`, expression.start, expression.end);
}

function numeric(value: FormulaValue, expression: FormulaExpression): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new FormulaError("此处需要数字", expression.start, expression.end);
}

function comparable(value: FormulaValue): number | string { return typeof value === "number" ? value : String(value ?? ""); }
function truthy(value: FormulaValue): boolean { return Boolean(value); }
function normalizeValue(value: unknown, expression: FormulaExpression): FormulaValue {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value ?? null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new FormulaError("公式字段只能是字符串、数字、布尔值或空值", expression.start, expression.end);
}
