import type { SceneCapability, SceneCommand, SceneObjectRef, ScenePermission } from "./protocol.js";
import { validateSceneCommand } from "./commandValidation.js";

/** H09：受限 Agent 场景事务的稳定数据合同。事务不拥有场景状态，状态仍由宿主 driver 管理。 */
export const SCENE_COMMAND_TRANSACTION_SCHEMA_VERSION = 1 as const;
export const SCENE_COMMAND_TRANSACTION_MAX_COMMANDS = 64 as const;

export type SceneCommandTransactionIssueReason =
  | "invalid-request"
  | "parse-error"
  | "duplicate-command"
  | "permission-denied"
  | "capability-denied"
  | "scene-mismatch"
  | "revision-conflict"
  | "cancelled"
  | "driver-error"
  | "malformed-result"
  | "rollback-failed";

export interface SceneCommandTransactionIssue {
  readonly index: number;
  readonly commandId?: string;
  readonly reason: SceneCommandTransactionIssueReason;
  readonly message: string;
}

export interface SceneCommandTransactionRequest {
  readonly id: string;
  readonly sceneId: string;
  readonly baseRevision: number;
  readonly module: {
    readonly id: string;
    readonly capabilities: readonly SceneCapability[];
    readonly permissions: readonly ScenePermission[];
  };
  /** Agent 输入先走 SDK validator；调用方不应先把 unknown 强转成 SceneCommand。 */
  readonly commands: readonly unknown[];
  readonly maxCommands?: number;
}

export interface SceneCommandTransactionDiff {
  readonly index: number;
  readonly commandId: string;
  readonly type: SceneCommand["type"];
  readonly target?: string;
  readonly summary: string;
}

export interface SceneCommandTransactionPlan {
  readonly schemaVersion: typeof SCENE_COMMAND_TRANSACTION_SCHEMA_VERSION;
  readonly id: string;
  readonly sceneId: string;
  readonly moduleId: string;
  readonly baseRevision: number;
  readonly commands: readonly SceneCommand[];
  readonly requiredCapabilities: readonly SceneCapability[];
  readonly diff: readonly SceneCommandTransactionDiff[];
}

export type SceneCommandTransactionPreparation =
  | { readonly status: "prepared"; readonly plan: SceneCommandTransactionPlan }
  | { readonly status: "rejected"; readonly issues: readonly SceneCommandTransactionIssue[] };

export interface SceneCommandTransactionResult {
  readonly index: number;
  readonly id: string;
  readonly type: SceneCommand["type"];
  readonly success: boolean;
  readonly message?: string;
}

export interface SceneCommandTransactionApplyResult {
  readonly revision: number;
  readonly results: readonly SceneCommandTransactionResult[];
}

export interface SceneCommandTransactionRollbackContext {
  readonly plan: SceneCommandTransactionPlan;
  readonly applied: readonly SceneCommandTransactionResult[];
  readonly cause?: unknown;
}

/**
 * The driver is the only owner allowed to mutate a scene. A driver must CAS on
 * the plan revision and make rollback idempotent; this keeps the SDK free of a
 * second scene state store while still making failed Agent batches recoverable.
 */
export interface SceneCommandTransactionDriver {
  readRevision(): number | Promise<number>;
  apply(commands: readonly SceneCommand[]): SceneCommandTransactionApplyResult | Promise<SceneCommandTransactionApplyResult>;
  rollback(context: SceneCommandTransactionRollbackContext): number | void | Promise<number | void>;
}

export type SceneCommandTransactionReceipt = {
  readonly schemaVersion: typeof SCENE_COMMAND_TRANSACTION_SCHEMA_VERSION;
  readonly id: string;
  readonly sceneId: string;
  readonly moduleId: string;
  readonly baseRevision: number;
  readonly finalRevision: number;
  readonly commandIds: readonly string[];
  readonly diff: readonly SceneCommandTransactionDiff[];
  readonly results: readonly SceneCommandTransactionResult[];
  readonly status: "committed" | "rolled-back";
};

export type SceneCommandTransactionOutcome =
  | { readonly status: "committed"; readonly receipt: SceneCommandTransactionReceipt }
  | { readonly status: "rolled-back"; readonly receipt: SceneCommandTransactionReceipt; readonly issue: SceneCommandTransactionIssue }
  | { readonly status: "rejected"; readonly issue: SceneCommandTransactionIssue }
  | { readonly status: "failed"; readonly issue: SceneCommandTransactionIssue };

const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Side-effect-free plan/diff generation. Any rejected command rejects the whole batch. */
export function prepareSceneCommandTransaction(request: SceneCommandTransactionRequest): SceneCommandTransactionPreparation {
  const issues: SceneCommandTransactionIssue[] = [];
  if (!request || typeof request !== "object") {
    return rejected(-1, "invalid-request", "Scene transaction request must be an object.");
  }
  if (!TRANSACTION_ID.test(request.id)) issues.push(issue(-1, "invalid-request", `Transaction id is invalid: ${request.id}`));
  if (typeof request.sceneId !== "string" || request.sceneId.trim() === "") issues.push(issue(-1, "invalid-request", "Scene id is required."));
  if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0) {
    issues.push(issue(-1, "invalid-request", "baseRevision must be a non-negative integer."));
  }
  if (!request.module || typeof request.module.id !== "string" || request.module.id.trim() === "") {
    issues.push(issue(-1, "invalid-request", "Agent module id is required."));
  }
  if (!request.module || !Array.isArray(request.module.capabilities) || !Array.isArray(request.module.permissions)) {
    issues.push(issue(-1, "invalid-request", "Agent module capabilities and permissions are required arrays."));
  }
  const maxCommands = request.maxCommands ?? SCENE_COMMAND_TRANSACTION_MAX_COMMANDS;
  if (!Number.isSafeInteger(maxCommands) || maxCommands < 1 || maxCommands > SCENE_COMMAND_TRANSACTION_MAX_COMMANDS) {
    issues.push(issue(-1, "invalid-request", `maxCommands must be between 1 and ${SCENE_COMMAND_TRANSACTION_MAX_COMMANDS}.`));
  }
  if (!Array.isArray(request.commands) || request.commands.length === 0) {
    issues.push(issue(-1, "invalid-request", "Scene transaction requires at least one command."));
  } else if (request.commands.length > maxCommands) {
    issues.push(issue(-1, "invalid-request", `Scene transaction exceeds the ${maxCommands}-command limit.`));
  }
  if (issues.length) return { status: "rejected", issues };

  if (!request.module.permissions.includes("scene.write")) {
    return rejected(-1, "permission-denied", "Agent module does not have scene.write permission.");
  }

  const commands: SceneCommand[] = [];
  const diffs: SceneCommandTransactionDiff[] = [];
  const commandIds = new Set<string>();
  const required = new Set<SceneCapability>();
  for (const [index, input] of request.commands.entries()) {
    const parsed = validateSceneCommand(input);
    if (!parsed.valid) {
      for (const validationIssue of parsed.issues) {
        issues.push({ index, reason: "parse-error", message: `${validationIssue.path}: ${validationIssue.message}` });
      }
      continue;
    }
    const command = parsed.command;
    if (commandIds.has(command.id)) {
      issues.push(issue(index, "duplicate-command", `Command id ${command.id} appears more than once.`, command.id));
      continue;
    }
    const scope = commandSceneMismatch(command, request.sceneId);
    if (scope) {
      issues.push(issue(index, "scene-mismatch", scope, command.id));
      continue;
    }
    const capabilities = requiredCapabilities(command.type);
    const missing = capabilities.filter(capability => !request.module.capabilities.includes(capability));
    if (missing.length) {
      issues.push(issue(index, "capability-denied", `Agent module lacks: ${missing.join(", ")}.`, command.id));
      continue;
    }
    commandIds.add(command.id);
    commands.push(command);
    capabilities.forEach(capability => required.add(capability));
    diffs.push(commandDiff(command, index));
  }
  if (issues.length) return { status: "rejected", issues };
  return {
    status: "prepared",
    plan: {
      schemaVersion: SCENE_COMMAND_TRANSACTION_SCHEMA_VERSION,
      id: request.id,
      sceneId: request.sceneId,
      moduleId: request.module.id,
      baseRevision: request.baseRevision,
      commands: commands.map(command => structuredClone(command)),
      requiredCapabilities: [...required].sort(),
      diff: diffs,
    },
  };
}

/** CAS commit with mandatory rollback on a driver error, partial result, or cancellation. */
export async function commitSceneCommandTransaction(
  plan: SceneCommandTransactionPlan,
  driver: SceneCommandTransactionDriver,
  signal?: AbortSignal,
): Promise<SceneCommandTransactionOutcome> {
  const cancelled = () => signal?.aborted === true;
  if (cancelled()) return rejectedOutcome("cancelled", "Scene transaction was cancelled before commit.");
  let revision: number;
  try { revision = await driver.readRevision(); }
  catch (error) { return failedOutcome("driver-error", readableError(error, "Unable to read scene revision.")); }
  if (revision !== plan.baseRevision) {
    return rejectedOutcome("revision-conflict", `Scene revision is ${revision}; transaction expects ${plan.baseRevision}.`);
  }
  if (cancelled()) return rejectedOutcome("cancelled", "Scene transaction was cancelled before apply.");

  let applied: SceneCommandTransactionApplyResult;
  try { applied = await driver.apply(plan.commands); }
  catch (error) { return rollbackAfterFailure(plan, driver, [], error); }
  const malformed = !Number.isSafeInteger(applied.revision) || applied.revision < plan.baseRevision
    || !Array.isArray(applied.results) || applied.results.length !== plan.commands.length;
  const failed = !malformed && applied.results.some(result => !result.success);
  if (!malformed && !failed && !cancelled()) {
    return { status: "committed", receipt: receipt(plan, applied.revision, applied.results, "committed") };
  }
  const cause = malformed
    ? new Error("Scene transaction driver returned a malformed result.")
    : cancelled() ? new Error("Scene transaction was cancelled after apply.") : new Error("Scene transaction command failed.");
  return rollbackAfterFailure(plan, driver, malformed ? [] : applied.results, cause, applied.revision);
}

function commandDiff(command: SceneCommand, index: number): SceneCommandTransactionDiff {
  const target = "target" in command
    ? ("kind" in command.target ? targetLabel(command.target) : undefined)
    : "componentId" in command ? `component:${command.componentId}` : undefined;
  return { index, commandId: command.id, type: command.type, ...(target ? { target } : {}), summary: `${command.type}${target ? ` → ${target}` : ""}` };
}

function targetLabel(target: SceneObjectRef): string {
  if (target.kind === "scene") return `scene:${target.sceneId}`;
  return target.kind === "object" ? `object:${target.objectId}` : `mesh:${target.objectId}/${target.meshId}`;
}

function commandSceneMismatch(command: SceneCommand, sceneId: string): string | undefined {
  if ((command.type === "camera.set" || command.type === "camera.fly-to") && command.sceneId !== sceneId) {
    return `Command targets scene ${command.sceneId}; active scene is ${sceneId}.`;
  }
  if (command.type === "selection.set") {
    const wrong = command.targets.find(target => target.sceneId !== sceneId);
    if (wrong) return `Command target scene ${wrong.sceneId}; active scene is ${sceneId}.`;
  } else if (command.type === "camera.fly-to") {
    if ("kind" in command.target && command.target.sceneId !== sceneId) return `Command target scene ${command.target.sceneId}; active scene is ${sceneId}.`;
  } else if (command.type === "object.set-visibility" || command.type === "object.set-transform"
    || command.type === "material.set" || command.type === "animation.control" || command.type === "data.apply") {
    if (command.target.sceneId !== sceneId) return `Command target scene ${command.target.sceneId}; active scene is ${sceneId}.`;
  }
  return undefined;
}

function requiredCapabilities(type: SceneCommand["type"]): readonly SceneCapability[] {
  if (type.startsWith("unity.")) return ["studio.unity"];
  if (type === "component.update") return ["studio.component"];
  if (type === "camera.set" || type === "camera.fly-to") return ["studio.camera"];
  if (type === "animation.control") return ["studio.animation"];
  if (type === "material.set") return ["studio.material", "studio.object"];
  if (type === "data.apply") return ["studio.data", "studio.object"];
  if (type === "selection.set") return ["studio.scene"];
  return ["studio.object"];
}

function rollbackAfterFailure(
  plan: SceneCommandTransactionPlan,
  driver: SceneCommandTransactionDriver,
  applied: readonly SceneCommandTransactionResult[],
  cause: unknown,
  fallbackRevision = plan.baseRevision,
): Promise<SceneCommandTransactionOutcome> {
  return Promise.resolve().then(async () => {
    try {
      const rollbackRevision = await driver.rollback({ plan, applied, cause });
      const finalRevision = rollbackRevision === undefined ? fallbackRevision : rollbackRevision;
      const issueValue = issue(-1, cause instanceof Error && cause.message.includes("malformed") ? "malformed-result" : "driver-error", readableError(cause, "Scene transaction failed."));
      return { status: "rolled-back", receipt: receipt(plan, finalRevision, applied, "rolled-back"), issue: issueValue };
    } catch (rollbackError) {
      return failedOutcome("rollback-failed", `${readableError(cause, "Scene transaction failed.")} Rollback failed: ${readableError(rollbackError, "unknown error")}`);
    }
  });
}

function receipt(plan: SceneCommandTransactionPlan, finalRevision: number, results: readonly SceneCommandTransactionResult[], status: "committed" | "rolled-back"): SceneCommandTransactionReceipt {
  return { schemaVersion: SCENE_COMMAND_TRANSACTION_SCHEMA_VERSION, id: plan.id, sceneId: plan.sceneId, moduleId: plan.moduleId,
    baseRevision: plan.baseRevision, finalRevision, commandIds: plan.commands.map(command => command.id), diff: plan.diff, results, status };
}

function issue(index: number, reason: SceneCommandTransactionIssueReason, message: string, commandId?: string): SceneCommandTransactionIssue {
  return { index, reason, message, ...(commandId === undefined ? {} : { commandId }) };
}
function rejected(index: number, reason: SceneCommandTransactionIssueReason, message: string): SceneCommandTransactionPreparation { return { status: "rejected", issues: [issue(index, reason, message)] }; }
function rejectedOutcome(reason: SceneCommandTransactionIssueReason, message: string): SceneCommandTransactionOutcome { return { status: "rejected", issue: issue(-1, reason, message) }; }
function failedOutcome(reason: SceneCommandTransactionIssueReason, message: string): SceneCommandTransactionOutcome { return { status: "failed", issue: issue(-1, reason, message) }; }
function readableError(error: unknown, fallback: string): string { return error instanceof Error && error.message.trim() ? error.message : typeof error === "string" && error.trim() ? error : fallback; }
