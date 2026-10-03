/**
 * H-C7-P2 Node 门共享 harness：无头 DeepApp 推进模板场景动画并采样断言。
 * 无 DOM/WebGPU 依赖；与 harness.ts 共用同一 scene.ts 场景构造。
 */
import { DeepApp, type DeepAppPlugin } from "@bim-studio/deep-engine/app";
import type { PbrMaterial, RenderInstance } from "@bim-studio/deep-engine";
import type { TemplateSceneSpec } from "./sceneTypes.js";

export interface NodeFrameLog {
  readonly elapsedMs: number;
  readonly eye: readonly [number, number, number];
  readonly instanceTransforms: Record<string, number[]>;
  readonly emissiveStrengths: Record<string, number>;
}

export interface NodeTemplateResult {
  readonly template: string;
  readonly frames: number;
  readonly animated: boolean;
  readonly eyeMoved: boolean;
  readonly instances: number;
  readonly materials: number;
  readonly geometries: number;
  readonly disposed: boolean;
}

function sample(spec: TemplateSceneSpec, elapsedMs: number): NodeFrameLog {
  const update = spec.update?.(elapsedMs);
  const instances: readonly RenderInstance[] = update?.instances ?? spec.packet.instances;
  const materials: readonly PbrMaterial[] = update?.materials ?? spec.packet.materials;
  const instanceTransforms: Record<string, number[]> = {};
  for (const instance of instances) {
    instanceTransforms[instance.id] = Array.from(instance.transform).slice(12, 15);
  }
  const emissiveStrengths: Record<string, number> = {};
  for (const material of materials) {
    if (material.emissiveStrength !== undefined) emissiveStrengths[material.id] = material.emissiveStrength;
  }
  return { elapsedMs, eye: spec.eye(elapsedMs), instanceTransforms, emissiveStrengths };
}

export async function runTemplateNode(options: { template: string; scene: TemplateSceneSpec;
  frames?: number; stepMs?: number; checks?: (log: NodeFrameLog[]) => void }): Promise<NodeTemplateResult> {
  const { template, scene } = options;
  const frameCount = options.frames ?? 6, stepMs = options.stepMs ?? 16;
  const state: { log: NodeFrameLog[]; elapsedMs: number } = { log: [], elapsedMs: 0 };
  const recorder: DeepAppPlugin<typeof state> = { id: "template-node-recorder", setup(context) {
    context.invalidate("template-node-initial");
    context.addFrameStage({ id: "record", execute: frame => {
      frame.context.state.elapsedMs += frame.deltaMs;
      frame.context.state.log.push(sample(scene, frame.context.state.elapsedMs));
    } });
  } };
  const app = await DeepApp.create({ state, plugins: [recorder] });
  const first = await app.advance(0);
  if (first.status !== "rendered") throw new Error(`Unexpected first frame: ${JSON.stringify(first)}`);
  for (let index = 1; index < frameCount; index++) {
    app.invalidate("template-node-tick");
    // advance 以绝对时间戳推进（deltaMs = timeMs - lastTimeMs），必须单调递增。
    const frame = await app.advance(index * stepMs);
    if (frame.status !== "rendered") throw new Error(`Unexpected frame ${index}: ${frame.status}`);
  }
  const log = state.log;
  if (log.length !== frameCount) throw new Error(`Expected ${frameCount} frames, recorded ${log.length}`);
  const baseline = JSON.stringify(log[0]!.instanceTransforms) + JSON.stringify(log[0]!.emissiveStrengths);
  const animated = log.slice(1).some(entry =>
    JSON.stringify(entry.instanceTransforms) + JSON.stringify(entry.emissiveStrengths) !== baseline);
  const eyeMoved = log.slice(1).some(entry => entry.eye.some((value, axis) => value !== log[0]!.eye[axis]));
  options.checks?.(log);
  const firstDispose = app.dispose(), secondDispose = app.dispose();
  if (firstDispose !== secondDispose) throw new Error("Dispose promise was not reused");
  await firstDispose;
  return { template, frames: log.length, animated, eyeMoved,
    instances: scene.packet.instances.length, materials: scene.packet.materials.length,
    geometries: scene.packet.geometries.length, disposed: app.status === "disposed" };
}
