import { describe, expect, it } from "vitest";
import {
  compileExpression,
  evaluateCompiledExpression,
  evaluateCompiledExpressionDetailed,
  RESTRICTED_EVALUATOR_LIMITS,
  RestrictedExpressionBudgetError,
  RestrictedExpressionEvalError,
  RestrictedExpressionSyntaxError,
} from "./restrictedEvaluator";

const evaluate = (source: string, environment: Record<string, unknown> = {}, budget?: number): unknown =>
  evaluateCompiledExpression(compileExpression(source).ast, environment, budget);

describe("restrictedEvaluator 合法表达式", () => {
  it("字面量与算术优先级", () => {
    expect(evaluate("1 + 2 * 3")).toBe(7);
    expect(evaluate("(1 + 2) * 3")).toBe(9);
    expect(evaluate("10 % 3")).toBe(1);
    expect(evaluate("2 ** 3 ** 2")).toBe(512); // ** 右结合
    expect(evaluate("-3 + 1")).toBe(-2);
    expect(evaluate("0.1 + 0.2")).toBe(0.30000000000000004); // IEEE754 double,跨平台一致
  });

  it("字符串拼接仅限 string+string", () => {
    expect(evaluate(`"温度:" + "高"`)).toBe("温度:高");
    expect(() => evaluate(`"温度:" + 1`)).toThrow(RestrictedExpressionEvalError);
  });

  it("严格相等(Object.is 语义)与排序比较", () => {
    expect(evaluate("1 == 1.0")).toBe(true);
    expect(evaluate(`1 == "1"`)).toBe(false); // 跨类型严格不等,不隐式转换
    expect(evaluate(`1 != "1"`)).toBe(true);
    expect(evaluate("2 >= 2")).toBe(true);
    expect(evaluate(`"b" > "a"`)).toBe(true);
    expect(() => evaluate(`1 < "2"`)).toThrow(RestrictedExpressionEvalError);
  });

  it("NaN 只等于 NaN(-0 与 0 不等)", () => {
    expect(evaluate("(0 / 0) == (0 / 0)")).toBe(true);
    expect(evaluate("(-0) == 0")).toBe(false);
  });

  it("除零产生 Infinity(JS double 语义,确定)", () => {
    expect(evaluate("1 / 0")).toBe(Number.POSITIVE_INFINITY);
  });

  it("逻辑短路与三元", () => {
    expect(evaluate("false && (1 / 0 > 0)")).toBe(false);
    expect(evaluate("true || (1 / 0 > 0)")).toBe(true);
    expect(evaluate("1 > 0 ? 2 : 3")).toBe(2);
    expect(evaluate("1 < 0 ? 2 : 3")).toBe(3);
  });

  it("一元取负与逻辑非要求类型", () => {
    expect(evaluate("!0")).toBe(true);
    expect(evaluate('!""')).toBe(true); // JS 语义:空串为假值,取非为真
    expect(evaluate("!(1 - 1)")).toBe(true);
    expect(() => evaluate('-"a"')).toThrow(RestrictedExpressionEvalError);
  });

  it("标识符路径与命名空间环境", () => {
    const environment = { values: { temperature: 82 }, event: { payload: 3 }, inputs: { rated: 80 } };
    expect(evaluate("values.temperature", environment)).toBe(82);
    expect(evaluate("values.temperature > inputs.rated", environment)).toBe(true);
    expect(evaluate("event.payload * 2", environment)).toBe(6);
  });

  it("true/false/null 关键字", () => {
    expect(evaluate("true")).toBe(true);
    expect(evaluate("null == null")).toBe(true);
    expect(evaluate("null == 0")).toBe(false);
  });
});

describe("restrictedEvaluator 非法表达式(语法层拒绝)", () => {
  const expectSyntax = (source: string, message: RegExp): void => {
    expect(() => compileExpression(source)).toThrow(RestrictedExpressionSyntaxError);
    expect(() => compileExpression(source)).toThrow(message);
  };

  it("函数调用被拒绝(无动态代码生成的语法面)", () => {
    expectSyntax("eval('1')", /不允许函数调用/);
    expectSyntax("fetch()", /不允许函数调用/);
  });

  it("赋值/位运算/模板串/计算成员/保留字全部拒绝", () => {
    expectSyntax("a = 1", /不支持/);
    expectSyntax("a ^ b", /不支持/);
    expectSyntax("`a${1}`", /不支持/);
    expectSyntax("a[0]", /不支持/);
    expectSyntax("true.x", /尾随 token/); // 关键字先成字面量,悬空 "." 被尾随 token 拒绝(fail-closed)
  });

  it("字符串未闭合与空表达式", () => {
    expectSyntax('"未闭合', /未闭合/);
    expectSyntax("   ", /表达式为空/);
  });

  it("超长/超 token/超深嵌套", () => {
    expectSyntax("1".repeat(RESTRICTED_EVALUATOR_LIMITS.maxSourceLength + 1), /超过最大长度/);
    // 799 字符 ≤1024、799 token >512:触发 token 上限而非长度上限。
    const wide = Array.from({ length: 400 }, () => "1").join("+");
    expectSyntax(wide, /超过最大 token 数/);
    let deep = "1";
    for (let index = 0; index < RESTRICTED_EVALUATOR_LIMITS.maxAstDepth + 4; index += 1) deep = `(${deep})`;
    expectSyntax(deep, /超过最大深度/);
  });

  it("路径段数超限与非法数字", () => {
    expectSyntax("a.b.c.d.e", /超过最大段数/);
    expectSyntax("1e", /非法数字字面量/);
    expectSyntax("0x10", /尾随 token/); // "0" 成词后 "x10" 为悬空标识符
  });

  it("尾随 token 与括号不匹配", () => {
    expectSyntax("1 2", /尾随 token/);
    expectSyntax("(1", /期望 “\)”/);
    expectSyntax("1)", /尾随 token/);
    expectSyntax("typeof 1", /尾随 token/);
    expectSyntax("new Object()", /尾随 token/); // "new" 成标识符后 "Object" 悬空,仍被 fail-closed 拒绝
  });
});

describe("restrictedEvaluator 求值语义错误", () => {
  it("未知标识符报错(引用必须显式存在)", () => {
    expect(() => evaluate("values.missing", { values: {} })).toThrow(/未知标识符/);
    expect(() => evaluate("missing", {})).toThrow(/未知标识符/);
  });

  it("路径在标量处不可继续取值", () => {
    expect(() => evaluate("values.temperature.x", { values: { temperature: 5 } })).toThrow(/不可继续取值/);
  });
});

describe("restrictedEvaluator 步数预算", () => {
  it("超步抛预算错误并终止", () => {
    // AST 共 9 个节点(5 字面量 + 4 二元):预算 9 恰好够,预算 8 抛错。
    const ast = compileExpression("1 + 1 + 1 + 1 + 1").ast;
    expect(() => evaluateCompiledExpression(ast, {}, 8)).toThrow(RestrictedExpressionBudgetError);
    expect(evaluateCompiledExpression(ast, {}, 9)).toBe(5);
    expect(evaluateCompiledExpressionDetailed(ast, {}, 9).steps).toBe(9);
  });

  it("预算下限夹取为 1,上限夹取为硬上限", () => {
    const ast = compileExpression("1").ast;
    expect(evaluateCompiledExpression(ast, {}, 0)).toBe(1);
    expect(evaluateCompiledExpressionDetailed(ast, {}, Number.MAX_SAFE_INTEGER).steps).toBe(1);
  });

  it("预算耗尽不外泄部分结果(异常中断)", () => {
    const ast = compileExpression("values.a + values.b + values.c").ast;
    const environment = { values: { a: 1, b: 2, c: 3 } };
    expect(() => evaluateCompiledExpression(ast, environment, 2)).toThrow(RestrictedExpressionBudgetError);
  });
});

describe("restrictedEvaluator 确定性", () => {
  const source = "values.temperature > inputs.rated ? values.temperature - inputs.rated : 0";
  const environment = { values: { temperature: 82.5 }, inputs: { rated: 80 } };

  it("同输入求值 64 次值与步数逐字段全等", () => {
    const ast = compileExpression(source).ast;
    const baseline = evaluateCompiledExpressionDetailed(ast, environment);
    for (let index = 0; index < 64; index += 1) {
      const repeat = evaluateCompiledExpressionDetailed(ast, environment);
      expect(repeat.value).toBe(baseline.value);
      expect(repeat.steps).toBe(baseline.steps);
    }
    expect(baseline.value).toBe(2.5);
  });

  it("编译是纯函数:同源两次编译 AST 结构全等", () => {
    expect(compileExpression(source)).toStrictEqual(compileExpression(source));
  });

  it("求值不污染环境(只读)", () => {
    const snapshot = structuredClone(environment);
    evaluateCompiledExpression(compileExpression(source).ast, environment);
    expect(environment).toStrictEqual(snapshot);
  });
});
