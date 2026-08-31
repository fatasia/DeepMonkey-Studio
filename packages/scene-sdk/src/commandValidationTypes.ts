import type { SceneCommand } from "./protocol.js";

export const SCENE_COMMAND_VALIDATION_LIMITS = {
  maxIdentifierLength: 1_024,
  maxDataStringLength: 65_536,
  maxJsonDepth: 32,
  maxJsonNodes: 10_000,
  maxArrayItems: 4_096,
  maxObjectProperties: 1_024
} as const;

export type SceneCommandValidationIssueCode =
  | "invalid-type"
  | "invalid-value"
  | "limit-exceeded"
  | "missing-property"
  | "unknown-property"
  | "unsafe-object";

export interface SceneCommandValidationIssue {
  path: string;
  code: SceneCommandValidationIssueCode;
  message: string;
}

export type SceneCommandValidationResult =
  | { valid: true; command: SceneCommand; issues: [] }
  | { valid: false; issues: SceneCommandValidationIssue[] };

export interface ValidationContext {
  issues: SceneCommandValidationIssue[];
  jsonNodes: number;
  jsonAncestors: WeakSet<object>;
}

export interface InspectedRecord {
  keys: string[];
  values: Map<string, unknown>;
}

export interface NumberBounds {
  atLeast?: number;
  greaterThan?: number;
  lessThan?: number;
}

export const UNSAFE_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

