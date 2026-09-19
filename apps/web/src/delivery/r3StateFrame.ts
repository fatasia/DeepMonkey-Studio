import type { ClippingState } from "@bim-studio/contracts";

/**
 * R3 canonical state-frame contract (`r3-state-frame-v1`), byte-identical with the
 * Native consumer (`packages/deep-engine-native/src/runtime_package/r3_state.rs`).
 * It extends the dynamic-frame-v1 discipline from animated TRS sampling to the
 * discrete state machines: clipping (enable/move/disable/box) and selection, with
 * data-replay revisions surfaced per step from the frozen package.
 *
 * Float discipline (designed before code): every floating contract input is first
 * quantized onto the 1e-3 grid and bounded to |v| <= 1000. Native consumes these
 * values as f32 (ULP at 1000 is ~1.22e-4, well below the 5e-4 quantization
 * threshold), so an applied value round-trips f64 -> f32 -> quantize byte-exactly.
 * Anything outside the bound is rejected instead of silently diverging across ends.
 * `-0` normalizes to `0` exactly like dynamic-frame-v1, and all components print
 * with a fixed 6-decimal format.
 */

export const R3_STATE_OPS_SCHEMA = "deep-monkey.r3-state-ops";
export const R3_STATE_FRAME_CONTRACT = "r3-state-frame-v1";
export const R3_STATE_QUANTUM = 0.001;
export const R3_STATE_MAX_COORD = 1000;
const MAX_STEPS = 4096;

export type ClippingAxis = "x" | "y" | "z";

export type R3StateOp =
  | { readonly kind: "clip-enable"; readonly axis: ClippingAxis; readonly inverted: boolean; readonly offset: number }
  | { readonly kind: "clip-move"; readonly offset: number }
  | { readonly kind: "box-enable"; readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }
  | { readonly kind: "clip-disable" }
  | { readonly kind: "select"; readonly targetId: string }
  | { readonly kind: "clear-selection" };

export interface R3StateStep { readonly atMs: number; readonly op: R3StateOp }

export interface R3StateOps {
  readonly id: string;
  readonly packageHash: string;
  readonly steps: readonly R3StateStep[];
}

interface ClipAxisState { readonly kind: "axis"; readonly axis: ClippingAxis; readonly inverted: boolean; readonly offset: number }
interface ClipBoxState { readonly kind: "box"; readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }
type ClipState = { readonly kind: "off" } | ClipAxisState | ClipBoxState;

function fail(message: string): never { throw new Error(`r3-state ops: ${message}`); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Quantize onto the contract grid; the caller has already validated the bound. */
function quantize(value: number): number { return Math.round(value / R3_STATE_QUANTUM) * R3_STATE_QUANTUM; }

function onQuantumGrid(value: number): boolean {
  return Math.abs(value / R3_STATE_QUANTUM - Math.round(value / R3_STATE_QUANTUM)) <= 1e-6;
}

function coordinate(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${where} must be a finite number`);
  if (Math.abs(value) > R3_STATE_MAX_COORD) fail(`${where} exceeds the ±${R3_STATE_MAX_COORD} contract bound`);
  if (!onQuantumGrid(value)) fail(`${where} must sit on the ${R3_STATE_QUANTUM} grid`);
  return quantize(value);
}

const AXIS_NAMES: readonly ClippingAxis[] = ["x", "y", "z"];
const TARGET_ID_PATTERN = /^[a-z0-9._:/][a-z0-9._:/-]{0,255}$/;

/** One shared op-shape validation for every kind; unknown fields are rejected so
 * both ends agree on exactly the same envelope. */
function parseOp(raw: unknown): R3StateOp {
  if (!isRecord(raw)) fail("op must be an object");
  const known = new Set(["kind", "axis", "inverted", "offset", "targetId", "box"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) fail(`op has unknown field "${key}"`);
  const has = (key: string) => raw[key] !== undefined;
  switch (raw.kind) {
    case "clip-enable": {
      if (!AXIS_NAMES.includes(raw.axis as ClippingAxis)) fail("clip-enable requires axis x|y|z");
      if (typeof raw.inverted !== "boolean") fail("clip-enable requires an explicit boolean inverted");
      if (!has("offset")) fail("clip-enable requires offset");
      return { kind: "clip-enable", axis: raw.axis as ClippingAxis, inverted: raw.inverted, offset: coordinate(raw.offset, "clip-enable offset") };
    }
    case "clip-move": {
      if (!has("offset")) fail("clip-move requires offset");
      return { kind: "clip-move", offset: coordinate(raw.offset, "clip-move offset") };
    }
    case "box-enable": {
      if (!isRecord(raw.box)) fail("box-enable requires box {min,max}");
      for (const key of Object.keys(raw.box)) if (key !== "min" && key !== "max") fail(`box-enable has unknown box field "${key}"`);
      if (!Array.isArray(raw.box.min) || raw.box.min.length !== 3 || !Array.isArray(raw.box.max) || raw.box.max.length !== 3) {
        fail("box-enable min/max must be 3-component arrays");
      }
      const min = raw.box.min.map((value, index) => coordinate(value, `box min[${index}]`)) as [number, number, number];
      const max = raw.box.max.map((value, index) => coordinate(value, `box max[${index}]`)) as [number, number, number];
      if (min.some((value, index) => value > max[index]!)) fail("box-enable min must not exceed max component-wise");
      return { kind: "box-enable", min, max };
    }
    case "clip-disable":
      return { kind: "clip-disable" };
    case "select": {
      if (typeof raw.targetId !== "string" || !TARGET_ID_PATTERN.test(raw.targetId)) {
        fail(`select requires a targetId matching ${TARGET_ID_PATTERN.source}`);
      }
      return { kind: "select", targetId: raw.targetId };
    }
    case "clear-selection":
      return { kind: "clear-selection" };
    default:
      fail(`unknown op kind ${String(raw.kind)}`);
  }
}

export function parseR3StateOps(json: unknown): R3StateOps {
  if (!isRecord(json)) fail("payload must be an object");
  for (const key of Object.keys(json)) {
    if (!["schema", "schemaVersion", "id", "packageHash", "steps"].includes(key)) fail(`unknown field "${key}"`);
  }
  if (json.schema !== R3_STATE_OPS_SCHEMA || json.schemaVersion !== 1) fail("unsupported schema or schemaVersion");
  if (typeof json.id !== "string" || !json.id) fail("id must be a non-empty string");
  if (typeof json.packageHash !== "string" || !/^[0-9a-f]{64}$/.test(json.packageHash)) fail("packageHash must be a lowercase sha-256 hex string");
  if (!Array.isArray(json.steps) || json.steps.length === 0 || json.steps.length > MAX_STEPS) fail(`steps must hold 1..${MAX_STEPS} entries`);
  let previousAtMs = -1;
  const steps = json.steps.map((raw, index) => {
    if (!isRecord(raw)) fail(`step ${index} must be an object`);
    for (const key of Object.keys(raw)) if (key !== "atMs" && key !== "op") fail(`step ${index} has unknown field "${key}"`);
    const atMs = raw.atMs;
    if (typeof atMs !== "number" || !Number.isInteger(atMs) || atMs < 0 || atMs > 86_400_000) fail(`step ${index} atMs must be an integer in [0, 86400000]`);
    if (atMs < previousAtMs) fail(`step ${index} atMs must not move backwards`);
    previousAtMs = atMs;
    return { atMs, op: parseOp(raw.op) };
  });
  return { id: json.id, packageHash: json.packageHash, steps };
}

function formatComponent(value: number): string {
  return (value === 0 ? 0 : value).toFixed(6);
}

/** Canonical clip field: the same bytes the Native consumer produces from its
 * f32-applied state (or `null` for a mode it cannot consume). */
export function clipField(clip: ClipState): string {
  if (clip.kind === "off") return "off";
  if (clip.kind === "axis") {
    return `axis:${clip.axis},dir=${clip.inverted ? -1 : 1},off=${formatComponent(clip.offset)}`;
  }
  return `box:min=${clip.min.map(formatComponent).join(",")},max=${clip.max.map(formatComponent).join(",")}`;
}

/** Normalizes an engine-readback clipping state into the contract clip field.
 * Face mode has no contract representation (no Native consumer), so it fails
 * loudly instead of being silently folded into a look-alike axis frame. */
export function clipFieldFromClippingState(clipping: ClippingState | undefined): string {
  if (!clipping?.enabled) return "off";
  if ((clipping.mode ?? "axis") === "axis") {
    const state: ClipAxisState = {
      kind: "axis", axis: clipping.axis, inverted: clipping.inverted,
      offset: coordinate(clipping.offset, "readback offset"),
    };
    return clipField(state);
  }
  if (clipping.mode === "box") {
    if (!clipping.box) fail("box readback is missing box bounds");
    const min = clipping.box.min, max = clipping.box.max;
    const state: ClipBoxState = {
      kind: "box",
      min: [coordinate(min.x, "readback box min.x"), coordinate(min.y, "readback box min.y"), coordinate(min.z, "readback box min.z")],
      max: [coordinate(max.x, "readback box max.x"), coordinate(max.y, "readback box max.y"), coordinate(max.z, "readback box max.z")],
    };
    return clipField(state);
  }
  fail("face clipping has no r3-state contract representation");
}

export function selectionField(selection: string | null | undefined): string {
  return selection ? selection : "-";
}

/** Builds the engine-ready ClippingState for a contract clip so the harness
 * applies exactly the contracted state through the real setClipping path. */
export function clippingStateForContract(clip: ClipState): ClippingState {
  if (clip.kind === "off") return { enabled: false, mode: "axis", axis: "x", offset: 0, inverted: false };
  if (clip.kind === "axis") {
    return { enabled: true, mode: "axis", axis: clip.axis, offset: clip.offset, inverted: clip.inverted };
  }
  return {
    enabled: true, mode: "box", axis: "x", offset: 0, inverted: false,
    box: { min: { x: clip.min[0], y: clip.min[1], z: clip.min[2] }, max: { x: clip.max[0], y: clip.max[1], z: clip.max[2] } },
  };
}

/** Folds the frozen op sequence up to `stepIndex` and emits the canonical frame.
 * `replayRevisions` are sampled by each end from its own package parser, so the
 * events field also proves both ends read the same frozen dataReplay channel. */
export function canonicalR3StateFrame(
  ops: R3StateOps,
  stepIndex: number,
  replayRevisions: readonly number[],
): { readonly atMs: number; readonly canonical: string; readonly clip: ClipState; readonly selection: string | null } {
  if (stepIndex < 0 || stepIndex >= ops.steps.length) fail(`step index ${stepIndex} is outside the frozen sequence`);
  let clip: ClipState = { kind: "off" };
  let selection: string | null = null;
  for (let index = 0; index <= stepIndex; index += 1) {
    const { op } = ops.steps[index]!;
    switch (op.kind) {
      case "clip-enable":
        clip = { kind: "axis", axis: op.axis, inverted: op.inverted, offset: op.offset };
        break;
      case "clip-move":
        if (clip.kind !== "axis") fail(`clip-move at step ${index} requires an enabled axis clip`);
        clip = { kind: "axis", axis: clip.axis, inverted: clip.inverted, offset: op.offset };
        break;
      case "box-enable":
        clip = { kind: "box", min: op.min, max: op.max };
        break;
      case "clip-disable":
        clip = { kind: "off" };
        break;
      case "select":
        selection = op.targetId;
        break;
      case "clear-selection":
        selection = null;
        break;
    }
  }
  const step = ops.steps[stepIndex]!;
  const canonical = `${R3_STATE_FRAME_CONTRACT}|i=${stepIndex}|t=${step.atMs}|clip=${clipField(clip)}|sel=${selectionField(selection)}|events=${replayRevisions.join(",")}`;
  return { atMs: step.atMs, canonical, clip, selection };
}
