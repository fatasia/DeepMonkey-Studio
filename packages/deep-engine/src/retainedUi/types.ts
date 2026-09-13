export const RETAINED_UI_SCHEMA_VERSION = 1 as const;
export const RETAINED_UI_BUDGETS = Object.freeze({ nodes: 65536, children: 262144, treeDepth: 256, jsonDepth: 32, jsonValues: 1000000, stringCodeUnits: 1000000, diagnostics: 256, coordinate: 16777216 } as const);
export type RetainedUiNodeKind = "container" | "text" | "image" | "viewport" | "chart";
export type RetainedUiLayoutMode = "absolute" | "stack" | "flex-row" | "flex-column";
export type RetainedUiColor = readonly [number, number, number, number];
export interface RetainedUiStyle {
  readonly layout: RetainedUiLayoutMode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly padding: number;
  readonly gap: number;
  readonly grow: number;
  readonly align: "start" | "center" | "end" | "stretch";
  readonly clip: boolean;
  readonly visible: boolean;
  readonly opacity: number;
  readonly pointerEvents: "auto" | "none";
  readonly zIndex: number;
  readonly background: RetainedUiColor | null;
  readonly foreground: RetainedUiColor;
  readonly borderColor: RetainedUiColor | null;
  readonly borderWidth: number;
  readonly cornerRadius: number;
  readonly fontId: string | null;
  readonly fontSize: number;
}
export type RetainedUiContent = {
  readonly kind: "container";
} | {
  readonly kind: "text";
  readonly text: string;
} | {
  readonly kind: "image";
  readonly assetId: string;
} | {
  readonly kind: "viewport";
  readonly surfaceId: string;
} | {
  readonly kind: "chart";
  readonly chartSpecId: string;
};
export interface RetainedUiA11y {
  readonly role: "none" | "text" | "img" | "button" | "region" | "application";
  readonly label?: string;
  readonly value?: string;
}
export interface RetainedUiNode {
  readonly id: string;
  readonly revision: number;
  readonly parentId: string | null;
  readonly children: readonly string[];
  readonly style: RetainedUiStyle;
  readonly content: RetainedUiContent;
  readonly a11y: RetainedUiA11y;
}
export interface RetainedUiTree {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly rootId: string;
  readonly nodes: readonly RetainedUiNode[];
}
export type RetainedUiDiagnosticCode = "invalid-json" | "invalid-schema" | "invalid-value" | "unknown-field" | "budget-exceeded" | "duplicate-id" | "missing-reference" | "parent-child-mismatch" | "cycle" | "unreachable" | "stale-revision";
export interface RetainedUiDiagnostic {
  readonly code: RetainedUiDiagnosticCode;
  readonly path: string;
  readonly message: string;
}
export interface RetainedUiValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly RetainedUiDiagnostic[];
  readonly tree?: RetainedUiTree;
}
export interface RetainedUiRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface RetainedUiFrame extends RetainedUiRect {
  readonly id: string;
  readonly clip: RetainedUiRect | null;
  readonly order: number;
  readonly zIndex: number;
}
export interface RetainedUiLayout {
  readonly frames: readonly RetainedUiFrame[];
}
export interface RetainedUiFingerprint {
  readonly id: string;
  readonly revision: number;
  readonly layout: string;
  readonly paint: string;
  readonly hit: string;
  readonly a11y: string;
  readonly content: string;
}
export type RetainedUiOperation = {
  readonly kind: "insert";
  readonly id: string;
  readonly parentId: string | null;
  readonly index: number;
} | {
  readonly kind: "remove";
  readonly id: string;
} | {
  readonly kind: "reorder";
  readonly parentId: string;
  readonly children: readonly string[];
};
export interface RetainedUiIncrementalPlan {
  readonly operations: readonly RetainedUiOperation[];
  readonly dirtyLayoutRoots: readonly string[];
  readonly dirtyPaintRoots: readonly string[];
  readonly dirtyHitRoots: readonly string[];
  readonly dirtyA11yRoots: readonly string[];
  readonly fingerprints: readonly RetainedUiFingerprint[];
}
export interface RetainedUiPlanResult {
  readonly ok: boolean;
  readonly diagnostics: readonly RetainedUiDiagnostic[];
  readonly tree?: RetainedUiTree;
  readonly layout?: RetainedUiLayout;
  readonly plan?: RetainedUiIncrementalPlan;
}
