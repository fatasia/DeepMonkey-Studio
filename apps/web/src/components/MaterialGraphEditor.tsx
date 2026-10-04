import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SceneMaterialState } from "@bim-studio/contracts";
import type { MaterialGraphDefinition, MaterialGraphLayer, MaterialGraphMaskKind } from "../materials/materialGraphModel";
import { MATERIAL_GRAPH_MAX_LAYERS, createLayer, createMaterialGraph, deriveGraphEdges, deriveGraphNodes, validateMaterialGraph } from "../materials/materialGraphModel";
import { compileMaterialGraph } from "../materials/materialGraphCompiler";
import { captureOriginalMaterial, deleteMaterialGraph, isTextureMaskUrlSizeOk, loadCapturedMaterial, loadMaterialGraph, restoreMaterialPatch, saveMaterialGraph } from "../materials/materialGraphStore";
import { MaterialGraphCanvas } from "./MaterialGraphCanvas";
import { MaterialGraphLayerProps, type MaterialGraphSelection } from "./MaterialGraphLayerProps";
import { translate as tr, type AppLocale } from "../i18n";
import "./MaterialGraphEditor.css";

/**
 * 材质图编辑器面板(编辑器刀 7)。
 *
 * 即时反馈链路:图定义变更 → rAF 合帧 → 纹理遮罩预读(带缓存)→ 预合成编译
 * (纯 JS 网格 + Canvas 光栅)→ onApplyMaterialPatch(既有 selectionMaterialCommand
 * 写路径,对象即时更新)。定义随 localStorage(sceneId:modelId)持久化并在挂载时恢复;
 * "断开图"用捕获的原材质 patch 还原全部接管槽位。
 */

interface Props {
  readonly locale: AppLocale;
  readonly disabled: boolean;
  readonly sceneId: string;
  readonly modelId: string;
  /** 当前对象有效材质(底材质节点初值与断开还原的事实来源)。 */
  readonly material: SceneMaterialState;
  readonly onApplyMaterialPatch: (patch: SceneMaterialState) => void;
}

interface CompileReport {
  compileMs: number;
  channels: string[];
}

/** 纹理遮罩灰度网格缓存:url → 256² 亮度(单次解码,后续编译零图片开销)。 */
const textureGridCache = new Map<string, Uint8ClampedArray>();

async function loadTextureGrid(url: string, size: number): Promise<Uint8ClampedArray> {
  const cached = textureGridCache.get(url);
  if (cached) return cached;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("遮罩贴图解码失败"));
    element.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D 画布上下文不可用");
  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  const gray = new Uint8ClampedArray(size * size);
  for (let i = 0; i < gray.length; i += 1) {
    const o = i * 4;
    gray[i] = (data[o]! * 299 + data[o + 1]! * 587 + data[o + 2]! * 114) / 1000;
  }
  textureGridCache.set(url, gray);
  return gray;
}

export function MaterialGraphEditor({ locale, disabled, sceneId, modelId, material, onApplyMaterialPatch }: Props) {
  const [open, setOpen] = useState(false);
  const [graph, setGraph] = useState<MaterialGraphDefinition>(() => createMaterialGraph(
    tr(locale, "材质图", "Material graph"),
    { color: material.color ?? "#9aa2a9", metalness: material.metalness ?? 0.1, roughness: material.roughness ?? 0.5 },
  ));
  const [selection, setSelection] = useState<MaterialGraphSelection>(undefined);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [report, setReport] = useState<CompileReport | undefined>();
  const [problems, setProblems] = useState<string[]>([]);
  const [linked, setLinked] = useState(false);
  const frameRef = useRef(0);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  const materialRef = useRef(material);
  materialRef.current = material;

  const nodes = useMemo(() => deriveGraphNodes(graph), [graph]);
  const edges = useMemo(() => deriveGraphEdges(graph), [graph]);

  /** 挂载/切对象:恢复已保存定义;无存档则以当前对象材质为底初值。 */
  useEffect(() => {
    const saved = loadMaterialGraph(sceneId, modelId);
    if (saved) {
      setGraph(saved);
      setLinked(Boolean(loadCapturedMaterial(sceneId, modelId)));
    } else {
      setGraph(createMaterialGraph(tr(locale, "材质图", "Material graph"), {
        color: materialRef.current.color ?? "#9aa2a9",
        metalness: materialRef.current.metalness ?? 0.1,
        roughness: materialRef.current.roughness ?? 0.5,
      }));
      setLinked(false);
    }
    setPositions({});
    setSelection(undefined);
  }, [sceneId, modelId, locale]);

  const runCompile = useCallback(async (next: MaterialGraphDefinition, apply: boolean) => {
    const problemsNow = validateMaterialGraph(next);
    setProblems(problemsNow);
    if (problemsNow.length) return;
    const size = 256;
    const gridByLayer = new Map<string, Uint8ClampedArray>();
    try {
      for (const layer of next.layers) {
        if (layer.mask.kind === "texture" && layer.mask.textureUrl) {
          gridByLayer.set(layer.id, await loadTextureGrid(layer.mask.textureUrl, size));
        }
      }
    } catch (reason) {
      setProblems([reason instanceof Error ? reason.message : String(reason)]);
      return;
    }
    const compiled = compileMaterialGraph(next, {
      size,
      sampleTextureMask: (layer, u, v) => {
        const grid = gridByLayer.get(layer.id);
        if (!grid) return 0;
        const x = Math.min(size - 1, Math.floor(u * size));
        const y = Math.min(size - 1, Math.floor((1 - v) * size));
        return grid[y * size + x]! / 255;
      },
    });
    const channels = [
      compiled.urls.colorUrl && tr(locale, "颜色", "Color"),
      compiled.urls.ormUrl && tr(locale, "粗糙度/金属度", "Rough/Metal"),
      compiled.urls.normalUrl && tr(locale, "凹凸", "Bump"),
    ].filter(Boolean) as string[];
    setReport({ compileMs: compiled.compileMs, channels });
    if (apply) onApplyMaterialPatch(compiled.patch);
  }, [locale, onApplyMaterialPatch]);

  /** 编译调度:rAF 合帧;接管状态下改动即时应用。 */
  const scheduleCompile = useCallback((next: MaterialGraphDefinition, forceApply: boolean) => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      void runCompile(next, forceApply || linkedRef.current);
    });
  }, [runCompile]);

  const changeGraph = useCallback((next: MaterialGraphDefinition) => {
    setGraph(next);
    saveMaterialGraph(sceneId, modelId, next);
    scheduleCompile(next, false);
  }, [modelId, sceneId, scheduleCompile]);

  /** 接管/断开:接管=捕获原材质+立即应用当前图;断开=还原 patch+清除登记与存档。 */
  const toggleLinked = useCallback(() => {
    if (linked) {
      const restore = restoreMaterialPatch(sceneId, modelId);
      if (restore) onApplyMaterialPatch(restore);
      deleteMaterialGraph(sceneId, modelId);
      setLinked(false);
      setReport(undefined);
      return;
    }
    captureOriginalMaterial(sceneId, modelId, materialRef.current);
    saveMaterialGraph(sceneId, modelId, graphRef.current);
    setLinked(true);
    scheduleCompile(graphRef.current, true);
  }, [linked, modelId, onApplyMaterialPatch, scheduleCompile, sceneId]);

  const addLayer = useCallback((kind: MaterialGraphMaskKind) => {
    const current = graphRef.current;
    if (current.layers.length >= MATERIAL_GRAPH_MAX_LAYERS) return;
    changeGraph({ ...current, layers: [...current.layers, createLayer(kind)], updatedAt: new Date().toISOString() });
  }, [changeGraph]);

  const removeLayer = useCallback((layerId: string) => {
    const current = graphRef.current;
    changeGraph({ ...current, layers: current.layers.filter(layer => layer.id !== layerId), updatedAt: new Date().toISOString() });
    setSelection(previous => previous && "layerId" in previous && previous.layerId === layerId ? undefined : previous);
  }, [changeGraph]);

  const onTextureMaskFile = useCallback((layerId: string, file: File) => {
    if (file.size > 256 * 1024) {
      setProblems([tr(locale, "遮罩贴图超过 256KB 上限", "Mask image exceeds the 256KB limit")]);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      if (!isTextureMaskUrlSizeOk(dataUrl)) {
        setProblems([tr(locale, "遮罩贴图超过 256KB 上限", "Mask image exceeds the 256KB limit")]);
        return;
      }
      const current = graphRef.current;
      changeGraph({
        ...current,
        layers: current.layers.map(layer => layer.id === layerId
          ? { ...layer, mask: { ...layer.mask, kind: "texture", textureUrl: dataUrl, textureName: file.name } }
          : layer),
        updatedAt: new Date().toISOString(),
      });
    };
    reader.readAsDataURL(file);
  }, [changeGraph, locale]);

  const selectNode = useCallback((nodeId: string) => {
    if (nodeId === "output") { setSelection({ kind: "output" }); return; }
    if (nodeId === "base") { setSelection({ kind: "base" }); return; }
    if (nodeId.startsWith("mask:")) { setSelection({ kind: "mask", layerId: nodeId.slice(5) }); return; }
    setSelection({ kind: "layer", layerId: nodeId });
  }, []);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
  }, []);

  const statusText = problems.length
    ? problems.join("；")
    : linked
      ? tr(locale, `已接管 · ${report ? `${report.channels.join(" + ") || tr(locale, "无通道", "no channels")} · ${report.compileMs.toFixed(1)}ms` : tr(locale, "就绪", "ready")}`,
        `Linked · ${report ? `${report.channels.join(" + ") || "no channels"} · ${report.compileMs.toFixed(1)}ms` : "ready"}`)
      : tr(locale, "未接管 —— 接管后改动才会应用到对象", "Not linked — link to apply changes to the object");

  return (
    <details className="material-graph-editor" data-qa="material-graph-editor" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{tr(locale, "材质图(分层预合成)", "Material graph (layered precompose)")}</span>
        <small>{graph.layers.length}/{MATERIAL_GRAPH_MAX_LAYERS} {tr(locale, "层", "layers")}</small>
      </summary>
      <div className="material-graph-body">
        <MaterialGraphCanvas
          locale={locale}
          nodes={nodes}
          edges={edges}
          positions={positions}
          selectedId={selectionNodeId(selection)}
          disabled={disabled}
          onSelect={selectNode}
          onPositionsChange={setPositions}
        />
        <div className="material-graph-toolbar">
          <button type="button" data-qa="material-graph-link" disabled={disabled}
            className={linked ? "active" : ""} onClick={toggleLinked}>
            {linked ? tr(locale, "断开图并还原", "Unlink & restore") : tr(locale, "接管对象材质", "Take over material")}
          </button>
          <span className={`material-graph-status${problems.length ? " error" : ""}`} role="status" data-qa="material-graph-status">{statusText}</span>
        </div>
        <MaterialGraphLayerProps
          locale={locale}
          disabled={disabled}
          graph={graph}
          selection={selection}
          onGraphChange={changeGraph}
          onTextureMaskFile={onTextureMaskFile}
          layerCount={graph.layers.length}
          onAddLayer={addLayer}
          onRemoveLayer={removeLayer}
        />
      </div>
    </details>
  );
}

function selectionNodeId(selection: MaterialGraphSelection): string | undefined {
  if (!selection) return undefined;
  if (selection.kind === "output") return "output";
  if (selection.kind === "base") return "base";
  if (selection.kind === "mask") return `mask:${selection.layerId}`;
  return selection.layerId;
}
