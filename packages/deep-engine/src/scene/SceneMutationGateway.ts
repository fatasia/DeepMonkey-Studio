import { applySceneChangeset, createSceneChangeset, type SceneChangeset, type SceneChangesetOutcome,
  type SceneChangesetCommand } from "./SceneChangeset.js";
import type { SceneTransformGraph } from "./SceneTransformGraph.js";
import type { SceneLocalTrs, SceneQuaternion, SceneTransformNodeId } from "./types.js";

/** Parser boundary for hosts such as `@bim-studio/scene-sdk`; Deep Engine never imports a UI framework or Scene SDK. */
export interface SceneMutationCommandParser {
  parse(input: unknown): unknown;
}

export interface SceneMutationGatewayOptions {
  readonly sceneId: string;
  readonly parser: SceneMutationCommandParser;
}

export type SceneMutationIssueReason =
  | "empty-batch"
  | "parse-error"
  | "malformed-command"
  | "unsupported-command"
  | "scene-mismatch"
  | "unsupported-target"
  | "missing-node"
  | "conflicting-target"
  | "unsupported-transform";

export interface SceneMutationIssue {
  readonly index: number;
  readonly commandId?: string;
  readonly reason: SceneMutationIssueReason;
  readonly message: string;
}

export type SceneMutationPreparation =
  | { readonly status: "prepared"; readonly changeset: SceneChangeset; readonly sourceCommandCount: number; readonly skippedCommandCount: number }
  | { readonly status: "noop"; readonly baseRevision: number; readonly sourceCommandCount: number }
  | { readonly status: "rejected"; readonly issues: readonly SceneMutationIssue[] };

export type SceneMutationExecution =
  | Extract<SceneMutationPreparation, { status: "noop" | "rejected" }>
  | SceneChangesetOutcome;

type Vec3 = readonly [number, number, number];
type ObjectTarget = { readonly kind: string; readonly sceneId: string; readonly objectId?: string };
type VisibilityCommand = { readonly id: string; readonly type: "object.set-visibility"; readonly target: ObjectTarget; readonly visible: boolean };
type TransformCommand = { readonly id: string; readonly type: "object.set-transform"; readonly target: ObjectTarget;
  readonly position?: Vec3; readonly rotation?: Vec3; readonly scale?: Vec3 };
type SupportedCommand = VisibilityCommand | TransformCommand;

interface PendingMutation {
  readonly nodeId: string;
  readonly expectedRevision: number;
  readonly initial?: SceneLocalTrs;
  kind: "hidden" | "transform";
  hidden?: boolean;
  transform?: SceneLocalTrs;
}

/**
 * Compiles the stable Scene API subset into the authoritative SceneChangeset channel.
 * Preparation is side-effect free; commit performs the existing graph CAS and atomic transaction.
 */
export class SceneMutationGateway {
  private readonly sceneId: string;
  private readonly parser: SceneMutationCommandParser;

  constructor(private readonly graph: SceneTransformGraph<SceneTransformNodeId>, options: SceneMutationGatewayOptions) {
    if (!options || typeof options !== "object" || !options.sceneId?.trim()) throw new TypeError("Scene mutation gateway requires a sceneId.");
    if (!options.parser || typeof options.parser.parse !== "function") throw new TypeError("Scene mutation gateway requires a command parser.");
    this.sceneId = options.sceneId;
    this.parser = options.parser;
  }

  prepare(changesetId: string, inputs: readonly unknown[]): SceneMutationPreparation {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return { status: "rejected", issues: [issue(-1, "empty-batch", "Scene mutation batch must contain at least one command.")] };
    }
    const issues: SceneMutationIssue[] = [];
    const pending = new Map<string, PendingMutation>();

    for (const [index, input] of inputs.entries()) {
      const parsed = this.parse(input, index, issues);
      if (!parsed) continue;
      const target = parsed.target;
      if (target.sceneId !== this.sceneId) {
        issues.push(issue(index, "scene-mismatch", `Command targets scene ${target.sceneId}; active scene is ${this.sceneId}.`, parsed.id));
        continue;
      }
      if (target.kind !== "object" || !target.objectId) {
        issues.push(issue(index, "unsupported-target", "Only object targets map to authoritative scene nodes.", parsed.id));
        continue;
      }
      const snapshot = this.graph.getNode(target.objectId as SceneTransformNodeId);
      if (!snapshot) {
        issues.push(issue(index, "missing-node", `Scene node ${target.objectId} does not exist.`, parsed.id));
        continue;
      }
      const kind = parsed.type === "object.set-visibility" ? "hidden" : "transform";
      const existing = pending.get(target.objectId);
      if (existing && existing.kind !== kind) {
        issues.push(issue(index, "conflicting-target",
          `Node ${target.objectId} cannot carry transform and visibility in one v1 changeset.`, parsed.id));
        continue;
      }
      if (parsed.type === "object.set-visibility") {
        const mutation = existing ?? { nodeId: target.objectId, expectedRevision: snapshot.lastChangedRevision, kind };
        mutation.hidden = !parsed.visible;
        pending.set(target.objectId, mutation);
        continue;
      }
      if (!parsed.position && !parsed.rotation && !parsed.scale) {
        continue;
      }
      if (snapshot.localTransform.kind !== "trs") {
        issues.push(issue(index, "unsupported-transform", `Node ${target.objectId} uses a matrix transform; partial TRS editing is undefined.`, parsed.id));
        continue;
      }
      const mutation = existing ?? { nodeId: target.objectId, expectedRevision: snapshot.lastChangedRevision,
        initial: snapshot.localTransform, kind };
      const previous = mutation.transform ?? mutation.initial!;
      mutation.transform = {
        kind: "trs",
        translation: parsed.position ?? previous.translation,
        rotation: parsed.rotation ? eulerXyzQuaternion(parsed.rotation) : previous.rotation,
        scale: parsed.scale ?? previous.scale,
      };
      pending.set(target.objectId, mutation);
    }
    if (issues.length) return { status: "rejected", issues };

    const commands: SceneChangesetCommand[] = [];
    for (const mutation of pending.values()) {
      const snapshot = this.graph.getNode(mutation.nodeId as SceneTransformNodeId)!;
      if (mutation.kind === "hidden") {
        if (snapshot.hidden === mutation.hidden) continue;
        commands.push({ kind: "hidden", nodeId: mutation.nodeId, expectedRevision: mutation.expectedRevision, hidden: mutation.hidden! });
      } else {
        if (sameTrs(mutation.initial!, mutation.transform!)) continue;
        commands.push({ kind: "transform", nodeId: mutation.nodeId, expectedRevision: mutation.expectedRevision, transform: mutation.transform! });
      }
    }
    if (!commands.length) return { status: "noop", baseRevision: this.graph.revision, sourceCommandCount: inputs.length };
    try {
      return { status: "prepared", changeset: createSceneChangeset(changesetId, this.graph.revision, commands),
        sourceCommandCount: inputs.length, skippedCommandCount: inputs.length - commands.length };
    } catch (error) {
      return { status: "rejected", issues: [issue(-1, "malformed-command", readableError(error))] };
    }
  }

  commit(preparation: Extract<SceneMutationPreparation, { status: "prepared" }>): SceneChangesetOutcome {
    return applySceneChangeset(this.graph, preparation.changeset);
  }

  execute(changesetId: string, inputs: readonly unknown[]): SceneMutationExecution {
    const preparation = this.prepare(changesetId, inputs);
    return preparation.status === "prepared" ? this.commit(preparation) : preparation;
  }

  private parse(input: unknown, index: number, issues: SceneMutationIssue[]): SupportedCommand | undefined {
    let parsed: unknown;
    try { parsed = this.parser.parse(input); }
    catch (error) { issues.push(issue(index, "parse-error", readableError(error))); return undefined; }
    if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.type !== "string" || !isRecord(parsed.target)) {
      issues.push(issue(index, "malformed-command", "Parser did not return a Scene API command."));
      return undefined;
    }
    if (parsed.type !== "object.set-visibility" && parsed.type !== "object.set-transform") {
      issues.push(issue(index, "unsupported-command", `Scene command ${parsed.type} is not mapped to SceneChangeset.`, parsed.id));
      return undefined;
    }
    const target = parsed.target;
    if (typeof target.kind !== "string" || typeof target.sceneId !== "string"
      || (target.objectId !== undefined && typeof target.objectId !== "string")) {
      issues.push(issue(index, "malformed-command", "Scene command target is malformed.", parsed.id));
      return undefined;
    }
    if (parsed.type === "object.set-visibility") {
      if (typeof parsed.visible !== "boolean") {
        issues.push(issue(index, "malformed-command", "Visibility command requires a boolean visible field.", parsed.id));
        return undefined;
      }
      return { id: parsed.id, type: parsed.type, target: target as ObjectTarget, visible: parsed.visible };
    }
    const vectors = ["position", "rotation", "scale"] as const;
    for (const key of vectors) if (parsed[key] !== undefined && !isVec3(parsed[key])) {
      issues.push(issue(index, "malformed-command", `Transform ${key} must be a finite vec3.`, parsed.id));
      return undefined;
    }
    return { id: parsed.id, type: parsed.type, target: target as ObjectTarget,
      ...(parsed.position === undefined ? {} : { position: parsed.position as Vec3 }),
      ...(parsed.rotation === undefined ? {} : { rotation: parsed.rotation as Vec3 }),
      ...(parsed.scale === undefined ? {} : { scale: parsed.scale as Vec3 }) };
  }
}

function eulerXyzQuaternion([x, y, z]: Vec3): SceneQuaternion {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

function sameTrs(left: SceneLocalTrs, right: SceneLocalTrs): boolean {
  return sameVector(left.translation, right.translation) && sameVector(left.rotation, right.rotation) && sameVector(left.scale, right.scale);
}
function sameVector(left: readonly number[], right: readonly number[]): boolean { return left.every((value, index) => value === right[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isVec3(value: unknown): value is Vec3 { return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite); }
function readableError(error: unknown): string { return error instanceof Error && error.message ? error.message : String(error); }
function issue(index: number, reason: SceneMutationIssueReason, message: string, commandId?: string): SceneMutationIssue {
  return { index, reason, message, ...(commandId === undefined ? {} : { commandId }) };
}
