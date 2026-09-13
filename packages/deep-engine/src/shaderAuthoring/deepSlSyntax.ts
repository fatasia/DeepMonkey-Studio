import type { ShaderAuthoringDiagnostic, ShaderTextRange } from "./types.js";
import type { DeepSlParsedLine } from "./deepSlTypes.js";

export const DEEP_SL_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
export const DEEP_SL_UNIT_NUMBER = "(?:0|1|0?\\.\\d+|1\\.0+)";
export const DEEP_SL_FINITE_NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";

export function finiteFloat32Values(values: readonly number[]): boolean {
  return values.every((value) => Number.isFinite(value) && Number.isFinite(Math.fround(value)));
}

export function deepSlLineRange(line: DeepSlParsedLine): ShaderTextRange {
  return Object.freeze({
    start: Object.freeze({ line: line.line, column: line.firstColumn }),
    end: Object.freeze({ line: line.line, column: line.firstColumn + Math.max(1, line.text.length) }),
  });
}

export function deepSlIssue(
  line: DeepSlParsedLine,
  code: string,
  message: string,
  severity: "error" | "warning" = "error",
): ShaderAuthoringDiagnostic {
  return Object.freeze({ severity, source: "text-compiler", code, path: "$.source", message, range: deepSlLineRange(line) });
}

/** Splits source while preserving editor line/column positions after comments. */
export function lexDeepSlLines(source: string): DeepSlParsedLine[] {
  return source.split(/\r?\n/u).map((raw, index) => {
    const uncommented = raw.replace(/\/\/.*$/u, "").trimEnd();
    const first = uncommented.search(/\S/u);
    return Object.freeze({ line: index + 1, firstColumn: first < 0 ? 1 : first + 1,
      text: first < 0 ? "" : uncommented.slice(first) });
  });
}
