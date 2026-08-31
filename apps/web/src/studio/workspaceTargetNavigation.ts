import type { ApplicationDocument } from "@bim-studio/contracts";
import type { SceneScriptTarget } from "./sceneScriptContext";

export type ScriptTargetLocation =
  | { kind: "component"; pageId: string }
  | { kind: "object"; sceneId: string };

/** 从应用文档解析脚本目标所属页面或场景，导航层无需重复遍历文档。 */
export function findScriptTargetLocation(
  application: ApplicationDocument,
  target: SceneScriptTarget,
  fallbackSceneId?: string,
): ScriptTargetLocation | undefined {
  if (target.kind === "component") {
    const page = application.pages.find((candidate) => candidate.nodes.some((node) => node.id === target.id));
    return page ? { kind: "component", pageId: page.id } : undefined;
  }
  const scene = application.scenes.find((candidate) =>
    [...candidate.models, ...candidate.primitives].some((object) => object.modelId === target.id),
  );
  if (scene) return { kind: "object", sceneId: scene.id };
  return fallbackSceneId ? { kind: "object", sceneId: fallbackSceneId } : undefined;
}

/** 等待跨场景资源完成加载后聚焦目标；超时返回 false，由界面提供可操作提示。 */
export async function focusViewerTargetWhenReady(
  focus: () => boolean,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? 100);
  const intervalMs = Math.max(10, options.intervalMs ?? 60);
  for (let index = 0; index < attempts; index += 1) {
    if (focus()) return true;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }
  return false;
}
