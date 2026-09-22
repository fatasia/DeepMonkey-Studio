import type { RenderGraphCompileResult } from "../renderGraph.js";
import { executeParallelGroups, type ParallelGroupTask } from "../renderGraphScheduler.js";

export interface RenderGraphEncoderPassContext {
  readonly passId: string;
  readonly encoder: GPUCommandEncoder;
}

export type RenderGraphEncoderPass = (context: RenderGraphEncoderPassContext) => Promise<void> | void;

export interface RenderGraphEncoderExecutionOptions {
  readonly maxConcurrency?: number;
  readonly signal?: AbortSignal;
  readonly encoderLabelPrefix?: string;
}

export interface RenderGraphEncoderExecutionResult {
  readonly planHash: string;
  readonly encodedPasses: readonly string[];
  readonly submittedGroups: number;
  readonly commandBufferCount: number;
}

export type RenderGraphSynchronousEncoderPass = (context: RenderGraphEncoderPassContext) => void;

export interface RenderGraphEncodedGroup {
  readonly planHash: string;
  readonly groupIndex: number;
  readonly encodedPasses: readonly string[];
  readonly commandBuffers: readonly GPUCommandBuffer[];
}

interface EncodedPass {
  readonly passId: string;
  readonly commandBuffer: GPUCommandBuffer;
}

/**
 * Encodes independent RenderGraph passes into separate command encoders, then
 * submits each dependency level in deterministic plan order. A failed or
 * cancelled group is never partially submitted.
 */
export async function executeRenderGraphEncoders(
  device: GPUDevice,
  plan: RenderGraphCompileResult,
  passes: ReadonlyMap<string, RenderGraphEncoderPass>,
  options: RenderGraphEncoderExecutionOptions = {},
): Promise<RenderGraphEncoderExecutionResult> {
  const groups = validateExecutionInputs(device, plan, passes);
  const encodedPasses: string[] = [];
  let submittedGroups = 0;
  let commandBufferCount = 0;

  for (const group of groups) {
    throwIfAborted(options.signal);
    const tasks = group.map((passId): ParallelGroupTask<EncodedPass> => ({
      id: passId,
      run: async () => {
        throwIfAborted(options.signal);
        const encoder = device.createCommandEncoder({
          label: `${options.encoderLabelPrefix ?? "Deep RenderGraph"}: ${passId}`,
        });
        await passes.get(passId)!({ passId, encoder });
        throwIfAborted(options.signal);
        return { passId, commandBuffer: encoder.finish({ label: `${passId} command buffer` }) };
      },
    }));
    const result = await executeParallelGroups([tasks], {
      ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
      stopOnError: true,
    });
    if (result.failed.length > 0) {
      throw executionFailure(result.failed[0]!.id, result.failed[0]!.error);
    }
    throwIfAborted(options.signal);
    const commandBuffers = group.map((passId) => result.values.get(passId)!.commandBuffer);
    device.queue.submit(commandBuffers);
    encodedPasses.push(...group);
    submittedGroups += 1;
    commandBufferCount += commandBuffers.length;
  }

  return Object.freeze({
    planHash: plan.planHash!,
    encodedPasses: Object.freeze(encodedPasses),
    submittedGroups,
    commandBufferCount,
  });
}

/**
 * Encodes one dependency level without submitting it. Production frame loops can
 * append the returned buffers to their single queue submission, preserving the
 * renderer's transactional commit/fail boundary.
 */
export function encodeRenderGraphEncoderGroup(
  device: GPUDevice,
  plan: RenderGraphCompileResult,
  groupIndex: number,
  passes: ReadonlyMap<string, RenderGraphSynchronousEncoderPass>,
  options: Pick<RenderGraphEncoderExecutionOptions, "encoderLabelPrefix"> = {},
): RenderGraphEncodedGroup {
  const groups = validatePlanAndDevice(device, plan);
  if (!Number.isSafeInteger(groupIndex) || groupIndex < 0 || groupIndex >= groups.length) {
    throw new Error(`RenderGraph encoder group index is outside the compiled plan: ${groupIndex}.`);
  }
  const group = groups[groupIndex]!;
  validatePassMap(group, passes);
  const commandBuffers = group.map((passId) => {
    const encoder = device.createCommandEncoder({
      label: `${options.encoderLabelPrefix ?? "Deep RenderGraph"}: ${passId}`,
    });
    try {
      passes.get(passId)!({ passId, encoder });
      return encoder.finish({ label: `${passId} command buffer` });
    } catch (error) {
      throw executionFailure(passId, error);
    }
  });
  return Object.freeze({
    planHash: plan.planHash!, groupIndex,
    encodedPasses: Object.freeze([...group]), commandBuffers: Object.freeze(commandBuffers),
  });
}

function validateExecutionInputs(
  device: GPUDevice,
  plan: RenderGraphCompileResult,
  passes: ReadonlyMap<string, RenderGraphEncoderPass>,
): readonly (readonly string[])[] {
  const groups = validatePlanAndDevice(device, plan);
  const flattened = groups.flat();
  const groupedIds = new Set(flattened);
  if (flattened.length !== plan.order.length || groupedIds.size !== flattened.length
    || plan.order.some(passId => !groupedIds.has(passId))) {
    throw new Error("RenderGraph parallel groups must cover the compiled pass order exactly.");
  }
  for (const passId of plan.order) {
    if (typeof passes.get(passId) !== "function") {
      throw new Error(`RenderGraph encoder is missing pass callback: ${passId}.`);
    }
  }
  for (const passId of passes.keys()) {
    if (!plan.order.includes(passId)) {
      throw new Error(`RenderGraph encoder callback is outside the compiled plan: ${passId}.`);
    }
  }
  return groups;
}

function validatePlanAndDevice(device: GPUDevice,
  plan: RenderGraphCompileResult): readonly (readonly string[])[] {
  if (!device || typeof device.createCommandEncoder !== "function" || typeof device.queue?.submit !== "function") {
    throw new Error("RenderGraph encoder executor requires a ready GPUDevice.");
  }
  if (!plan.valid || !plan.planHash || !plan.parallelGroups) {
    throw new Error("RenderGraph encoder executor requires a valid compiled plan with parallel groups and plan hash.");
  }
  return plan.parallelGroups;
}

function validatePassMap(group: readonly string[],
  passes: ReadonlyMap<string, RenderGraphSynchronousEncoderPass>): void {
  for (const passId of group) {
    if (typeof passes.get(passId) !== "function") {
      throw new Error(`RenderGraph encoder is missing pass callback: ${passId}.`);
    }
  }
  for (const passId of passes.keys()) {
    if (!group.includes(passId)) {
      throw new Error(`RenderGraph encoder callback is outside the selected group: ${passId}.`);
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("RenderGraph encoder execution was cancelled.");
}

function executionFailure(passId: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`RenderGraph pass ${passId} failed to encode: ${detail}`, { cause });
}
