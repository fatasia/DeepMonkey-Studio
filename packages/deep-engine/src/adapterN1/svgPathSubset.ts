/**
 * SVG path 基本指令子集解析:封闭支持矩阵,fail-closed。
 * 与 Native `adapter_n1/svg_parse.rs` 同一矩阵、同一拒绝文案:仅 `M m L l H h V v Z z`,
 * 不支持隐式坐标组重复、不支持隐式小数切分;数值必须有限且 |v| ≤ MAX_DRAW_VALUE;
 * 子路径必须以 `M`/`m` 开头。输出为 Deep2d 路径动词(合同级解析,不做光栅化)。
 */

import type { Deep2dPathVerb } from "../deep2dDisplayList.js";
import { MAX_DRAW_VALUE, N1Rejection } from "./validation.js";

interface Token {
  readonly kind: "command" | "number";
  readonly command?: string;
  readonly number?: number;
  readonly text?: string;
}

/** 把 path data 解析为 Deep2d 路径动词;任何越界情况都以显式原因拒绝。 */
export function parseSvgPathSubset(data: string): Deep2dPathVerb[] {
  const tokens = tokenize(data);
  const verbs: Deep2dPathVerb[] = [];
  let currentX = 0;
  let currentY = 0;
  let subpathStartX = 0;
  let subpathStartY = 0;
  let hasMove = false;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind !== "command" || token.command === undefined) {
      throw new N1Rejection("path data must alternate command letters and coordinates");
    }
    const command = token.command;
    index += 1;
    if (!"MmLlHhVvZz".includes(command)) {
      throw new N1Rejection(`unsupported svg path command '${command}' (supported subset: M m L l H h V v Z z)`);
    }
    const relative = command >= "a" && command <= "z";
    const upper = command.toUpperCase();
    if (upper === "M" || upper === "L") {
      const x = number(tokens, index++, command);
      const y = number(tokens, index++, command);
      const pointX = relative ? currentX + x : x;
      const pointY = relative ? currentY + y : y;
      if (upper === "M") {
        verbs.push({ op: "move", x: pointX, y: pointY });
        subpathStartX = pointX;
        subpathStartY = pointY;
        hasMove = true;
      } else {
        requireMove(hasMove, command);
        verbs.push({ op: "line", x: pointX, y: pointY });
      }
      currentX = pointX;
      currentY = pointY;
    } else if (upper === "H") {
      const x = number(tokens, index++, command);
      requireMove(hasMove, command);
      currentX = relative ? currentX + x : x;
      verbs.push({ op: "line", x: currentX, y: currentY });
    } else if (upper === "V") {
      const y = number(tokens, index++, command);
      requireMove(hasMove, command);
      currentY = relative ? currentY + y : y;
      verbs.push({ op: "line", x: currentX, y: currentY });
    } else {
      requireMove(hasMove, command);
      verbs.push({ op: "close" });
      currentX = subpathStartX;
      currentY = subpathStartY;
    }
    if (tokens[index]?.kind === "number") {
      throw new N1Rejection(
        `implicit coordinate repetition after '${command}' is not supported (each command takes exactly one coordinate group)`,
      );
    }
  }
  if (verbs.length === 0) throw new N1Rejection("path data contains no drawing commands");
  return verbs;
}

function requireMove(hasMove: boolean, command: string): void {
  if (!hasMove) throw new N1Rejection(`subpath must start with 'M' or 'm' before '${command}'`);
}

function number(tokens: readonly Token[], index: number, command: string): number {
  const token = tokens[index];
  if (token === undefined || token.kind !== "number" || token.number === undefined) {
    throw new N1Rejection(`command '${command}' requires a numeric argument`);
  }
  return token.number;
}

function tokenize(data: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < data.length) {
    const ch = data[index]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === ",") {
      index += 1;
      continue;
    }
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) {
      tokens.push({ kind: "command", command: ch });
      index += 1;
      continue;
    }
    if (!((ch >= "0" && ch <= "9") || ch === "+" || ch === "-" || ch === ".")) {
      throw new N1Rejection(`unexpected character '${ch}' in path data`);
    }
    let text = "";
    while (index < data.length) {
      const digit = data[index]!;
      if ((digit >= "0" && digit <= "9") || digit === "+" || digit === "-" || digit === "." || digit === "e" || digit === "E") {
        text += digit;
        index += 1;
      } else {
        break;
      }
    }
    const value = Number(text);
    if (Number.isNaN(value)) throw new N1Rejection(`'${text}' is not a valid path number`);
    if (!Number.isFinite(value) || Math.abs(value) > MAX_DRAW_VALUE) {
      throw new N1Rejection(`path number '${text}' is not finite within ±${MAX_DRAW_VALUE}`);
    }
    tokens.push({ kind: "number", number: value, text });
  }
  return tokens;
}
