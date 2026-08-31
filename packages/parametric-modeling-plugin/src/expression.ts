import type { ParametricCadValue } from "@bim-studio/contracts";

const EXPRESSION_PATTERN = /^[\d\sA-Za-z_+*/().-]+$/;
const MAX_EXPRESSION_LENGTH = 120;
const MAX_OPERATIONS = 128;

/** 只解析参数、数字和四则运算，不使用 eval，AI 草案也无法注入任意脚本。 */
export function evaluateParametricValue(value: ParametricCadValue | undefined, parameters: Readonly<Record<string, number>>, fallback = 0): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("参数值必须是有限数字");
    return value;
  }
  if (!value || value.length > MAX_EXPRESSION_LENGTH || !EXPRESSION_PATTERN.test(value)) {
    throw new Error(`参数表达式包含不允许的内容：${value}`);
  }
  return new ExpressionParser(value, parameters).parse();
}

class ExpressionParser {
  private index = 0;
  private operations = 0;

  constructor(private readonly source: string, private readonly values: Readonly<Record<string, number>>) {}

  parse(): number {
    const result = this.expression();
    this.skipSpaces();
    if (this.index !== this.source.length || !Number.isFinite(result)) throw new Error(`参数表达式无效：${this.source}`);
    return result;
  }

  private expression(): number {
    let value = this.term();
    while (true) {
      this.skipSpaces();
      if (this.take("+")) value += this.term();
      else if (this.take("-")) value -= this.term();
      else return value;
      this.countOperation();
    }
  }

  private term(): number {
    let value = this.factor();
    while (true) {
      this.skipSpaces();
      if (this.take("*")) value *= this.factor();
      else if (this.take("/")) {
        const divisor = this.factor();
        if (Math.abs(divisor) < 1e-12) throw new Error(`参数表达式除以零：${this.source}`);
        value /= divisor;
      } else return value;
      this.countOperation();
    }
  }

  private factor(): number {
    this.skipSpaces();
    if (this.take("+")) return this.factor();
    if (this.take("-")) return -this.factor();
    if (this.take("(")) {
      const value = this.expression();
      this.skipSpaces();
      if (!this.take(")")) throw new Error(`参数表达式缺少右括号：${this.source}`);
      return value;
    }
    const number = this.source.slice(this.index).match(/^\d+(?:\.\d+)?/)?.[0];
    if (number) {
      this.index += number.length;
      return Number(number);
    }
    const name = this.source.slice(this.index).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (!name) throw new Error(`参数表达式无法解析：${this.source}`);
    this.index += name.length;
    const result = this.values[name];
    if (result === undefined) throw new Error(`参数不存在：${name}`);
    return result;
  }

  private skipSpaces(): void {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private take(token: string): boolean {
    if (!this.source.startsWith(token, this.index)) return false;
    this.index += token.length;
    return true;
  }

  private countOperation(): void {
    this.operations += 1;
    if (this.operations > MAX_OPERATIONS) throw new Error("参数表达式过于复杂");
  }
}
