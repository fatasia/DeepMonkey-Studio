import type { Document, WebIO } from "@gltf-transform/core";
import { cloneDocument } from "@gltf-transform/functions";
import { readDocument, statistics, type ModelFileStatistics } from "./modelOptimizer";
import { editOptimizerDocument, type OptimizerLayer, type OptimizerLayerEdit, type OptimizerLayerResult } from "./optimizerLayers";

export const LAYER_SESSION_MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;
const MAX_NODES = 20_000;
export interface OptimizerLayerDraft {
  layers: OptimizerLayer[];
  statistics: ModelFileStatistics;
  previewBinary?: Uint8Array<ArrayBuffer>;
}

/** 只缓存一份不可变原件；连续命令只计算轻量节点状态，直到出文件才克隆几何。 */
export class OptimizerLayerSession {
  private base: { key: string; document: Document; bytes: number; layers: OptimizerLayer[]; statistics: ModelFileStatistics } | undefined;
  constructor(private readonly io: WebIO) {}

  async open(key: string, file?: File): Promise<boolean> {
    if (this.base?.key === key) return false;
    if (!file) throw new Error("图层缓存已释放，请重新执行操作");
    this.base = undefined;
    if (file.size > LAYER_SESSION_MAX_FILE_BYTES) throw new Error("模型超过 64 MB，请关闭连续编辑后重试");
    const document = await readDocument(this.io, file);
    const root = document.getRoot();
    const payloadBytes = root.listAccessors().reduce((sum, accessor) => sum + (accessor.getArray()?.byteLength ?? 0), 0)
      + root.listTextures().reduce((sum, texture) => sum + (texture.getImage()?.byteLength ?? 0), 0);
    if (payloadBytes > MAX_PAYLOAD_BYTES || root.listNodes().length > MAX_NODES) throw new Error("模型超出连续编辑缓存上限，请关闭连续编辑后重试");
    const layers = editOptimizerDocument(cloneDocument(document), []);
    this.base = { key, document, bytes: file.size, layers, statistics: statistics(document, file.size) };
    return true;
  }

  async draft(edits: readonly OptimizerLayerEdit[], includePreview: boolean): Promise<OptimizerLayerDraft> {
    const base = this.requireBase();
    const layers = draftLayerState(base.layers, edits);
    const counts = { ...base.statistics, nodes: layers.filter(layer => !layer.deleted).length };
    if (!includePreview) return { layers, statistics: counts };
    // 首次预览保留全部节点，隐藏/删除在 Three 场景内应用，撤销不需重新下载几何。
    const preview = cloneDocument(base.document);
    editOptimizerDocument(preview, base.document.getRoot().listNodes().map((_, id) => ({ id, action: "hidden", hidden: false })));
    const previewBinary = await this.io.writeBinary(preview) as Uint8Array<ArrayBuffer>;
    return { layers, statistics: counts, previewBinary };
  }

  async materialize(edits: readonly OptimizerLayerEdit[]): Promise<OptimizerLayerResult> {
    const base = this.requireBase();
    const document = cloneDocument(base.document);
    const layers = editOptimizerDocument(document, edits);
    const binary = await this.io.writeBinary(document) as Uint8Array<ArrayBuffer>;
    return { layers, binary, statistics: statistics(document, binary.byteLength) };
  }

  clear() { this.base = undefined; }
  private requireBase() {
    if (!this.base) throw new Error("图层缓存已释放，请重新执行操作");
    return this.base;
  }
}

export function draftLayerState(base: readonly OptimizerLayer[], edits: readonly OptimizerLayerEdit[]): OptimizerLayer[] {
  const layers = base.map(layer => ({ ...layer }));
  const byId = new Map(layers.map(layer => [layer.id, layer]));
  for (const edit of edits) {
    const layer = byId.get(edit.id);
    if (!layer) throw new Error("图层已不存在，请重新载入模型");
    if (edit.action === "rename") {
      const name = edit.name.trim();
      if (!name || name.length > 120) throw new Error("图层名称需为 1–120 个字符");
      layer.name = name;
    } else if (edit.action === "hidden") layer.ownHidden = edit.hidden;
    else layer.deleted = true;
  }
  // 层级列表是父节点先于子节点的顺序，继承状态只需一次线性遍历。
  for (const layer of layers) {
    const parent = layer.parentId === undefined ? undefined : byId.get(layer.parentId);
    layer.hidden = Boolean(layer.ownHidden || parent?.hidden);
    layer.deleted = layer.deleted || Boolean(parent?.deleted);
  }
  return layers;
}
