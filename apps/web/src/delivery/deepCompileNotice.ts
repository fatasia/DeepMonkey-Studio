import type { SceneRenderCompilation } from "./compileSceneRenderPacket";

const FEATURE_LABEL = { animations: "动画", skins: "骨骼蒙皮", morphTargets: "形变目标" } as const;

/**
 * 编辑器 Deep 切换的可见提示:降级为静态姿态的含动画模型、引擎无法导入而被隐藏的模型、
 * 按槽丢弃的作者法线贴图(切线基不可交付)。全部活体且无隐藏/损失时无提示。
 */
export function describeDeepCompileNotice(compiled: Pick<SceneRenderCompilation,
  "deformedModels" | "skippedModels" | "textureLosses">): string | undefined {
  const notices: string[] = [];
  const degraded = compiled.deformedModels?.filter(model => model.mode === "bind-pose");
  if (degraded?.length) {
    const features = [...new Set(degraded.flatMap(model => model.features))].map(feature => FEATURE_LABEL[feature]).join("/");
    const reason = degraded.find(model => model.fallbackReason)?.fallbackReason;
    notices.push(`${new Set(degraded.map(model => model.modelId)).size} 个含${features}的模型以静态姿态显示${reason ? `（${reason}）` : ""}`);
  }
  if (compiled.skippedModels?.length) {
    notices.push(`${compiled.skippedModels.length} 个模型 Deep 暂不能导入，已隐藏（${compiled.skippedModels[0]!.reason}）`);
  }
  if (compiled.textureLosses?.length) {
    notices.push(`${new Set(compiled.textureLosses.map(loss => loss.modelId)).size} 个对象的法线贴图因切线基不可交付，以无凹凸显示（${compiled.textureLosses[0]!.reason}）`);
  }
  return notices.length ? notices.join("；") : undefined;
}
