/**
 * N1 fixture 摘要:与 Native `shader_package/hash.rs::hash_canonical` 同一机制
 * (canonical JSON + SHA-256,跨语言可复算)。
 *
 * canonical 形状:对象键按 UTF-8 字节序排序(= 码点序)、紧凑分隔、字符串按
 * JSON 转义、数字按 serde_json 语义——整数 token 保持整数(精确十进制),
 * 浮点 token 走 ryu-pretty 最短表示(纯小数窗口 `kk ∈ (-5, 16]`,指数写法
 * 无 `+`、不补零)。因此解析必须保留「整数 vs 浮点」的词法区分:
 * `1` 规范化为 `1`,而 `1.0` 规范化为 `1.0`,二者摘要不同。
 */

import { sha256Utf8 } from "../shaderPackage/hash.js";
import { N1Rejection } from "./validation.js";

export type JsonNode =
  | { readonly kind: "null" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly JsonNode[] }
  | { readonly kind: "object"; readonly entries: ReadonlyMap<string, JsonNode> };

const MAX_DEPTH = 128;
const INT_RANGE_HIGH = 1n << 64n;
const INT_RANGE_LOW = -(1n << 63n);
const NUMBER_TOKEN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** 解析 fixture 字节为保留数字词法形态的 JSON 树;任何非法输入都以显式原因拒绝。 */
export function parseJsonBytes(bytes: Uint8Array): JsonNode {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new N1Rejection("fixture is not valid UTF-8");
  }
  const scanner = new JsonScanner(text);
  const value = scanner.parseValue(0);
  scanner.expectEnd();
  return value;
}

/** 复算 fixture 的 canonical SHA-256(与认证台账同一机制);非法 JSON 返回 undefined。 */
export function fixtureDigest(bytes: Uint8Array): string | undefined {
  try {
    return sha256Utf8(canonicalJsonText(parseJsonBytes(bytes)));
  } catch {
    return undefined;
  }
}

export function canonicalJsonText(node: JsonNode): string {
  switch (node.kind) {
    case "null":
      return "null";
    case "bool":
      return node.value ? "true" : "false";
    case "int":
      return node.value.toString();
    case "float":
      return formatRyuFloat(node.value);
    case "string":
      return JSON.stringify(node.value);
    case "array":
      return `[${node.items.map(canonicalJsonText).join(",")}]`;
    case "object": {
      const keys = [...node.entries.keys()].sort(compareCodePoints);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonText(node.entries.get(key)!)}`).join(",")}}`;
    }
  }
}

/** UTF-8 字节序 == 码点序;Rust `String` 排序按字节,这里用码点比较复现。 */
function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** ryu-pretty 最短浮点表示(serde_json float 序列化的精确复刻)。 */
function formatRyuFloat(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  if (value === 0) return "0.0";
  const sign = value < 0 ? "-" : "";
  const [, mantissaText = "", exponentText = ""] = /^(.*)e([+-]\d+)$/.exec(Math.abs(value).toString()) ?? [value, Math.abs(value).toString(), ""];
  const [intPart = "0", fractionPart = ""] = mantissaText.split(".");
  let digits = intPart + fractionPart;
  let exponent = (exponentText === "" ? 0 : Number(exponentText)) - fractionPart.length;
  while (digits.length > 1 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent += 1;
  }
  while (digits.length > 1 && digits.startsWith("0")) digits = digits.slice(1);
  const decimalPoint = digits.length + exponent;
  if (exponent >= 0 && decimalPoint <= 16) return `${sign}${digits}${"0".repeat(decimalPoint - digits.length)}.0`;
  if (decimalPoint > 0 && decimalPoint <= 16) return `${sign}${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
  if (decimalPoint > -5 && decimalPoint <= 0) return `${sign}0.${"0".repeat(-decimalPoint)}${digits}`;
  if (digits.length === 1) return `${sign}${digits}e${decimalPoint - 1}`;
  return `${sign}${digits[0]}.${digits.slice(1)}e${decimalPoint - 1}`;
}

class JsonScanner {
  #position = 0;
  constructor(private readonly text: string) {}

  expectEnd(): void {
    this.#skipWhitespace();
    if (this.#position !== this.text.length) throw new N1Rejection(`trailing characters at offset ${this.#position}`);
  }

  parseValue(depth: number): JsonNode {
    if (depth >= MAX_DEPTH) throw new N1Rejection("recursion limit exceeded");
    this.#skipWhitespace();
    const ch = this.text[this.#position];
    switch (ch) {
      case "{":
        return this.#parseObject(depth);
      case "[":
        return this.#parseArray(depth);
      case '"':
        return { kind: "string", value: this.#parseString() };
      case "t":
        return this.#expectLiteral("true", { kind: "bool", value: true });
      case "f":
        return this.#expectLiteral("false", { kind: "bool", value: false });
      case "n":
        return this.#expectLiteral("null", { kind: "null" });
      case undefined:
        throw new N1Rejection("unexpected end of input");
      default:
        return this.#parseNumberOrError(ch);
    }
  }

  #skipWhitespace(): void {
    while (this.#position < this.text.length) {
      const ch = this.text[this.#position]!;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") this.#position += 1;
      else break;
    }
  }

  #expectLiteral(literal: string, node: JsonNode): JsonNode {
    if (this.text.startsWith(literal, this.#position)) {
      this.#position += literal.length;
      return node;
    }
    throw new N1Rejection(`expected value at offset ${this.#position}`);
  }

  #parseObject(depth: number): JsonNode {
    const entries = new Map<string, JsonNode>();
    this.#position += 1;
    this.#skipWhitespace();
    if (this.text[this.#position] === "}") {
      this.#position += 1;
      return { kind: "object", entries };
    }
    for (;;) {
      this.#skipWhitespace();
      if (this.text[this.#position] !== '"') throw new N1Rejection(`key must be a string at offset ${this.#position}`);
      const key = this.#parseString();
      this.#skipWhitespace();
      if (this.text[this.#position] !== ":") throw new N1Rejection(`expected ':' at offset ${this.#position}`);
      this.#position += 1;
      entries.set(key, this.parseValue(depth + 1));
      this.#skipWhitespace();
      const ch = this.text[this.#position];
      if (ch === ",") {
        this.#position += 1;
        continue;
      }
      if (ch === "}") {
        this.#position += 1;
        return { kind: "object", entries };
      }
      throw new N1Rejection(`expected ',' or '}' at offset ${this.#position}`);
    }
  }

  #parseArray(depth: number): JsonNode {
    const items: JsonNode[] = [];
    this.#position += 1;
    this.#skipWhitespace();
    if (this.text[this.#position] === "]") {
      this.#position += 1;
      return { kind: "array", items };
    }
    for (;;) {
      items.push(this.parseValue(depth + 1));
      this.#skipWhitespace();
      const ch = this.text[this.#position];
      if (ch === ",") {
        this.#position += 1;
        continue;
      }
      if (ch === "]") {
        this.#position += 1;
        return { kind: "array", items };
      }
      throw new N1Rejection(`expected ',' or ']' at offset ${this.#position}`);
    }
  }

  #parseString(): string {
    this.#position += 1;
    let result = "";
    for (;;) {
      const ch = this.text[this.#position];
      if (ch === undefined) throw new N1Rejection("unexpected end of input in string");
      if (ch === '"') {
        this.#position += 1;
        return result;
      }
      if (ch < " ") throw new N1Rejection("control character in string");
      if (ch !== "\\") {
        result += ch;
        this.#position += 1;
        continue;
      }
      const escape = this.text[this.#position + 1];
      this.#position += 2;
      if (escape === 'u') {
        result += String.fromCodePoint(this.#parseHex4());
        continue;
      }
      const mapped = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[escape ?? ""];
      if (mapped === undefined) throw new N1Rejection("invalid escape sequence in string");
      result += mapped;
    }
  }

  #parseHex4(): number {
    const hex = this.text.slice(this.#position, this.#position + 4);
    const value = /^[0-9a-fA-F]{4}$/.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
    if (Number.isNaN(value)) throw new N1Rejection("invalid \\u escape in string");
    this.#position += 4;
    if (value >= 0xd800 && value <= 0xdbff) {
      if (this.text[this.#position] !== "\\" || this.text[this.#position + 1] !== "u") {
        throw new N1Rejection("lone leading surrogate in hex escape");
      }
      const lowHex = this.text.slice(this.#position + 2, this.#position + 6);
      const low = /^[0-9a-fA-F]{4}$/.test(lowHex) ? Number.parseInt(lowHex, 16) : Number.NaN;
      if (Number.isNaN(low) || low < 0xdc00 || low > 0xdfff) throw new N1Rejection("lone leading surrogate in hex escape");
      this.#position += 6;
      return 0x10000 + ((value - 0xd800) << 10) + (low - 0xdc00);
    }
    if (value >= 0xdc00 && value <= 0xdfff) throw new N1Rejection("lone trailing surrogate in hex escape");
    return value;
  }

  #parseNumberOrError(ch: string): JsonNode {
    if (!(ch === "-" || (ch >= "0" && ch <= "9"))) throw new N1Rejection(`expected value at offset ${this.#position}`);
    NUMBER_TOKEN.lastIndex = this.#position;
    const match = NUMBER_TOKEN.exec(this.text);
    if (match === null) throw new N1Rejection(`invalid number at offset ${this.#position}`);
    const token = match[0];
    this.#position += token.length;
    const next = this.text[this.#position];
    if (next !== undefined && /[0-9.eE]/.test(next)) throw new N1Rejection(`invalid number at offset ${this.#position}`);
    if (token.includes(".") || token.includes("e") || token.includes("E")) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new N1Rejection(`number out of range at offset ${this.#position}`);
      return { kind: "float", value };
    }
    const exact = BigInt(token);
    if (exact >= INT_RANGE_LOW && exact <= INT_RANGE_HIGH - 1n) return { kind: "int", value: exact };
    const fallback = Number(token);
    if (!Number.isFinite(fallback)) throw new N1Rejection(`number out of range at offset ${this.#position}`);
    return { kind: "float", value: fallback };
  }
}
