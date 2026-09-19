import * as THREE from "three";
import type { ComponentRecord } from "./analysis";
import { ModelDiffOverlay, resolveDiffHighlightColors, type DiffHighlightKind } from "./modelDiffOverlay";
import { ViewerEnginePointer } from "./viewerEnginePointer";

// P1 模型版本变更对比·查看器职责层：快照捕获与三色只读高亮。
// 普通网格走 ModelDiffOverlay 材质覆盖；IFC/Fragments 走 fragments highlight 通道
// （preserveOriginalMaterial，与选中高亮同一机制）；不新建渲染系统。

export interface ModelDiffHighlightTarget {
  modelId: string;
  nodeId: string;
  kind: DiffHighlightKind;
}

export interface ModelDiffSnapshot {
  modelId: string;
  modelName: string;
  capturedAt: string;
  /** stableId 保留实例前缀原样；跨实例对比身份由评审层归一（diffIdentityOf）。 */
  records: ComponentRecord[];
}

/** 对比高亮覆盖的 fragment 模型，清除时用于定向 resetHighlight。 */
const fragmentDiffCustomId = "bim-studio-model-diff";

export abstract class ViewerEngineModelDiff extends ViewerEnginePointer {
  private readonly diffOverlay = new ModelDiffOverlay();
  private diffHighlightVersion = 0;
  private diffHighlightFragmentModels = new Set<string>();

  /** 捕获实例当前构件记录快照；记录与场景索引解耦，替换/移除后仍可参与对比。 */
  captureModelDiffSnapshot(modelId: string): ModelDiffSnapshot | undefined {
    const model = this.models.get(modelId);
    const records = this.componentRecords.get(modelId);
    if (!model || !records) return undefined;
    return { modelId, modelName: model.name, capturedAt: new Date().toISOString(), records: structuredClone(records) };
  }

  async setModelDiffHighlight(targets: ModelDiffHighlightTarget[]): Promise<void> {
    this.clearModelDiffHighlight(false);
    const version = ++this.diffHighlightVersion;
    const colors = resolveDiffHighlightColors((token) => readHighlightToken(token));
    const objectTargets: Array<{ object: THREE.Object3D; kind: DiffHighlightKind }> = [];
    const fragmentKinds = new Map<string, Map<DiffHighlightKind, Set<number>>>();
    for (const target of targets) {
      const fragmentEntry = this.fragmentLayers.get(target.modelId)?.get(target.nodeId);
      const fragmentModel = this.fragmentModels.get(target.modelId);
      if (fragmentEntry && fragmentModel) {
        let perKind = fragmentKinds.get(target.modelId);
        if (!perKind) fragmentKinds.set(target.modelId, perKind = new Map());
        let localIds = perKind.get(target.kind);
        if (!localIds) perKind.set(target.kind, localIds = new Set());
        for (const localId of fragmentEntry.localIds) localIds.add(localId);
        continue;
      }
      const object = this.layerObjects.get(target.modelId)?.get(target.nodeId);
      if (object) objectTargets.push({ object, kind: target.kind });
    }
    this.diffOverlay.apply(objectTargets, colors);
    for (const [modelId, perKind] of fragmentKinds) {
      const fragmentModel = this.fragmentModels.get(modelId);
      if (!fragmentModel) continue;
      await fragmentModel.resetHighlight();
      if (version !== this.diffHighlightVersion) return;
      const renderedFaces = this.requireFragmentRuntime().api.RenderedFaces.TWO;
      for (const [kind, localIds] of perKind) {
        await fragmentModel.highlight([...localIds], {
          color: colors[kind],
          renderedFaces,
          opacity: 0.6,
          transparent: true,
          preserveOriginalMaterial: true,
          depthTest: true,
          depthWrite: false,
          customId: fragmentDiffCustomId,
        });
        if (version !== this.diffHighlightVersion) return;
      }
      this.diffHighlightFragmentModels.add(modelId);
    }
    if (fragmentKinds.size > 0) void this.fragments?.update(true);
    this.requestRender();
  }

  clearModelDiffHighlight(restoreSelection = true): void {
    this.diffHighlightVersion += 1;
    this.diffOverlay.clear();
    const touched = this.diffHighlightFragmentModels;
    this.diffHighlightFragmentModels = new Set();
    if (touched.size > 0) {
      for (const modelId of touched) void this.fragmentModels.get(modelId)?.resetHighlight();
      // 评审高亮借用了 fragments 高亮通道；清除后恢复可能存在的选中高亮，避免吞掉选择状态。
      if (restoreSelection && this.selectedId && this.selectedFragmentNodeId) {
        const fragmentModel = this.fragmentModels.get(this.selectedId);
        const entry = this.fragmentLayers.get(this.selectedId)?.get(this.selectedFragmentNodeId);
        if (fragmentModel && entry) void this.highlightFragmentSelection(fragmentModel, entry);
      }
      void this.fragments?.update(true);
      this.requestRender();
    } else if (this.diffOverlay.activeCount > 0) {
      this.requestRender();
    }
  }

  /** 先于渲染器销毁执行；覆盖材质与 fragments 高亮通道都要回到原始状态。 */
  override dispose(): void {
    this.clearModelDiffHighlight();
    super.dispose();
  }
}

function readHighlightToken(token: string): string {
  if (typeof document === "undefined") return "";
  return document.defaultView?.getComputedStyle(document.documentElement).getPropertyValue(token) ?? "";
}
