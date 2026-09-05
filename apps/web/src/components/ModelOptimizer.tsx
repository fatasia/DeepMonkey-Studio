import { useEffect, useRef, useState } from "react";
import { Box, Crosshair, Eye, Gauge, Image, Lightbulb, LoaderCircle, Move3D, Plus, Rotate3D, Sparkles, Square, Trash2, Triangle, Upload } from "lucide-react";
import type { ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import { DEFAULT_BAKE_LIGHTS, type BakeLightState, type BakeLightType, type ModelFileStatistics, type ModelOptimizationOptions } from "../optimizer/modelOptimizer";
import { ModelOptimizerWorkerClient } from "../optimizer/modelOptimizerWorkerClient";
import { convertProjectModelToGlb, isDirectOptimizerInput, optimizedAssetFile, uploadAndConvertForOptimizer, waitForOptimizerModel } from "../optimizer/modelOptimizerAssets";
import type { WebLightmapResult } from "../optimizer/lightmapBaker";
import { ACCEPTED_MODELS } from "../appDefaults";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { ModelOptimizerHeader, ModelOptimizerPipeline } from "./ModelOptimizerPipeline";
import { OptimizerPreview } from "./OptimizerPreview";
import {
  BakeVector,
  currentLightmapQuality,
  formatBytes,
  isOptimizerAbortError as isAbortError,
  localizeOptimizerMessage,
  optimizerErrorMessage as errorMessage,
  OptionSection,
  reduction,
  Stat,
} from "./ModelOptimizerFields";

const DEFAULT_OPTIONS: ModelOptimizationOptions = {
  simplifyEnabled: true,
  simplifyRatio: 0.5,
  simplifyError: 0.001,
  dracoEnabled: true,
  textureEnabled: true,
  textureSize: 2048,
  textureFormat: "webp",
  bakeEnabled: false,
  bakeMode: "vertex",
  bakeStrength: 0.35,
  bakeAmbient: 0.28,
  bakeAmbientColor: "#ffffff",
  bakeLights: structuredClone(DEFAULT_BAKE_LIGHTS),
  lightmapResolution: 512,
  lightmapAmbientOcclusion: true,
  lightmapAoSamples: 4,
  lightmapShadows: true,
  lightmapShadowSamples: 4,
  lightmapIndirectSamples: 2,
  lightmapDenoise: true,
  origin: "ground",
  removeUnused: true,
};

type BakeTransformMode = "translate" | "rotate";

export function ModelOptimizer({ locale, onBack, project, onProjectChange }: {
  locale: AppLocale; onBack: () => void; project: ProjectRecord | undefined; onProjectChange?: (project: ProjectRecord) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceUrlRef = useRef<string | undefined>(undefined);
  const optimizedUrlRef = useRef<string | undefined>(undefined);
  const optimizedOptionsRef = useRef<string | undefined>(undefined);
  const workerRef = useRef<ModelOptimizerWorkerClient | undefined>(undefined);
  const operationRef = useRef(0);
  const [file, setFile] = useState<File>();
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [optimizedUrl, setOptimizedUrl] = useState<string>();
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [before, setBefore] = useState<ModelFileStatistics>();
  const [after, setAfter] = useState<ModelFileStatistics>();
  const [lightmapResult, setLightmapResult] = useState<WebLightmapResult>();
  const [output, setOutput] = useState<Uint8Array<ArrayBuffer>>();
  const [showOptimized, setShowOptimized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("导入 GLB 或内嵌资源的 glTF 开始优化");
  const [error, setError] = useState<string>();
  const [selectedBakeLightId, setSelectedBakeLightId] = useState(DEFAULT_BAKE_LIGHTS[0]?.id);
  const [bakeTransformMode, setBakeTransformMode] = useState<BakeTransformMode>("translate");
  const [previewShadows, setPreviewShadows] = useState(false);
  const [previewReflections, setPreviewReflections] = useState(false);
  const [selectedProjectModelId, setSelectedProjectModelId] = useState("");
  const [savedModelId, setSavedModelId] = useState<string>();

  function addBakeLight(type: BakeLightType) {
    const index = options.bakeLights.length + 1;
    const light: BakeLightState = {
      id: crypto.randomUUID(),
      name: type === "directional" ? `${tr(locale, "方向光", "Directional")} ${index}` : `${tr(locale, "点光源", "Point light")} ${index}`,
      type,
      enabled: true,
      color: "#ffffff",
      intensity: type === "directional" ? 0.75 : 1.4,
      direction: [0.35, 0.82, 0.45],
      position: [4, 8, 4],
      range: 20,
    };
    setOptions((current) => ({ ...current, bakeLights: [...current.bakeLights, light] }));
    setSelectedBakeLightId(light.id);
  }

  function updateBakeLight(id: string, patch: Partial<BakeLightState>) {
    setOptions((current) => ({ ...current, bakeLights: current.bakeLights.map((light) => (light.id === id ? { ...light, ...patch } : light)) }));
  }

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      if (optimizedUrlRef.current) URL.revokeObjectURL(optimizedUrlRef.current);
    },
    [],
  );

  async function importFile(next?: File) {
    if (!next) return;
    cancelProcessing(false);
    const operation = ++operationRef.current;
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    if (optimizedUrlRef.current) URL.revokeObjectURL(optimizedUrlRef.current);
    setSavedModelId(undefined);
    setBusy(true);
    setMessage("正在准备模型");
    setError(undefined);
    let prepared = next;
    try {
      if (!isDirectOptimizerInput(next)) {
        if (!project) throw new Error("请先选择项目，其他格式需要通过项目转换服务处理");
        const converted = await uploadAndConvertForOptimizer(project.id, next, setMessage);
        prepared = converted.file;
        onProjectChange?.(converted.project);
      }
      if (operation !== operationRef.current) return;
      await loadPreparedFile(prepared, operation);
    } catch (reason) {
      if (isAbortError(reason) || operation !== operationRef.current) return;
      setError(errorMessage(reason, locale));
      setMessage("模型导入或转换失败");
    } finally {
      if (operation === operationRef.current) setBusy(false);
    }
  }

  async function importProjectModel(model: ModelRecord) {
    cancelProcessing(false);
    const operation = ++operationRef.current;
    setSelectedProjectModelId(model.id);
    setSavedModelId(undefined);
    setBusy(true);
    setError(undefined);
    try {
      const prepared = await convertProjectModelToGlb(model, setMessage);
      if (operation !== operationRef.current) return;
      await loadPreparedFile(prepared, operation);
    } catch (reason) {
      if (isAbortError(reason) || operation !== operationRef.current) return;
      setError(errorMessage(reason, locale));
      setMessage("项目模型转换失败");
    } finally {
      if (operation === operationRef.current) setBusy(false);
    }
  }

  async function loadPreparedFile(next: File, operation: number) {
    const url = URL.createObjectURL(next);
    sourceUrlRef.current = url;
    optimizedUrlRef.current = undefined;
    optimizedOptionsRef.current = undefined;
    setFile(next);
    setSourceUrl(url);
    setOptimizedUrl(undefined);
    setOutput(undefined);
    setAfter(undefined);
    setLightmapResult(undefined);
    setShowOptimized(false);
    setMessage("正在分析模型");
    setBefore(await getWorker().inspect(next));
    if (operation !== operationRef.current) return;
    setMessage("模型已载入，可调整参数后开始优化");
  }

  async function runOptimization() {
    if (!file) return;
    const operation = ++operationRef.current;
    setBusy(true);
    setError(undefined);
    try {
      const result = await getWorker().optimize(file, options, (nextMessage) => {
        if (operation === operationRef.current) setMessage(nextMessage);
      });
      if (operation !== operationRef.current) return;
      const blob = new Blob([result.binary], { type: "model/gltf-binary" });
      if (optimizedUrlRef.current) URL.revokeObjectURL(optimizedUrlRef.current);
      const url = URL.createObjectURL(blob);
      optimizedUrlRef.current = url;
      optimizedOptionsRef.current = JSON.stringify(options);
      setBefore(result.before);
      setAfter(result.after);
      setLightmapResult(result.lightmap);
      setOutput(result.binary);
      setOptimizedUrl(url);
      setShowOptimized(true);
      setMessage(
        result.lightmap
          ? `优化完成，已生成 ${result.lightmap.resolution}×${result.lightmap.resolution} 光照贴图，覆盖 ${result.lightmap.coveredTexels.toLocaleString()} 像素`
          : `优化完成，体积减少 ${reduction(result.before.bytes, result.after.bytes)}%`,
      );
    } catch (reason) {
      if (isAbortError(reason) || operation !== operationRef.current) return;
      setError(errorMessage(reason, locale));
      setMessage("优化失败，原始文件未修改");
    } finally {
      if (operation === operationRef.current) setBusy(false);
    }
  }

  function getWorker() {
    workerRef.current ??= new ModelOptimizerWorkerClient();
    return workerRef.current;
  }

  function cancelProcessing(showMessage = true) {
    operationRef.current += 1;
    workerRef.current?.terminate();
    workerRef.current = undefined;
    setBusy(false);
    if (showMessage) setMessage("处理已取消，原始文件未修改");
  }

  function applyBakePreset(preset: "outdoor" | "indoor") {
    const lights: BakeLightState[] =
      preset === "outdoor"
        ? structuredClone(DEFAULT_BAKE_LIGHTS)
        : [
            { ...structuredClone(DEFAULT_BAKE_LIGHTS[0]!), id: "bake-indoor-key", name: tr(locale, "室内主光", "Indoor key"), intensity: 0.65, direction: [0.45, 0.75, 0.48] },
            {
              ...structuredClone(DEFAULT_BAKE_LIGHTS[0]!),
              id: "bake-indoor-fill",
              name: tr(locale, "室内补光", "Indoor fill"),
              color: "#b8d8ff",
              intensity: 0.35,
              direction: [-0.55, 0.5, -0.35],
            },
          ];
    setOptions((current) => ({
      ...current,
      bakeEnabled: true,
      bakeStrength: preset === "outdoor" ? 0.35 : 0.45,
      bakeAmbient: preset === "outdoor" ? 0.28 : 0.42,
      bakeAmbientColor: preset === "outdoor" ? "#ffffff" : "#fff1dc",
      bakeLights: lights,
    }));
    setSelectedBakeLightId(lights[0]?.id);
    setBakeTransformMode("translate");
  }

  function applyLightmapQuality(quality: "draft" | "standard" | "high") {
    setOptions((current) => ({
      ...current,
      lightmapResolution: quality === "draft" ? 256 : quality === "standard" ? 512 : 1024,
      lightmapAoSamples: quality === "high" ? 8 : 4,
      lightmapShadowSamples: quality === "draft" ? 1 : quality === "standard" ? 4 : 8,
      lightmapIndirectSamples: quality === "draft" ? 0 : quality === "standard" ? 2 : 4,
      lightmapDenoise: quality !== "draft",
    }));
  }

  function exportGlb() {
    if (!output || !file) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([output], { type: "model/gltf-binary" }));
    link.download = `${file.name.replace(/\.(glb|gltf)$/i, "")}.optimized.glb`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  }

  async function saveToProjectAssets() {
    if (!output || !file || !project) return;
    const operation = ++operationRef.current;
    setBusy(true);
    setError(undefined);
    try {
      setMessage("正在保存优化结果到项目素材库");
      const uploaded = await api.uploadModel(project.id, optimizedAssetFile(file.name, output));
      const current = await waitForOptimizerModel(project.id, uploaded.id, setMessage);
      if (operation !== operationRef.current) return;
      onProjectChange?.(current);
      setSavedModelId(uploaded.id);
      setMessage("优化模型已保存到项目素材库，可直接用于场景");
    } catch (reason) {
      if (isAbortError(reason) || operation !== operationRef.current) return;
      setError(errorMessage(reason, locale));
      setMessage("保存项目素材失败");
    } finally {
      if (operation === operationRef.current) setBusy(false);
    }
  }

  const optionsFingerprint = JSON.stringify(options);
  const resultOutdated = Boolean(output && optimizedOptionsRef.current !== optionsFingerprint);
  useEffect(() => {
    if (resultOutdated) setShowOptimized(false);
  }, [resultOutdated]);
  const previewUrl = showOptimized && optimizedUrl && !resultOutdated ? optimizedUrl : sourceUrl;
  const comparisonMode = Boolean(optimizedUrl && !resultOutdated);
  const displayMessage = localizeOptimizerMessage(locale, message);
  return (
    <div className="optimizer-page">
      <ModelOptimizerHeader locale={locale} onBack={onBack} onImport={() => inputRef.current?.click()} onDownload={exportGlb} onSave={() => void saveToProjectAssets()} canExport={Boolean(output && !resultOutdated && !busy)} canSave={Boolean(output && !resultOutdated && project && !busy && !savedModelId)} busy={busy} />
      <main className="optimizer-layout">
        <aside className={`optimizer-settings ${file ? "" : "awaiting-model"}`}>
          <ModelOptimizerPipeline locale={locale} project={project} models={(project?.models ?? []).filter((model) => model.status === "ready" && model.manifest?.geometryUrl)} selectedModelId={selectedProjectModelId} onSelectModel={(id) => { const model = project?.models.find((item) => item.id === id); if (model) void importProjectModel(model); }} onImport={() => inputRef.current?.click()} hasSource={Boolean(file)} hasOutput={Boolean(output && !resultOutdated)} saved={Boolean(savedModelId)} busy={busy} />
          <div className="optimizer-file">
            <Box size={18} />
            <div>
              <strong>{file?.name ?? tr(locale, "尚未导入模型", "No model imported")}</strong>
              <span>
                {before
                  ? `${formatBytes(before.bytes)} · ${before.triangles.toLocaleString(locale)} ${tr(locale, "面", "triangles")}`
                  : tr(locale, "GLB / glTF，或经转换器处理的模型", "GLB / glTF, or models processed by a converter")}
              </span>
            </div>
          </div>
          <OptionSection
            icon={<Triangle size={15} />}
            title={tr(locale, "模型减面", "Mesh simplification")}
            enabled={options.simplifyEnabled}
            onToggle={(enabled) => setOptions({ ...options, simplifyEnabled: enabled })}
          >
            <label>
              <span>{tr(locale, "目标保留比例", "Target ratio")}</span>
              <output>{Math.round(options.simplifyRatio * 100)}%</output>
              <input
                aria-label={tr(locale, "目标保留比例", "Target ratio")}
                type="range"
                min="0.05"
                max="1"
                step="0.01"
                value={options.simplifyRatio}
                onChange={(event) => setOptions({ ...options, simplifyRatio: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>{tr(locale, "最大误差", "Maximum error")}</span>
              <output>{(options.simplifyError * 100).toFixed(2)}%</output>
              <input
                aria-label={tr(locale, "最大误差", "Maximum error")}
                type="range"
                min="0.0001"
                max="0.02"
                step="0.0001"
                value={options.simplifyError}
                onChange={(event) => setOptions({ ...options, simplifyError: Number(event.target.value) })}
              />
            </label>
          </OptionSection>
          <OptionSection
            icon={<Sparkles size={15} />}
            title={tr(locale, "Draco 压缩", "Draco compression")}
            enabled={options.dracoEnabled}
            onToggle={(enabled) => setOptions({ ...options, dracoEnabled: enabled })}
          >
            <p>{tr(locale, "压缩顶点、法线和索引；Viewer 已内置 Draco 解码器。", "Compresses vertices, normals and indices; the viewer includes a Draco decoder.")}</p>
          </OptionSection>
          <OptionSection
            icon={<Image size={15} />}
            title={tr(locale, "压缩贴图", "Texture compression")}
            enabled={options.textureEnabled}
            onToggle={(enabled) => setOptions({ ...options, textureEnabled: enabled })}
          >
            <div className="optimizer-selects">
              <label>
                <span>{tr(locale, "最大尺寸", "Maximum size")}</span>
                <select value={options.textureSize} onChange={(event) => setOptions({ ...options, textureSize: Number(event.target.value) })}>
                  <option value="512">512</option>
                  <option value="1024">1024</option>
                  <option value="2048">2048</option>
                  <option value="4096">4096</option>
                </select>
              </label>
              <label>
                <span>{tr(locale, "输出格式", "Output format")}</span>
                <select
                  value={options.textureFormat}
                  onChange={(event) => setOptions({ ...options, textureFormat: event.target.value as ModelOptimizationOptions["textureFormat"] })}
                >
                  <option value="webp">WebP</option>
                  <option value="jpeg">JPEG</option>
                  <option value="original">{tr(locale, "保持原格式", "Keep original")}</option>
                </select>
              </label>
            </div>
          </OptionSection>
          <OptionSection
            icon={<Lightbulb size={15} />}
            title={tr(locale, "轻量光照烘焙", "Lightweight light baking")}
            enabled={options.bakeEnabled}
            onToggle={(enabled) => setOptions({ ...options, bakeEnabled: enabled })}
          >
            <div className="optimizer-bake-mode">
              <button className={options.bakeMode === "vertex" ? "active" : ""} onClick={() => setOptions({ ...options, bakeMode: "vertex" })}>
                {tr(locale, "快速顶点色", "Vertex color")}
              </button>
              <button className={options.bakeMode === "lightmap" ? "active" : ""} onClick={() => setOptions({ ...options, bakeMode: "lightmap" })}>
                {tr(locale, "Web 光照贴图", "Web lightmap")}
              </button>
            </div>
            {options.bakeMode === "lightmap" && (
              <>
                <div className="optimizer-quality">
                  <span>{tr(locale, "质量", "Quality")}</span>
                  {(["draft", "standard", "high"] as const).map((quality) => (
                    <button key={quality} className={currentLightmapQuality(options) === quality ? "active" : ""} onClick={() => applyLightmapQuality(quality)}>
                      {quality === "draft" ? tr(locale, "草稿", "Draft") : quality === "standard" ? tr(locale, "标准", "Standard") : tr(locale, "高质量", "High")}
                    </button>
                  ))}
                </div>
                <div className="optimizer-lightmap-settings">
                  <label>
                    <span>{tr(locale, "贴图分辨率", "Resolution")}</span>
                    <select
                      value={options.lightmapResolution}
                      onChange={(event) => setOptions({ ...options, lightmapResolution: Number(event.target.value) as ModelOptimizationOptions["lightmapResolution"] })}
                    >
                      <option value="256">256²</option>
                      <option value="512">512²</option>
                      <option value="1024">1024²</option>
                    </select>
                  </label>
                  <label>
                    <span>{tr(locale, "环境遮蔽 AO", "Ambient occlusion")}</span>
                    <button
                      className={options.lightmapAmbientOcclusion ? "active" : ""}
                      onClick={() => setOptions({ ...options, lightmapAmbientOcclusion: !options.lightmapAmbientOcclusion })}
                    >
                      {options.lightmapAmbientOcclusion ? tr(locale, "开启", "On") : tr(locale, "关闭", "Off")}
                    </button>
                  </label>
                  <label>
                    <span>{tr(locale, "静态阴影", "Static shadows")}</span>
                    <button className={options.lightmapShadows ? "active" : ""} onClick={() => setOptions({ ...options, lightmapShadows: !options.lightmapShadows })}>
                      {options.lightmapShadows ? tr(locale, "开启", "On") : tr(locale, "关闭", "Off")}
                    </button>
                  </label>
                  <label>
                    <span>{tr(locale, "AO 采样", "AO samples")}</span>
                    <select
                      value={options.lightmapAoSamples}
                      disabled={!options.lightmapAmbientOcclusion}
                      onChange={(event) => setOptions({ ...options, lightmapAoSamples: Number(event.target.value) as ModelOptimizationOptions["lightmapAoSamples"] })}
                    >
                      <option value="4">4 · {tr(locale, "快速", "Fast")}</option>
                      <option value="8">8 · {tr(locale, "精细", "Fine")}</option>
                    </select>
                  </label>
                  <label>
                    <span>{tr(locale, "软阴影采样", "Soft shadows")}</span>
                    <select
                      value={options.lightmapShadowSamples}
                      disabled={!options.lightmapShadows}
                      onChange={(event) => setOptions({ ...options, lightmapShadowSamples: Number(event.target.value) as ModelOptimizationOptions["lightmapShadowSamples"] })}
                    >
                      <option value="1">1 · {tr(locale, "硬阴影", "Hard")}</option>
                      <option value="4">4</option>
                      <option value="8">8</option>
                    </select>
                  </label>
                  <label>
                    <span>{tr(locale, "间接光反弹", "Indirect bounce")}</span>
                    <select
                      value={options.lightmapIndirectSamples}
                      onChange={(event) => setOptions({ ...options, lightmapIndirectSamples: Number(event.target.value) as ModelOptimizationOptions["lightmapIndirectSamples"] })}
                    >
                      <option value="0">{tr(locale, "关闭", "Off")}</option>
                      <option value="2">2 · {tr(locale, "快速", "Fast")}</option>
                      <option value="4">4 · {tr(locale, "精细", "Fine")}</option>
                    </select>
                  </label>
                  <label>
                    <span>{tr(locale, "贴图降噪", "Denoise")}</span>
                    <button className={options.lightmapDenoise ? "active" : ""} onClick={() => setOptions({ ...options, lightmapDenoise: !options.lightmapDenoise })}>
                      {options.lightmapDenoise ? tr(locale, "开启", "On") : tr(locale, "关闭", "Off")}
                    </button>
                  </label>
                </div>
              </>
            )}
            <div className="optimizer-bake-presets">
              <span>{tr(locale, "快速预设", "Presets")}</span>
              <button onClick={() => applyBakePreset("outdoor")}>{tr(locale, "自然日光", "Daylight")}</button>
              <button onClick={() => applyBakePreset("indoor")}>{tr(locale, "室内均匀", "Indoor")}</button>
            </div>
            <label>
              <span>{tr(locale, "烘焙强度", "Bake strength")}</span>
              <output>{Math.round(options.bakeStrength * 100)}%</output>
              <input
                aria-label={tr(locale, "烘焙强度", "Bake strength")}
                type="range"
                min="0.05"
                max="0.8"
                step="0.05"
                value={options.bakeStrength}
                onChange={(event) => setOptions({ ...options, bakeStrength: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>{tr(locale, "环境亮度", "Ambient level")}</span>
              <output>{Math.round(options.bakeAmbient * 100)}%</output>
              <input
                aria-label={tr(locale, "环境亮度", "Ambient level")}
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={options.bakeAmbient}
                onChange={(event) => setOptions({ ...options, bakeAmbient: Number(event.target.value) })}
              />
            </label>
            <div className="optimizer-ambient-color">
              <span>{tr(locale, "全局光颜色", "Global light color")}</span>
              <input type="color" value={options.bakeAmbientColor} onChange={(event) => setOptions({ ...options, bakeAmbientColor: event.target.value })} />
              <input
                className="optimizer-color-value"
                aria-label={tr(locale, "全局光颜色值", "Global light color value")}
                value={options.bakeAmbientColor}
                onChange={(event) => {
                  if (/^#[0-9a-f]{6}$/i.test(event.target.value)) setOptions({ ...options, bakeAmbientColor: event.target.value });
                }}
              />
              <small>{tr(locale, "仅使用优化页配置", "Optimizer settings only")}</small>
            </div>
            <div className="optimizer-bake-head">
              <span>{tr(locale, "烘焙光源", "Bake lights")}</span>
              <div>
                <button onClick={() => addBakeLight("directional")}>
                  <Plus size={11} />
                  {tr(locale, "方向光", "Directional")}
                </button>
                <button onClick={() => addBakeLight("point")}>
                  <Plus size={11} />
                  {tr(locale, "点光", "Point")}
                </button>
              </div>
            </div>
            {selectedBakeLightId && (
              <div className="optimizer-bake-transform">
                <span>{tr(locale, "场景操控", "Gizmo")}</span>
                <button className={bakeTransformMode === "translate" ? "active" : ""} onClick={() => setBakeTransformMode("translate")}>
                  <Move3D size={11} />
                  {tr(locale, "移动", "Move")}
                </button>
                <button
                  className={bakeTransformMode === "rotate" ? "active" : ""}
                  disabled={options.bakeLights.find((light) => light.id === selectedBakeLightId)?.type !== "directional"}
                  onClick={() => setBakeTransformMode("rotate")}
                >
                  <Rotate3D size={11} />
                  {tr(locale, "旋转", "Rotate")}
                </button>
              </div>
            )}
            <div className="optimizer-bake-list">
              {options.bakeLights.map((light) => (
                <article
                  key={light.id}
                  className={`${!light.enabled ? "disabled" : ""} ${selectedBakeLightId === light.id ? "selected" : ""}`}
                  onClick={() => setSelectedBakeLightId(light.id)}
                >
                  <header>
                    <button className={`optimizer-bake-enable ${light.enabled ? "active" : ""}`} onClick={() => updateBakeLight(light.id, { enabled: !light.enabled })}>
                      <i />
                    </button>
                    <input value={light.name} onChange={(event) => updateBakeLight(light.id, { name: event.target.value })} />
                    <span>{light.type === "directional" ? tr(locale, "方向", "DIR") : tr(locale, "点光", "POINT")}</span>
                    <button
                      className="danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        setOptions((current) => ({ ...current, bakeLights: current.bakeLights.filter((item) => item.id !== light.id) }));
                        if (selectedBakeLightId === light.id) setSelectedBakeLightId(undefined);
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </header>
                  <div className="optimizer-bake-main">
                    <input type="color" value={light.color} onChange={(event) => updateBakeLight(light.id, { color: event.target.value })} />
                    <input
                      className="optimizer-light-color-value"
                      aria-label={`${light.name} ${tr(locale, "颜色", "color")}`}
                      value={light.color}
                      onChange={(event) => {
                        if (/^#[0-9a-f]{6}$/i.test(event.target.value)) updateBakeLight(light.id, { color: event.target.value });
                      }}
                    />
                    <label>
                      <span>{tr(locale, "强度", "Intensity")}</span>
                      <input
                        type="number"
                        min="0"
                        max="8"
                        step="0.05"
                        value={light.intensity}
                        onChange={(event) => updateBakeLight(light.id, { intensity: Number(event.target.value) })}
                      />
                    </label>
                    {light.type === "point" && (
                      <label>
                        <span>{tr(locale, "范围", "Range")}</span>
                        <input type="number" min="0.1" step="0.5" value={light.range} onChange={(event) => updateBakeLight(light.id, { range: Number(event.target.value) })} />
                      </label>
                    )}
                  </div>
                  <BakeVector
                    locale={locale}
                    label={light.type === "directional" ? tr(locale, "照射方向", "Direction") : tr(locale, "模型坐标", "Model position")}
                    value={light.type === "directional" ? light.direction : light.position}
                    onChange={(value) => updateBakeLight(light.id, light.type === "directional" ? { direction: value } : { position: value })}
                  />
                </article>
              ))}
            </div>
            <p>
              {options.bakeMode === "vertex"
                ? tr(locale, "把环境光、方向光和点光漫反射写入顶点色，速度快、文件增量小。", "Writes diffuse lighting into vertex colors for fast, compact output.")
                : tr(
                    locale,
                    "自动展开 UV2，生成彩色直接光、软阴影、AO 与一次间接反弹；双贴图按标准 glTF 写入 GLB。",
                    "Automatically unwraps UV2 and bakes colored direct light, soft shadows, AO, and one indirect bounce into standard glTF textures.",
                  )}
            </p>
          </OptionSection>
          <OptionSection icon={<Eye size={15} />} title={tr(locale, "预览渲染", "Preview rendering")}>
            <div className="optimizer-render-settings">
              <label>
                <span>
                  {tr(locale, "实时阴影", "Real-time shadows")}
                  <small>{tr(locale, "高质量大模型会增加 GPU 负载", "Adds GPU load on large models")}</small>
                </span>
                <button className={previewShadows ? "active" : ""} onClick={() => setPreviewShadows((value) => !value)}>
                  {previewShadows ? tr(locale, "开启", "On") : tr(locale, "关闭", "Off")}
                </button>
              </label>
              <label>
                <span>
                  {tr(locale, "环境反射", "Environment reflections")}
                  <small>{tr(locale, "仅作用于 PBR 金属和光滑材质", "Affects PBR metallic and glossy materials")}</small>
                </span>
                <button className={previewReflections ? "active" : ""} onClick={() => setPreviewReflections((value) => !value)}>
                  {previewReflections ? tr(locale, "开启", "On") : tr(locale, "关闭", "Off")}
                </button>
              </label>
            </div>
            <p>
              {comparisonMode
                ? tr(
                    locale,
                    "原始与优化结果正使用同一套相机、曝光和中性光照，阴影与反射开关会同步作用于两边。",
                    "Original and optimized results use the same camera, exposure and neutral lighting; shadow and reflection toggles affect both.",
                  )
                : tr(
                    locale,
                    "这些开关只影响优化页预览，不会写入导出的 GLB；烘焙阴影请使用上方静态阴影设置。",
                    "These toggles affect only this preview and are not written to the exported GLB; use Static shadows above for baking.",
                  )}
            </p>
          </OptionSection>
          <OptionSection icon={<Crosshair size={15} />} title={tr(locale, "设置原点", "Set origin")}>
            <div className="origin-options">
              {(
                [
                  ["keep", tr(locale, "保持", "Keep")],
                  ["center", tr(locale, "模型中心", "Model center")],
                  ["ground", tr(locale, "底部中心", "Bottom center")],
                ] as const
              ).map(([value, label]) => (
                <button key={value} className={options.origin === value ? "active" : ""} onClick={() => setOptions({ ...options, origin: value })}>
                  {label}
                </button>
              ))}
            </div>
          </OptionSection>
          <OptionSection
            icon={<Trash2 size={15} />}
            title={tr(locale, "删除无用数据", "Remove unused data")}
            enabled={options.removeUnused}
            onToggle={(enabled) => setOptions({ ...options, removeUnused: enabled })}
          >
            <p>
              {tr(locale, "合并重复数据、焊接重复点，并清理未引用节点、材质和访问器。", "Deduplicates data, welds vertices and removes unused nodes, materials and accessors.")}
            </p>
          </OptionSection>
          <button className={`optimizer-run ${busy ? "cancel" : ""}`} disabled={!file} onClick={() => (busy ? cancelProcessing() : void runOptimization())}>
            {busy ? <Square size={14} /> : <Gauge size={16} />}
            {busy ? tr(locale, "取消处理", "Cancel processing") : tr(locale, "开始优化", "Start optimization")}
          </button>
          {busy && (
            <div className="optimizer-progress">
              <LoaderCircle className="spin" size={12} />
              <span>{displayMessage}</span>
            </div>
          )}
        </aside>
        <section className="optimizer-preview">
          <div className="optimizer-preview-toolbar">
            <div>
              {optimizedUrl && (
                <>
                  <button className={!showOptimized ? "active" : ""} onClick={() => setShowOptimized(false)}>
                    {tr(locale, "原始模型", "Original")}
                  </button>
                  <button className={showOptimized ? "active" : ""} disabled={resultOutdated} onClick={() => setShowOptimized(true)}>
                    {tr(locale, "优化结果", "Optimized")}
                  </button>
                </>
              )}
            </div>
            <span>{resultOutdated ? tr(locale, "参数已变化，请重新优化生成结果", "Options changed; run optimization again") : displayMessage}</span>
          </div>
          {previewUrl ? (
            <OptimizerPreview
              url={previewUrl}
              bakeEnabled={options.bakeEnabled && !showOptimized}
              comparisonMode={comparisonMode}
              shadows={previewShadows}
              reflections={previewReflections}
              ambient={options.bakeAmbient}
              ambientColor={options.bakeAmbientColor}
              lights={options.bakeLights}
              selectedLightId={selectedBakeLightId}
              transformMode={bakeTransformMode}
              onSelectLight={(id) => {
                setSelectedBakeLightId(id);
                const selected = options.bakeLights.find((light) => light.id === id);
                if (selected?.type === "point") setBakeTransformMode("translate");
              }}
              onUpdateLight={updateBakeLight}
            />
          ) : (
            <button className="optimizer-drop" onClick={() => inputRef.current?.click()}>
              <Upload size={32} />
              <strong>{tr(locale, "导入模型开始", "Import a model to begin")}</strong>
              <span>{tr(locale, "GLB 本地处理，其他格式自动进入项目转换链路", "GLB runs locally; other formats use the project conversion pipeline")}</span>
            </button>
          )}
          {error && <div className="optimizer-error">{error}</div>}
          {lightmapResult && !resultOutdated && (
            <div className="optimizer-bake-result">
              <span>
                <strong>UV2</strong>
                {lightmapResult.uvAtlas === "watlas" ? "watlas" : tr(locale, "兼容图集", "fallback atlas")}
              </span>
              <span>
                <strong>{lightmapResult.resolution}²</strong>
                {tr(locale, "双贴图", "dual maps")}
              </span>
              <span>
                <strong>{lightmapResult.shadowSamples}</strong>
                {tr(locale, "软阴影采样", "shadow samples")}
              </span>
              <span>
                <strong>{lightmapResult.indirectSamples || "—"}</strong>
                {tr(locale, "间接采样", "bounce samples")}
              </span>
              <span>
                <strong>{formatBytes(lightmapResult.textureBytes)}</strong>
                {tr(locale, "贴图体积", "texture size")}
              </span>
            </div>
          )}
          {(before || after) && (
            <div className="optimizer-statistics">
              <Stat
                locale={locale}
                label={tr(locale, "文件大小", "File size")}
                before={before ? formatBytes(before.bytes) : "—"}
                after={after ? formatBytes(after.bytes) : undefined}
              />
              <Stat
                locale={locale}
                label={tr(locale, "三角面", "Triangles")}
                before={before?.triangles.toLocaleString(locale) ?? "—"}
                after={after?.triangles.toLocaleString(locale)}
              />
              <Stat locale={locale} label={tr(locale, "顶点", "Vertices")} before={before?.vertices.toLocaleString(locale) ?? "—"} after={after?.vertices.toLocaleString(locale)} />
              <Stat
                locale={locale}
                label={tr(locale, "节点 / 材质", "Nodes / materials")}
                before={before ? `${before.nodes} / ${before.materials}` : "—"}
                after={after ? `${after.nodes} / ${after.materials}` : undefined}
              />
            </div>
          )}
        </section>
      </main>
      <input ref={inputRef} hidden type="file" accept={ACCEPTED_MODELS} onChange={(event) => void importFile(event.target.files?.[0])} />
    </div>
  );
}
