import { useRef, useState } from "react";
import { Box, Crosshair, Eye, Gauge, Image, LoaderCircle, Sparkles, Square, Trash2, Triangle, Upload } from "lucide-react";
import type { ProjectRecord } from "@bim-studio/contracts";
import { DEFAULT_BAKE_LIGHTS, type BakeLightState, type ModelOptimizationOptions } from "../optimizer/modelOptimizer";
import { ACCEPTED_MODELS } from "../appDefaults";
import { translate as tr, type AppLocale } from "../i18n";
import { ModelOptimizerHeader, ModelOptimizerPipeline } from "./ModelOptimizerPipeline";
import { useModelOptimizerSession } from "../optimizer/useModelOptimizerSession";
import { ModelOptimizerBaking } from "./ModelOptimizerBaking";
import { ModelAssetCredit } from "./ModelAssetCredit";
import { ModelAssetWorkflowActions } from "./ModelAssetWorkflowActions";
import { OptimizerPreview } from "./OptimizerPreview";
import {
  formatBytes,
  localizeOptimizerMessage,
  OptionSection,
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

export function ModelOptimizer({ locale, onBack, project, onProjectChange, requestedModelId, onViewAssets, onReturnToScene }: {
  locale: AppLocale; onBack: () => void; project: ProjectRecord | undefined; onProjectChange?: (project: ProjectRecord) => void;
  requestedModelId?: string | undefined; onViewAssets?: (modelId?: string) => void; onReturnToScene?: ((modelId?: string) => void) | undefined;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const { file, optimizedUrl, before, after, lightmapResult, output, showOptimized, setShowOptimized, busy, message, error, selectedProjectModelId, savedModelId, resultOutdated, previewUrl, comparisonMode, importFile, importProjectModel, runOptimization, cancelProcessing, exportGlb, saveToProjectAssets } = useModelOptimizerSession(locale, project, options, onProjectChange, requestedModelId);
  const [selectedBakeLightId, setSelectedBakeLightId] = useState(DEFAULT_BAKE_LIGHTS[0]?.id);
  const [bakeTransformMode, setBakeTransformMode] = useState<BakeTransformMode>("translate");
  const [previewShadows, setPreviewShadows] = useState(false);
  const [previewReflections, setPreviewReflections] = useState(true);
  const sourceModel = project?.models.find(model => model.id === selectedProjectModelId);

  function updateBakeLight(id: string, patch: Partial<BakeLightState>) {
    setOptions((current) => ({ ...current, bakeLights: current.bakeLights.map((light) => (light.id === id ? { ...light, ...patch } : light)) }));
  }

  const displayMessage = localizeOptimizerMessage(locale, message);
  return (
    <div className={`optimizer-page${onReturnToScene ? " with-scene-return" : ""}`}>
      <ModelOptimizerHeader locale={locale} onBack={onBack} onViewAssets={() => onViewAssets?.(savedModelId ?? selectedProjectModelId)} onImport={() => inputRef.current?.click()} onDownload={exportGlb} onSave={() => void saveToProjectAssets()} canExport={Boolean(output && !resultOutdated && !busy)} canSave={Boolean(output && !resultOutdated && project && !busy && !savedModelId)} saved={Boolean(savedModelId && !resultOutdated && !busy)} busy={busy} />
      <ModelAssetWorkflowActions locale={locale} busy={busy} savedModelId={resultOutdated ? undefined : savedModelId} onReturn={onReturnToScene} />
      <main className="optimizer-layout">
        <aside className={`optimizer-settings ${file || busy ? "" : "awaiting-model"}`}>
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
          {sourceModel && <ModelAssetCredit model={sourceModel} locale={locale} />}
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
          <ModelOptimizerBaking locale={locale} options={options} setOptions={setOptions} selectedBakeLightId={selectedBakeLightId} setSelectedBakeLightId={setSelectedBakeLightId} bakeTransformMode={bakeTransformMode} setBakeTransformMode={setBakeTransformMode} updateBakeLight={updateBakeLight} />
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
          <button className={`optimizer-run ${busy ? "cancel" : ""}`} disabled={!file && !busy} onClick={() => (busy ? cancelProcessing() : void runOptimization())}>
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
              locale={locale}
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
      <input ref={inputRef} hidden type="file" accept={ACCEPTED_MODELS} onChange={(event) => { const next = event.target.files?.[0]; event.target.value = ""; void importFile(next); }} />
    </div>
  );
}
