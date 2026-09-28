/**
 * T31 受限行为表达式求值器(切片一)。
 *
 * 与既有两条脚本通道的关系(六步核查结论):
 * - interaction 可信脚本(viewerEngineInteraction.ts)与 behavior Worker 沙箱
 *   (sceneBehavior.worker.ts)都以 `new AsyncFunction` 动态编译作者 JS——表达力强,
 *   但非确定、不可静态审计。
 * - 本求值器是受限通道:手写 Tokenizer→Pratt Parser→AST→求值,零动态代码生成,
 *   纯函数可单测,服务"确定性、可审计、步数预算"的工业行为逻辑(主计划 T31,对标
 *   西门子逻辑组态的表达式面,按 Deep 口径不做通用语言)。
 *
 * 硬边界:
 * 1. 无 IO:不触 Date/performance/Math.random/全局对象;变量环境显式注入、只读。
 * 2. 无动态代码生成:无 eval / new Function / with;函数调用、赋值、计算成员访问、
 *    模板串、数组/对象字面量在语法层即拒绝(非运行时兜底)。
 * 3. 步数预算:每求值一个 AST 节点计一步,超限抛错并终止;AST 深度、源长度、
 *    token 数均有上限,防解析期递归爆栈与超长输入。
 * 4. 确定性:同 AST + 同环境 → 同值、同步数;严格类型算术(禁 JS 弱类型隐式转换),
 *    相等比较为严格相等,杜绝 NaN 弱相等之类的歧义语义。
 */

/** 求值器限制(全部有默认值,可按宿主收紧;上限即安全边界,不允许放宽超过硬上限)。 */
export interface RestrictedEvaluatorLimits {
  /** 表达式源最大字符数。 */
  readonly maxSourceLength: number;
  /** token 最大数量。 */
  readonly maxTokens: number;
  /** AST 最大深度(括号/运算嵌套),防解析递归爆栈。 */
  readonly maxAstDepth: number;
  /** 单次求值默认步数预算(每 AST 节点计一步)。 */
  readonly defaultStepBudget: number;
  /** 标识符点路径最大段数(a.b.c = 3 段)。 */
  readonly maxIdentifierSegments: number;
  /** 步数预算硬上限(宿主传入的预算会被夹到此值内)。 */
  readonly maxStepBudget: number;
}

export const RESTRICTED_EVALUATOR_LIMITS: RestrictedEvaluatorLimits = {
  maxSourceLength: 1_024,
  maxTokens: 512,
  maxAstDepth: 32,
  defaultStepBudget: 1_000,
  maxIdentifierSegments: 4,
  maxStepBudget: 100_000,
} as const;

/** 语法错误:解析期发现,含行内偏移,便于脚本 UI 定位(编辑器 UI 留后续切片)。 */
export class RestrictedExpressionSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message}(偏移 ${offset})`);
    this.name = "RestrictedExpressionSyntaxError";
    this.offset = offset;
  }
}

/** 求值错误:未知标识符、类型不匹配等语义违规。 */
export class RestrictedExpressionEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestrictedExpressionEvalError";
  }
}

/** 预算耗尽:求值步数超过预算,求值立即终止(部分结果不外泄,保证可审计中断点)。 */
export class RestrictedExpressionBudgetError extends Error {
  constructor(stepBudget: number) {
    super(`表达式求值超过步数预算 ${stepBudget},已终止`);
    this.name = "RestrictedExpressionBudgetError";
  }
}

/* ---------------------------------- AST ---------------------------------- */

export type RestrictedAst =
  | { readonly kind: "literal"; readonly value: number | string | boolean | null }
  | { readonly kind: "identifier"; readonly path: readonly string[] }
  | { readonly kind: "unary"; readonly operator: "-" | "!"; readonly operand: RestrictedAst }
  | { readonly kind: "binary"; readonly operator: RestrictedBinaryOperator; readonly left: RestrictedAst; readonly right: RestrictedAst }
  | { readonly kind: "logical"; readonly operator: "&&" | "||"; readonly left: RestrictedAst; readonly right: RestrictedAst }
  | { readonly kind: "conditional"; readonly test: RestrictedAst; readonly consequent: RestrictedAst; readonly alternate: RestrictedAst };

export type RestrictedBinaryOperator =
  | "+" | "-" | "*" | "/" | "%" | "**"
  | "==" | "!=" | "<" | "<=" | ">" | ">=";

export interface CompiledExpression {
  readonly source: string;
  readonly ast: RestrictedAst;
}

/* -------------------------------- 词法分析 -------------------------------- */

interface Token {
  readonly type: "number" | "string" | "identifier" | "operator" | "paren";
  readonly value: string;
  readonly offset: number;
}

const KEYWORD_LITERALS = new Set(["true", "false", "null"]);
const MULTI_CHAR_OPERATORS = ["**", "==", "!=", "<=", ">="] as const;
const SINGLE_CHAR_OPERATORS = "+-*/%<>!?:.".split("") as string[];
/** 支持的运算符全集;不在此集内的符号(位运算、in、typeof 等)直接词法报错。 */
const KNOWN_OPERATORS = new Set<string>([...MULTI_CHAR_OPERATORS, ...SINGLE_CHAR_OPERATORS, "&&", "||"]);

function tokenize(source: string, limits: RestrictedEvaluatorLimits): Token[] {
  if (source.length > limits.maxSourceLength) {
    throw new RestrictedExpressionSyntaxError(`表达式超过最大长度 ${limits.maxSourceLength}`, limits.maxSourceLength);
  }
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }
    // 数字字面量:十进制整数/小数,支持科学计数;不支持十六进制/二进制(工业表达式用不上,减小面)。
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source.charAt(index + 1) ?? ""))) {
      const start = index;
      while (index < source.length && /[0-9._eE+-]/.test(source.charAt(index))) {
        // 数字中允许的 +/- 只能出现在 e/E 之后;连续下划线等交给 Number() 校验失败再报错。
        const current = source.charAt(index);
        if ((current === "+" || current === "-") && !/[eE]/.test(source.charAt(index - 1) ?? "")) break;
        if (current === "_" && !/[0-9]/.test(source.charAt(index + 1) ?? "")) break;
        index += 1;
      }
      const raw = source.slice(start, index).replaceAll("_", "");
      const value = Number(raw);
      if (raw === "" || !Number.isFinite(value)) {
        throw new RestrictedExpressionSyntaxError(`非法数字字面量 “${raw}”`, start);
      }
      tokens.push({ type: "number", value: raw, offset: start });
      continue;
    }
    // 字符串字面量:单引号或双引号,不支持转义与插值(确定性、可审计优先;转义需求后续按需扩)。
    if (char === '"' || char === "'") {
      const start = index;
      const quote = char;
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source.charAt(index);
        if (current === quote) {
          closed = true;
          index += 1;
          break;
        }
        index += 1;
      }
      if (!closed) throw new RestrictedExpressionSyntaxError("字符串字面量未闭合", start);
      tokens.push({ type: "string", value: source.slice(start + 1, index - 1), offset: start });
      continue;
    }
    // 标识符:字母/下划线开头,字母/数字/下划线组成;点路径在解析期拆段。
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_]/.test(source.charAt(index))) index += 1;
      tokens.push({ type: "identifier", value: source.slice(start, index), offset: start });
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char, offset: index });
      index += 1;
      continue;
    }
    // 运算符:先匹配双字符(&&、||、**、==、!=、<=、>=),再单字符。
    const two = source.slice(index, index + 2);
    if (MULTI_CHAR_OPERATORS.includes(two as (typeof MULTI_CHAR_OPERATORS)[number]) || two === "&&" || two === "||") {
      tokens.push({ type: "operator", value: two, offset: index });
      index += 2;
      continue;
    }
    if (SINGLE_CHAR_OPERATORS.includes(char)) {
      if (!KNOWN_OPERATORS.has(char)) throw new RestrictedExpressionSyntaxError(`不支持的符号 “${char}”`, index);
      tokens.push({ type: "operator", value: char, offset: index });
      index += 1;
      continue;
    }
    throw new RestrictedExpressionSyntaxError(`不支持的字符 “${char}”`, index);
  }
  if (tokens.length > limits.maxTokens) {
    throw new RestrictedExpressionSyntaxError(`表达式超过最大 token 数 ${limits.maxTokens}`, 0);
  }
  return tokens;
}

/* -------------------------------- 语法分析 -------------------------------- */

/** Pratt 优先级;数值越大结合越紧。三元与逻辑运算的优先级与 JS 一致。 */
const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3, "!=": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
  "**": 8,
};

interface ParserState {
  readonly tokens: readonly Token[];
  position: number;
  depth: number;
  readonly limits: RestrictedEvaluatorLimits;
}

function parseExpression(source: string, limits: RestrictedEvaluatorLimits): RestrictedAst {
  const state: ParserState = { tokens: tokenize(source, limits), position: 0, depth: 0, limits };
  if (state.tokens.length === 0) throw new RestrictedExpressionSyntaxError("表达式为空", 0);
  const ast = parseTernary(state);
  const trailing = state.tokens[state.position];
  if (trailing) throw new RestrictedExpressionSyntaxError(`存在无法解析的尾随 token “${trailing.value}”`, trailing.offset);
  return ast;
}

function enterDepth(state: ParserState, offset: number): void {
  state.depth += 1;
  if (state.depth > state.limits.maxAstDepth) {
    throw new RestrictedExpressionSyntaxError(`表达式嵌套超过最大深度 ${state.limits.maxAstDepth}`, offset);
  }
}

function parseTernary(state: ParserState): RestrictedAst {
  enterDepth(state, currentOffset(state));
  const test = parseBinary(state, 0);
  const question = peekOperator(state, "?");
  if (!question) {
    state.depth -= 1;
    return test;
  }
  consume(state);
  const consequent = parseTernary(state);
  expectOperator(state, ":");
  const alternate = parseTernary(state);
  state.depth -= 1;
  return { kind: "conditional", test, consequent, alternate };
}

function parseBinary(state: ParserState, minPrecedence: number): RestrictedAst {
  enterDepth(state, currentOffset(state));
  let left = parseUnary(state);
  for (;;) {
    const token = state.tokens[state.position];
    if (!token || token.type !== "operator") break;
    // 三元的 '?' 归 parseTernary 管;':' 由上层消费。
    if (token.value === "?" || token.value === ":") break;
    const precedence = BINARY_PRECEDENCE[token.value];
    if (precedence === undefined || precedence < minPrecedence) break;
    // '**' 右结合;其余左结合。
    const nextMin = token.value === "**" ? precedence : precedence + 1;
    consume(state);
    const right = parseBinary(state, nextMin);
    left = token.value === "&&" || token.value === "||"
      ? { kind: "logical", operator: token.value, left, right }
      : { kind: "binary", operator: token.value as RestrictedBinaryOperator, left, right };
  }
  state.depth -= 1;
  return left;
}

function parseUnary(state: ParserState): RestrictedAst {
  enterDepth(state, currentOffset(state));
  const token = state.tokens[state.position];
  if (token && token.type === "operator" && (token.value === "-" || token.value === "!")) {
    consume(state);
    const operand = parseUnary(state);
    state.depth -= 1;
    return { kind: "unary", operator: token.value as "-" | "!", operand };
  }
  const ast = parsePrimary(state);
  state.depth -= 1;
  return ast;
}

function parsePrimary(state: ParserState): RestrictedAst {
  const token = state.tokens[state.position];
  if (!token) throw new RestrictedExpressionSyntaxError("表达式意外结束", sourceEnd(state));
  if (token.type === "number") {
    consume(state);
    return { kind: "literal", value: Number(token.value) };
  }
  if (token.type === "string") {
    consume(state);
    return { kind: "literal", value: token.value };
  }
  if (token.type === "identifier") {
    if (KEYWORD_LITERALS.has(token.value)) {
      consume(state);
      return { kind: "literal", value: token.value === "true" ? true : token.value === "false" ? false : null };
    }
    // 标识符后跟 '(' 即函数调用——语法层直接拒绝(受限通道无函数)。
    const next = state.tokens[state.position + 1];
    if (next && next.type === "paren" && next.value === "(") {
      throw new RestrictedExpressionSyntaxError(`受限表达式不允许函数调用 “${token.value}(…)”`, next.offset);
    }
    consume(state);
    // 点路径:a.b.c;深度受限;路径段与首段同样只允许标识符字符。
    const path = [token.value];
    for (;;) {
      const dot = state.tokens[state.position];
      if (!dot || dot.type !== "operator" || dot.value !== ".") break;
      const segment = state.tokens[state.position + 1];
      if (!segment || segment.type !== "identifier") {
        throw new RestrictedExpressionSyntaxError("“.” 后必须是标识符", dot.offset);
      }
      path.push(segment.value);
      consume(state);
      consume(state);
    }
    if (path.length > state.limits.maxIdentifierSegments) {
      throw new RestrictedExpressionSyntaxError(
        `标识符路径超过最大段数 ${state.limits.maxIdentifierSegments}`,
        token.offset,
      );
    }
    // 路径段写法歧义防御:数字段已不可能(token 类型限定),这里再拦保留字,避免 true.x 之类。
    if (path.some((segment) => KEYWORD_LITERALS.has(segment))) {
      throw new RestrictedExpressionSyntaxError("路径段不允许保留字", token.offset);
    }
    return { kind: "identifier", path };
  }
  if (token.type === "paren" && token.value === "(") {
    consume(state);
    const inner = parseTernary(state);
    expectOperator(state, ")", ")");
    return inner;
  }
  throw new RestrictedExpressionSyntaxError(`意外的 token “${token.value}”`, token.offset);
}

function currentOffset(state: ParserState): number {
  return state.tokens[state.position]?.offset ?? sourceEnd(state);
}

function sourceEnd(state: ParserState): number {
  const last = state.tokens[state.tokens.length - 1];
  return last ? last.offset + last.value.length : 0;
}

function peekOperator(state: ParserState, value: string): boolean {
  // ")" 等括号属于 paren 类型,运算符属于 operator 类型;两者都按字面值匹配。
  const token = state.tokens[state.position];
  return (token?.type === "operator" || token?.type === "paren") && token.value === value;
}

function expectOperator(state: ParserState, value: string, display = value): void {
  if (!peekOperator(state, value)) {
    const token = state.tokens[state.position];
    throw new RestrictedExpressionSyntaxError(
      token ? `期望 “${display}”,得到 “${token.value}”` : `期望 “${display}”,表达式意外结束`,
      currentOffset(state),
    );
  }
  consume(state);
}

function consume(state: ParserState): void {
  state.position += 1;
}

/* ---------------------------------- 求值 ---------------------------------- */

/** 环境取值:只读;未知标识符报错而不是返回 undefined(可审计:引用必须显式存在)。 */
function readIdentifier(path: readonly string[], environment: BehaviorExpressionEnvironment): unknown {
  let current: unknown = environment;
  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      throw new RestrictedExpressionEvalError(`标识符路径 “${path.join(".")}” 在 “${segment}” 处不可继续取值`);
    }
    if (!Object.hasOwn(current, segment)) {
      throw new RestrictedExpressionEvalError(`未知标识符 “${path.join(".")}”`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    throw new RestrictedExpressionEvalError(`未知标识符 “${path.join(".")}”`);
  }
  return current;
}

export type BehaviorExpressionEnvironment = Record<string, unknown>;

/**
 * 编译表达式:解析一次,求值多次(运行时热路径复用 AST)。
 * 纯函数:同 source 同 limits → 同 AST。
 */
export function compileExpression(
  source: string,
  limits: Partial<RestrictedEvaluatorLimits> = {},
): CompiledExpression {
  const merged = { ...RESTRICTED_EVALUATOR_LIMITS, ...limits } as RestrictedEvaluatorLimits;
  return { source, ast: parseExpression(source, merged) };
}

interface EvaluationSession {
  steps: number;
  readonly budget: number;
}

function step(session: EvaluationSession, node: RestrictedAst): void {
  session.steps += 1;
  if (session.steps > session.budget) throw new RestrictedExpressionBudgetError(session.budget);
}

/**
 * 求值已编译表达式。纯函数:不读写任何模块级可变状态;
 * 同 ast + 同 environment + 同预算 → 同结果、同步数、同异常。
 */
export function evaluateCompiledExpression(
  ast: RestrictedAst,
  environment: BehaviorExpressionEnvironment,
  stepBudget = RESTRICTED_EVALUATOR_LIMITS.defaultStepBudget,
): unknown {
  return evaluateCompiledExpressionDetailed(ast, environment, stepBudget).value;
}

/** 带实际步数的求值:运行时按此精确累计会话预算(审计口径:预算消耗可复核)。 */
export function evaluateCompiledExpressionDetailed(
  ast: RestrictedAst,
  environment: BehaviorExpressionEnvironment,
  stepBudget = RESTRICTED_EVALUATOR_LIMITS.defaultStepBudget,
): { value: unknown; steps: number } {
  const budget = Math.min(
    Math.max(1, Math.floor(stepBudget)),
    RESTRICTED_EVALUATOR_LIMITS.maxStepBudget,
  );
  const session: EvaluationSession = { steps: 0, budget };
  return { value: evaluateNode(ast, environment, session), steps: session.steps };
}

function evaluateNode(node: RestrictedAst, environment: BehaviorExpressionEnvironment, session: EvaluationSession): unknown {
  step(session, node);
  switch (node.kind) {
    case "literal":
      return node.value;
    case "identifier":
      return readIdentifier(node.path, environment);
    case "unary": {
      const operand = evaluateNode(node.operand, environment, session);
      if (node.operator === "-") {
        requireNumber(operand, "一元取负");
        return -operand;
      }
      return !operand;
    }
    case "conditional": {
      const test = evaluateNode(node.test, environment, session);
      return test ? evaluateNode(node.consequent, environment, session) : evaluateNode(node.alternate, environment, session);
    }
    case "logical": {
      const left = evaluateNode(node.left, environment, session);
      if (node.operator === "&&") return left ? evaluateNode(node.right, environment, session) : left;
      return left ? left : evaluateNode(node.right, environment, session);
    }
    case "binary":
      return evaluateBinary(node, environment, session);
  }
}

function evaluateBinary(
  node: Extract<RestrictedAst, { kind: "binary" }>,
  environment: BehaviorExpressionEnvironment,
  session: EvaluationSession,
): unknown {
  const left = evaluateNode(node.left, environment, session);
  const right = evaluateNode(node.right, environment, session);
  switch (node.operator) {
    case "+": case "-": case "*": case "/": case "%": case "**":
      return evaluateArithmetic(node.operator, left, right);
    case "==": return strictEquals(left, right);
    case "!=": return !strictEquals(left, right);
    case "<": case "<=": case ">": case ">=":
      return evaluateOrder(node.operator, left, right);
  }
}

/** 严格类型算术:number 之间运算;`+` 额外允许 string+string 拼接(工业文案场景),其余隐式转换一律拒绝。 */
function evaluateArithmetic(operator: "+" | "-" | "*" | "/" | "%" | "**", left: unknown, right: unknown): number | string {
  if (operator === "+" && typeof left === "string" && typeof right === "string") return left + right;
  requireNumber(left, `运算符 “${operator}” 左侧`);
  requireNumber(right, `运算符 “${operator}” 右侧`);
  switch (operator) {
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/": return left / right;
    case "%": return left % right;
    case "**": return left ** right;
  }
}

/** 排序比较:number-number 或 string-string;跨类型比较拒绝(JS 的 < 会做隐式转换,不确定性语义面)。 */
function evaluateOrder(operator: "<" | "<=" | ">" | ">=", left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    switch (operator) {
      case "<": return left < right;
      case "<=": return left <= right;
      case ">": return left > right;
      case ">=": return left >= right;
    }
  }
  if (typeof left === "string" && typeof right === "string") {
    switch (operator) {
      case "<": return left < right;
      case "<=": return left <= right;
      case ">": return left > right;
      case ">=": return left >= right;
    }
  }
  throw new RestrictedExpressionEvalError(
    `运算符 “${operator}” 要求两侧同为 number 或同为 string,得到 ${describe(left)} 与 ${describe(right)}`,
  );
}

/** 严格相等:Object.is 语义(NaN 只等于 NaN,-0 与 0 不等),规避 JS == 的隐式转换歧义。 */
function strictEquals(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function requireNumber(value: unknown, context: string): asserts value is number {
  if (typeof value !== "number") {
    throw new RestrictedExpressionEvalError(`${context}要求 number,得到 ${describe(value)}`);
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
