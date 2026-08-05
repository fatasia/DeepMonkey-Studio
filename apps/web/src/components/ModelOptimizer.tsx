import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Box, Crosshair, Download, Gauge, Image, Lightbulb, LoaderCircle, Move3D, Plus, Rotate3D, Sparkles, Trash2, Triangle, Upload } from "lucide-react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  inspectModelFile,
  optimizeModelFile,
  DEFAULT_BAKE_LIGHTS,
  type BakeLightState,
  type BakeLightType,
  type ModelFileStatistics,
  type ModelOptimizationOptions
} from "../optimizer/modelOptimizer";
import { translate as tr, type AppLocale } from "../i18n";

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
  bakeLights: structuredClone(DEFAULT_BAKE_LIGHTS),
  lightmapResolution: 512,
  lightmapAmbientOcclusion: true,
  lightmapAoSamples: 4,
  lightmapShadows: true,
  origin: "ground",
  removeUnused: true
};

type BakeTransformMode = "translate" | "rotate";

export function ModelOptimizer({ locale, onBack }: { locale: AppLocale; onBack: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceUrlRef = useRef<string | undefined>(undefined);
  const optimizedUrlRef = useRef<string | undefined>(undefined);
  const optimizedOptionsRef = useRef<string | undefined>(undefined);
  const [file, setFile] = useState<File>();
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [optimizedUrl, setOptimizedUrl] = useState<string>();
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [before, setBefore] = useState<ModelFileStatistics>();
  const [after, setAfter] = useState<ModelFileStatistics>();
  const [output, setOutput] = useState<Uint8Array<ArrayBuffer>>();
  const [showOptimized, setShowOptimized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("导入 GLB 或内嵌资源的 glTF 开始优化");
  const [error, setError] = useState<string>();
  const [selectedBakeLightId, setSelectedBakeLightId] = useState(DEFAULT_BAKE_LIGHTS[0]?.id);
  const [bakeTransformMode, setBakeTransformMode] = useState<BakeTransformMode>("translate");

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
      range: 20
    };
    setOptions((current) => ({ ...current, bakeLights: [...current.bakeLights, light] }));
    setSelectedBakeLightId(light.id);
  }

  function updateBakeLight(id: string, patch: Partial<BakeLightState>) {
    setOptions((current) => ({ ...current, bakeLights: current.bakeLights.map((light) => light.id === id ? { ...light, ...patch } : light) }));
  }

  useEffect(() => () => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    if (optimizedUrlRef.current) URL.revokeObjectURL(optimizedUrlRef.current);
  }, []);

  async function importFile(next?: File) {
    if (!next) return;
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    if (optimizedUrlRef.current) URL.revokeObjectURL(optimizedUrlRef.current);
    const url = URL.createObjectURL(next);
    sourceUrlRef.current = url;
    optimizedUrlRef.current = undefined;
    optimizedOptionsRef.current = undefined;
    setFile(next);
    setSourceUrl(url);
    setOptimizedUrl(undefined);
    setOutput(undefined);
    setAfter(undefined);
    setShowOptimized(false);
    setBusy(true);
    setMessage("正在分析模型");
    setError(undefined);
    try {
      setBefore(await inspectModelFile(next));
      setMessage("模型已载入，可调整参数后开始优化");
    } catch (reason) {
      setError(errorMessage(reason, locale));
      setMessage("模型解析失败");
    } finally {
      setBusy(false);
    }
  }

  async function runOptimization() {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await optimizeModelFile(file, options, setMessage);
      const blob = new Blob([result.binary], { type: "model/gltf-binary" });
      if (optimizedUrlRef.current) URL.revokeObjectURL(optimizedUrlRef.current);
      const url = URL.createObjectURL(blob);
      optimizedUrlRef.current = url;
      optimizedOptionsRef.current = JSON.stringify(options);
      setBefore(result.before);
      setAfter(result.after);
      setOutput(result.binary);
      setOptimizedUrl(url);
      setShowOptimized(true);
      setMessage(result.lightmap
        ? `优化完成，已生成 ${result.lightmap.resolution}×${result.lightmap.resolution} 光照贴图，覆盖 ${result.lightmap.coveredTexels.toLocaleString()} 像素`
        : `优化完成，体积减少 ${reduction(result.before.bytes, result.after.bytes)}%`);
    } catch (reason) {
      setError(errorMessage(reason, locale));
      setMessage("优化失败，原始文件未修改");
    } finally {
      setBusy(false);
    }
  }

  function applyBakePreset(preset: "outdoor" | "indoor") {
    const lights: BakeLightState[] = preset === "outdoor" ? structuredClone(DEFAULT_BAKE_LIGHTS) : [
      { ...structuredClone(DEFAULT_BAKE_LIGHTS[0]!), id: "bake-indoor-key", name: tr(locale, "室内主光", "Indoor key"), intensity: 0.65, direction: [0.45, 0.75, 0.48] },
      { ...structuredClone(DEFAULT_BAKE_LIGHTS[0]!), id: "bake-indoor-fill", name: tr(locale, "室内补光", "Indoor fill"), color: "#b8d8ff", intensity: 0.35, direction: [-0.55, 0.5, -0.35] }
    ];
    setOptions((current) => ({ ...current, bakeEnabled: true, bakeStrength: preset === "outdoor" ? 0.35 : 0.45, bakeAmbient: preset === "outdoor" ? 0.28 : 0.42, bakeLights: lights }));
    setSelectedBakeLightId(lights[0]?.id);
    setBakeTransformMode("translate");
  }

  function exportGlb() {
    if (!output || !file) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([output], { type: "model/gltf-binary" }));
    link.download = `${file.name.replace(/\.(glb|gltf)$/i, "")}.optimized.glb`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  }

  const optionsFingerprint = JSON.stringify(options);
  const resultOutdated = Boolean(output && optimizedOptionsRef.current !== optionsFingerprint);
  useEffect(() => {
    if (resultOutdated) setShowOptimized(false);
  }, [resultOutdated]);
  const previewUrl = showOptimized && optimizedUrl && !resultOutdated ? optimizedUrl : sourceUrl;
  const displayMessage = localizeOptimizerMessage(locale, message);
  return <div className="optimizer-page">
    <header className="optimizer-header">
      <button className="optimizer-back" onClick={onBack}><ArrowLeft size={17} />{tr(locale, "返回场景管理", "Back to scenes")}</button>
      <div><span className="eyebrow">LOCAL GLB PIPELINE</span><h1>{tr(locale, "模型压缩优化", "Model optimization")}</h1></div>
      <div className="optimizer-header-actions">
        <button onClick={() => inputRef.current?.click()}><Upload size={15} />{tr(locale, "导入模型", "Import model")}</button>
        <button className="primary" disabled={!output || resultOutdated} onClick={exportGlb}><Download size={15} />{tr(locale, "导出 GLB", "Export GLB")}</button>
      </div>
    </header>
    <main className="optimizer-layout">
      <aside className="optimizer-settings">
        <div className="optimizer-file">
          <Box size={18} /><div><strong>{file?.name ?? tr(locale, "尚未导入模型", "No model imported")}</strong><span>{before ? `${formatBytes(before.bytes)} · ${before.triangles.toLocaleString(locale)} ${tr(locale, "面", "triangles")}` : tr(locale, "支持 GLB / glTF", "Supports GLB / glTF")}</span></div>
        </div>
        <OptionSection icon={<Triangle size={15} />} title={tr(locale, "模型减面", "Mesh simplification")} enabled={options.simplifyEnabled} onToggle={(enabled) => setOptions({ ...options, simplifyEnabled: enabled })}>
          <label><span>{tr(locale, "目标保留比例", "Target ratio")}</span><output>{Math.round(options.simplifyRatio * 100)}%</output><input type="range" min="0.05" max="1" step="0.01" value={options.simplifyRatio} onChange={(event) => setOptions({ ...options, simplifyRatio: Number(event.target.value) })} /></label>
          <label><span>{tr(locale, "最大误差", "Maximum error")}</span><output>{(options.simplifyError * 100).toFixed(2)}%</output><input type="range" min="0.0001" max="0.02" step="0.0001" value={options.simplifyError} onChange={(event) => setOptions({ ...options, simplifyError: Number(event.target.value) })} /></label>
        </OptionSection>
        <OptionSection icon={<Sparkles size={15} />} title={tr(locale, "Draco 压缩", "Draco compression")} enabled={options.dracoEnabled} onToggle={(enabled) => setOptions({ ...options, dracoEnabled: enabled })}><p>{tr(locale, "压缩顶点、法线和索引；Viewer 已内置 Draco 解码器。", "Compresses vertices, normals and indices; the viewer includes a Draco decoder.")}</p></OptionSection>
        <OptionSection icon={<Image size={15} />} title={tr(locale, "压缩贴图", "Texture compression")} enabled={options.textureEnabled} onToggle={(enabled) => setOptions({ ...options, textureEnabled: enabled })}>
          <div className="optimizer-selects"><label><span>{tr(locale, "最大尺寸", "Maximum size")}</span><select value={options.textureSize} onChange={(event) => setOptions({ ...options, textureSize: Number(event.target.value) })}><option value="512">512</option><option value="1024">1024</option><option value="2048">2048</option><option value="4096">4096</option></select></label><label><span>{tr(locale, "输出格式", "Output format")}</span><select value={options.textureFormat} onChange={(event) => setOptions({ ...options, textureFormat: event.target.value as ModelOptimizationOptions["textureFormat"] })}><option value="webp">WebP</option><option value="jpeg">JPEG</option><option value="original">{tr(locale, "保持原格式", "Keep original")}</option></select></label></div>
        </OptionSection>
        <OptionSection icon={<Lightbulb size={15} />} title={tr(locale, "轻量光照烘焙", "Lightweight light baking")} enabled={options.bakeEnabled} onToggle={(enabled) => setOptions({ ...options, bakeEnabled: enabled })}>
          <div className="optimizer-bake-mode"><button className={options.bakeMode === "vertex" ? "active" : ""} onClick={() => setOptions({ ...options, bakeMode: "vertex" })}>{tr(locale, "快速顶点色", "Vertex color")}</button><button className={options.bakeMode === "lightmap" ? "active" : ""} onClick={() => setOptions({ ...options, bakeMode: "lightmap" })}>{tr(locale, "Web 光照贴图", "Web lightmap")}</button></div>
          {options.bakeMode === "lightmap" && <div className="optimizer-lightmap-settings">
            <label><span>{tr(locale, "贴图分辨率", "Resolution")}</span><select value={options.lightmapResolution} onChange={(event) => setOptions({ ...options, lightmapResolution: Number(event.target.value) as ModelOptimizationOptions["lightmapResolution"] })}><option value="256">256²</option><option value="512">512²</option><option value="1024">1024²</option></select></label>
            <label><span>{tr(locale, "环境遮蔽 AO", "Ambient occlusion")}</span><button className={options.lightmapAmbientOcclusion ? "active" : ""} onClick={() => setOptions({ ...options, lightmapAmbientOcclusion: !options.lightmapAmbientOcclusion })}>{options.lightmapAmbientOcclusion ? tr(locale, "开启", "On") : tr(locale, "关闭", "Off")}</button></label>
            <label><span>{tr(locale, "静态阴影", "Static shadows")}</span><button className={options.lightmapShadows ? "active" : ""} onClick={() => setOptions({ ...options, lightmapShadows: !options.lightmapShadows })}>{options.lightmapShadows ? tr(locale, "开启", "On") : tr(locale, "关闭", "Off")}</button></label>
            <label><span>{tr(locale, "AO 采样", "AO samples")}</span><select value={options.lightmapAoSamples} disabled={!options.lightmapAmbientOcclusion} onChange={(event) => setOptions({ ...options, lightmapAoSamples: Number(event.target.value) as ModelOptimizationOptions["lightmapAoSamples"] })}><option value="4">4 · {tr(locale, "快速", "Fast")}</option><option value="8">8 · {tr(locale, "精细", "Fine")}</option></select></label>
          </div>}
          <div className="optimizer-bake-presets"><span>{tr(locale, "快速预设", "Presets")}</span><button onClick={() => applyBakePreset("outdoor")}>{tr(locale, "自然日光", "Daylight")}</button><button onClick={() => applyBakePreset("indoor")}>{tr(locale, "室内均匀", "Indoor")}</button></div>
          <label><span>{tr(locale, "烘焙强度", "Bake strength")}</span><output>{Math.round(options.bakeStrength * 100)}%</output><input type="range" min="0.05" max="0.8" step="0.05" value={options.bakeStrength} onChange={(event) => setOptions({ ...options, bakeStrength: Number(event.target.value) })} /></label>
          <label><span>{tr(locale, "环境亮度", "Ambient level")}</span><output>{Math.round(options.bakeAmbient * 100)}%</output><input type="range" min="0" max="1" step="0.05" value={options.bakeAmbient} onChange={(event) => setOptions({ ...options, bakeAmbient: Number(event.target.value) })} /></label>
          <div className="optimizer-bake-head"><span>{tr(locale, "烘焙光源", "Bake lights")}</span><div><button onClick={() => addBakeLight("directional")}><Plus size={11} />{tr(locale, "方向光", "Directional")}</button><button onClick={() => addBakeLight("point")}><Plus size={11} />{tr(locale, "点光", "Point")}</button></div></div>
          {selectedBakeLightId && <div className="optimizer-bake-transform"><span>{tr(locale, "场景操控", "Gizmo")}</span><button className={bakeTransformMode === "translate" ? "active" : ""} onClick={() => setBakeTransformMode("translate")}><Move3D size={11} />{tr(locale, "移动", "Move")}</button><button className={bakeTransformMode === "rotate" ? "active" : ""} disabled={options.bakeLights.find((light) => light.id === selectedBakeLightId)?.type !== "directional"} onClick={() => setBakeTransformMode("rotate")}><Rotate3D size={11} />{tr(locale, "旋转", "Rotate")}</button></div>}
          <div className="optimizer-bake-list">{options.bakeLights.map((light) => <article key={light.id} className={`${!light.enabled ? "disabled" : ""} ${selectedBakeLightId === light.id ? "selected" : ""}`} onClick={() => setSelectedBakeLightId(light.id)}>
            <header><button className={`optimizer-bake-enable ${light.enabled ? "active" : ""}`} onClick={() => updateBakeLight(light.id, { enabled: !light.enabled })}><i /></button><input value={light.name} onChange={(event) => updateBakeLight(light.id, { name: event.target.value })} /><span>{light.type === "directional" ? tr(locale, "方向", "DIR") : tr(locale, "点光", "POINT")}</span><button className="danger" onClick={(event) => { event.stopPropagation(); setOptions((current) => ({ ...current, bakeLights: current.bakeLights.filter((item) => item.id !== light.id) })); if (selectedBakeLightId === light.id) setSelectedBakeLightId(undefined); }}><Trash2 size={11} /></button></header>
            <div className="optimizer-bake-main"><input type="color" value={light.color} onChange={(event) => updateBakeLight(light.id, { color: event.target.value })} /><label><span>{tr(locale, "强度", "Intensity")}</span><input type="number" min="0" max="8" step="0.05" value={light.intensity} onChange={(event) => updateBakeLight(light.id, { intensity: Number(event.target.value) })} /></label>{light.type === "point" && <label><span>{tr(locale, "范围", "Range")}</span><input type="number" min="0.1" step="0.5" value={light.range} onChange={(event) => updateBakeLight(light.id, { range: Number(event.target.value) })} /></label>}</div>
            <BakeVector locale={locale} label={light.type === "directional" ? tr(locale, "照射方向", "Direction") : tr(locale, "模型坐标", "Model position")} value={light.type === "directional" ? light.direction : light.position} onChange={(value) => updateBakeLight(light.id, light.type === "directional" ? { direction: value } : { position: value })} />
          </article>)}</div>
          <p>{options.bakeMode === "vertex" ? tr(locale, "把环境光、方向光和点光漫反射写入顶点色，速度快、文件增量小。", "Writes diffuse lighting into vertex colors for fast, compact output.") : tr(locale, "浏览器内生成 TEXCOORD_1 + PNG 遮蔽贴图，包含 AO、静态阴影和边缘扩张；作为标准 glTF 遮蔽纹理写入 GLB，不包含多次反弹 GI。", "Generates TEXCOORD_1 and a PNG occlusion lightmap with AO, static shadows, and edge dilation; stored in standard glTF without multi-bounce GI.")}</p>
        </OptionSection>
        <OptionSection icon={<Crosshair size={15} />} title={tr(locale, "设置原点", "Set origin")}>
          <div className="origin-options">{([['keep',tr(locale, '保持', 'Keep')],['center',tr(locale, '模型中心', 'Model center')],['ground',tr(locale, '底部中心', 'Bottom center')]] as const).map(([value, label]) => <button key={value} className={options.origin === value ? "active" : ""} onClick={() => setOptions({ ...options, origin: value })}>{label}</button>)}</div>
        </OptionSection>
        <OptionSection icon={<Trash2 size={15} />} title={tr(locale, "删除无用数据", "Remove unused data")} enabled={options.removeUnused} onToggle={(enabled) => setOptions({ ...options, removeUnused: enabled })}><p>{tr(locale, "合并重复数据、焊接重复点，并清理未引用节点、材质和访问器。", "Deduplicates data, welds vertices and removes unused nodes, materials and accessors.")}</p></OptionSection>
        <button className="optimizer-run" disabled={!file || busy} onClick={() => void runOptimization()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Gauge size={16} />}{busy ? displayMessage : tr(locale, "开始优化", "Start optimization")}</button>
      </aside>
      <section className="optimizer-preview">
        <div className="optimizer-preview-toolbar">
          <div>{optimizedUrl && <><button className={!showOptimized ? "active" : ""} onClick={() => setShowOptimized(false)}>{tr(locale, "原始模型", "Original")}</button><button className={showOptimized ? "active" : ""} disabled={resultOutdated} onClick={() => setShowOptimized(true)}>{tr(locale, "优化结果", "Optimized")}</button></>}</div>
          <span>{resultOutdated ? tr(locale, "参数已变化，请重新优化生成结果", "Options changed; run optimization again") : displayMessage}</span>
        </div>
        {previewUrl ? <OptimizerPreview url={previewUrl} bakeEnabled={options.bakeEnabled && !showOptimized} ambient={options.bakeAmbient} lights={options.bakeLights} selectedLightId={selectedBakeLightId} transformMode={bakeTransformMode} onSelectLight={(id) => { setSelectedBakeLightId(id); const selected = options.bakeLights.find((light) => light.id === id); if (selected?.type === "point") setBakeTransformMode("translate"); }} onUpdateLight={updateBakeLight} /> : <button className="optimizer-drop" onClick={() => inputRef.current?.click()}><Upload size={32} /><strong>{tr(locale, "导入模型开始", "Import a model to begin")}</strong><span>{tr(locale, "所有处理均在当前浏览器本地完成", "All processing runs locally in this browser")}</span></button>}
        {error && <div className="optimizer-error">{error}</div>}
        {(before || after) && <div className="optimizer-statistics"><Stat locale={locale} label={tr(locale, "文件大小", "File size")} before={before ? formatBytes(before.bytes) : "—"} after={after ? formatBytes(after.bytes) : undefined} /><Stat locale={locale} label={tr(locale, "三角面", "Triangles")} before={before?.triangles.toLocaleString(locale) ?? "—"} after={after?.triangles.toLocaleString(locale)} /><Stat locale={locale} label={tr(locale, "顶点", "Vertices")} before={before?.vertices.toLocaleString(locale) ?? "—"} after={after?.vertices.toLocaleString(locale)} /><Stat locale={locale} label={tr(locale, "节点 / 材质", "Nodes / materials")} before={before ? `${before.nodes} / ${before.materials}` : "—"} after={after ? `${after.nodes} / ${after.materials}` : undefined} /></div>}
      </section>
    </main>
    <div className="app-copyright">Copyright © 张文鹏 Charlie</div>
    <input ref={inputRef} hidden type="file" accept=".glb,.gltf" onChange={(event) => void importFile(event.target.files?.[0])} />
  </div>;
}

function OptionSection({ icon, title, enabled, onToggle, children }: { icon: React.ReactNode; title: string; enabled?: boolean; onToggle?: (enabled: boolean) => void; children: React.ReactNode }) {
  return <section className={`optimizer-option ${enabled === false ? "disabled" : ""}`}><div className="optimizer-option-head">{icon}<strong>{title}</strong>{onToggle && <button className={`toggle ${enabled ? "on" : ""}`} onClick={() => onToggle(!enabled)}><i /></button>}</div><div className="optimizer-option-body">{children}</div></section>;
}

function BakeVector({ locale, label, value, onChange }: { locale: AppLocale; label: string; value: [number, number, number]; onChange: (value: [number, number, number]) => void }) {
  return <div className="optimizer-bake-vector"><span>{label}</span>{value.map((coordinate, index) => <label key={index}><i>{["X", "Y", "Z"][index]}</i><input aria-label={`${label} ${["X", "Y", "Z"][index]}`} type="number" step="0.25" value={coordinate} onChange={(event) => { const next = [...value] as [number, number, number]; next[index] = Number(event.target.value); onChange(next); }} /></label>)}<small>{tr(locale, "局部", "Local")}</small></div>;
}

function Stat({ locale, label, before, after }: { locale: AppLocale; label: string; before: string; after: string | undefined }) {
  return <div><span>{label}</span><strong>{after ?? before}</strong>{after && <small>{tr(locale, "原始", "Original")} {before}</small>}</div>;
}

interface OptimizerPreviewRuntime {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  transform: TransformControls;
  defaultLights: THREE.Light[];
  ambient: THREE.AmbientLight;
  lights: Map<string, { state: BakeLightState; light: THREE.Light; proxy: THREE.Group }>;
  center: THREE.Vector3;
  radius: number;
  modelBounds?: THREE.Box3;
}

function OptimizerPreview({ url, bakeEnabled, ambient, lights, selectedLightId, transformMode, onSelectLight, onUpdateLight }: {
  url: string;
  bakeEnabled: boolean;
  ambient: number;
  lights: BakeLightState[];
  selectedLightId: string | undefined;
  transformMode: BakeTransformMode;
  onSelectLight: (id: string | undefined) => void;
  onUpdateLight: (id: string, patch: Partial<BakeLightState>) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<OptimizerPreviewRuntime | undefined>(undefined);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const propsRef = useRef({ bakeEnabled, ambient, lights, selectedLightId, transformMode, onSelectLight, onUpdateLight });
  propsRef.current = { bakeEnabled, ambient, lights, selectedLightId, transformMode, onSelectLight, onUpdateLight };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setLoadState("loading");
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111518);
    const hemisphere = new THREE.HemisphereLight(0xe8f2ff, 0x36404a, 2);
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(5, 10, 7);
    scene.add(hemisphere, keyLight);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100_000);
    camera.position.set(5, 4, 5);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const transform = new TransformControls(camera, renderer.domElement);
    transform.setMode("translate");
    scene.add(transform.getHelper());
    const ambientLight = new THREE.AmbientLight(0xffffff, 0);
    scene.add(ambientLight);
    const runtime: OptimizerPreviewRuntime = { scene, camera, controls, transform, defaultLights: [hemisphere, keyLight], ambient: ambientLight, lights: new Map(), center: new THREE.Vector3(), radius: 5 };
    runtimeRef.current = runtime;
    transform.addEventListener("dragging-changed", (event) => { controls.enabled = !event.value; });
    transform.addEventListener("objectChange", () => updateDraggedBakeLight(runtime));
    transform.addEventListener("mouseUp", () => commitDraggedBakeLight(runtime, propsRef.current.onUpdateLight));
    const grid = new THREE.GridHelper(30, 30, 0x394249, 0x252c31);
    scene.add(grid);
    const dracoLoader = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    const loader = new GLTFLoader().setDRACOLoader(dracoLoader);
    let model: THREE.Object3D | undefined;
    let frame = 0;
    let disposed = false;
    void loader.loadAsync(url).then((gltf) => {
      if (disposed) return;
      model = gltf.scene;
      scene.add(model);
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
      runtime.modelBounds = box.clone();
      runtime.center.copy(center);
      runtime.radius = Math.max(size * 0.5, 1);
      frameOptimizerCamera(runtime);
      syncOptimizerPreviewLights(runtime, propsRef.current);
      setLoadState("ready");
    }).catch(() => { if (!disposed) setLoadState("error"); });
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const selectLight = (event: PointerEvent) => {
      if (transform.dragging || transform.axis) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const roots = [...runtime.lights.values()].map((entry) => entry.proxy);
      let object: THREE.Object3D | null | undefined = raycaster.intersectObjects(roots, true)[0]?.object;
      while (object && !object.userData.bakeLightId) object = object.parent;
      if (object?.userData.bakeLightId) propsRef.current.onSelectLight(String(object.userData.bakeLightId));
    };
    renderer.domElement.addEventListener("pointerdown", selectLight);
    const resize = new ResizeObserver(() => {
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    resize.observe(container);
    const animate = () => { frame = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); };
    animate();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      transform.dispose();
      dracoLoader.dispose();
      renderer.domElement.removeEventListener("pointerdown", selectLight);
      clearOptimizerPreviewLights(runtime);
      if (model) disposeModel(model);
      renderer.dispose();
      renderer.domElement.remove();
      if (runtimeRef.current === runtime) runtimeRef.current = undefined;
    };
  }, [url]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime) syncOptimizerPreviewLights(runtime, { bakeEnabled, ambient, lights, selectedLightId, transformMode });
  }, [ambient, bakeEnabled, lights, selectedLightId, transformMode]);
  return <div className="optimizer-canvas" ref={containerRef}><button className="optimizer-fit-view" title="适应窗口" onClick={() => { const runtime = runtimeRef.current; if (runtime) frameOptimizerCamera(runtime); }}><Crosshair size={13} />适应窗口</button>{loadState !== "ready" && <div className={`optimizer-preview-state ${loadState}`}><LoaderCircle className={loadState === "loading" ? "spin" : ""} size={18} />{loadState === "loading" ? "正在载入预览" : "预览载入失败，请检查导出的 GLB"}</div>}</div>;
}

function frameOptimizerCamera(runtime: OptimizerPreviewRuntime) {
  const bounds = runtime.modelBounds;
  if (!bounds || bounds.isEmpty()) return;
  const center = bounds.getCenter(new THREE.Vector3());
  const dimensions = bounds.getSize(new THREE.Vector3());
  const verticalFov = THREE.MathUtils.degToRad(runtime.camera.fov);
  const fitHeight = Math.max(dimensions.y, dimensions.x / Math.max(runtime.camera.aspect, 0.1));
  const depth = Math.max(dimensions.z, Math.max(dimensions.x, dimensions.y) * 0.15);
  const modelScale = Math.max(dimensions.x, dimensions.y, dimensions.z, 0.0001);
  const distance = Math.max(fitHeight / (2 * Math.tan(verticalFov / 2)) + depth * 0.5, modelScale * 0.8) * 1.2;
  const direction = runtime.camera.position.clone().sub(runtime.controls.target);
  if (direction.lengthSq() < 0.0001) direction.set(1, 0.7, 1);
  direction.normalize();
  runtime.controls.target.copy(center);
  runtime.camera.position.copy(center).addScaledVector(direction, distance);
  runtime.camera.near = Math.max(distance / 10_000, 0.001);
  runtime.camera.far = Math.max(distance * 100, depth * 100, 1_000);
  runtime.camera.updateProjectionMatrix();
  runtime.controls.update();
}

function syncOptimizerPreviewLights(runtime: OptimizerPreviewRuntime, props: { bakeEnabled: boolean; ambient: number; lights: BakeLightState[]; selectedLightId: string | undefined; transformMode: BakeTransformMode }) {
  runtime.transform.detach();
  clearOptimizerPreviewLights(runtime);
  for (const light of runtime.defaultLights) light.visible = !props.bakeEnabled;
  runtime.ambient.visible = props.bakeEnabled;
  runtime.ambient.intensity = props.ambient * 2.2;
  if (!props.bakeEnabled) return;
  for (const state of props.lights) {
    const color = new THREE.Color(state.color);
    let light: THREE.Light;
    const proxyPosition = new THREE.Vector3();
    if (state.type === "point") {
      const point = new THREE.PointLight(color, state.intensity * 2.2, Math.max(0.1, state.range), 2);
      proxyPosition.fromArray(state.position);
      light = point;
    } else {
      const directional = new THREE.DirectionalLight(color, state.intensity * 2.2);
      const direction = new THREE.Vector3().fromArray(state.direction).normalize();
      proxyPosition.copy(runtime.center).addScaledVector(direction, runtime.radius * 1.25);
      directional.target.position.copy(runtime.center);
      runtime.scene.add(directional.target);
      light = directional;
    }
    light.position.copy(proxyPosition);
    light.visible = state.enabled;
    runtime.scene.add(light);
    const proxy = createBakeLightProxy(state, proxyPosition, runtime.radius);
    if (state.type === "directional") orientDirectionalProxy(proxy, new THREE.Vector3().fromArray(state.direction));
    proxy.visible = state.enabled;
    runtime.scene.add(proxy);
    runtime.lights.set(state.id, { state, light, proxy });
  }
  const selected = props.selectedLightId ? runtime.lights.get(props.selectedLightId) : undefined;
  if (selected?.state.enabled) {
    runtime.transform.setMode(selected.state.type === "directional" ? props.transformMode : "translate");
    runtime.transform.attach(selected.proxy);
  }
}

function createBakeLightProxy(state: BakeLightState, position: THREE.Vector3, radius: number): THREE.Group {
  const proxy = new THREE.Group();
  proxy.name = `bake-light-proxy:${state.id}`;
  proxy.position.copy(position);
  proxy.userData.bakeLightId = state.id;
  const scale = THREE.MathUtils.clamp(radius * 0.045, 0.18, 1.2);
  const body = state.type === "point"
    ? new THREE.Mesh(new THREE.SphereGeometry(scale, 18, 12), new THREE.MeshBasicMaterial({ color: state.color, depthTest: false }))
    : new THREE.Mesh(new THREE.ConeGeometry(scale * 0.72, scale * 1.6, 18), new THREE.MeshBasicMaterial({ color: state.color, depthTest: false }));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(scale * 1.35, scale * 0.09, 6, 30), new THREE.MeshBasicMaterial({ color: 0xd4a84f, wireframe: true, depthTest: false }));
  body.renderOrder = ring.renderOrder = 1000;
  proxy.add(body, ring);
  proxy.traverse((object) => { object.userData.bakeLightId = state.id; });
  return proxy;
}

function updateDraggedBakeLight(runtime: OptimizerPreviewRuntime) {
  const proxy = runtime.transform.object;
  const id = proxy?.userData.bakeLightId as string | undefined;
  const entry = id ? runtime.lights.get(id) : undefined;
  if (!entry || !proxy) return;
  if (entry.light instanceof THREE.DirectionalLight && runtime.transform.getMode() === "rotate") {
    const direction = directionFromProxy(proxy);
    entry.light.position.copy(runtime.center).addScaledVector(direction, runtime.radius * 1.25);
  } else {
    entry.light.position.copy(proxy.position);
  }
  if (entry.light instanceof THREE.DirectionalLight) entry.light.target.position.copy(runtime.center);
}

function commitDraggedBakeLight(runtime: OptimizerPreviewRuntime, onUpdateLight: (id: string, patch: Partial<BakeLightState>) => void) {
  const proxy = runtime.transform.object;
  const id = proxy?.userData.bakeLightId as string | undefined;
  const entry = id ? runtime.lights.get(id) : undefined;
  if (!entry || !proxy) return;
  if (entry.state.type === "point") onUpdateLight(id!, { position: proxy.position.toArray() as [number, number, number] });
  else {
    const direction = runtime.transform.getMode() === "rotate" ? directionFromProxy(proxy) : proxy.position.clone().sub(runtime.center).normalize();
    onUpdateLight(id!, { direction: direction.toArray() as [number, number, number] });
  }
}

const PROXY_FORWARD = new THREE.Vector3(0, 1, 0);

function orientDirectionalProxy(proxy: THREE.Object3D, direction: THREE.Vector3) {
  proxy.quaternion.setFromUnitVectors(PROXY_FORWARD, direction.normalize());
}

function directionFromProxy(proxy: THREE.Object3D): THREE.Vector3 {
  return PROXY_FORWARD.clone().applyQuaternion(proxy.quaternion).normalize();
}

function clearOptimizerPreviewLights(runtime: OptimizerPreviewRuntime) {
  for (const entry of runtime.lights.values()) {
    if (entry.light instanceof THREE.DirectionalLight) entry.light.target.removeFromParent();
    entry.light.removeFromParent();
    entry.proxy.removeFromParent();
    disposeModel(entry.proxy);
  }
  runtime.lights.clear();
}

function disposeModel(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) material.dispose();
  });
}

function reduction(before: number, after: number) { return Math.max(0, Math.round((1 - after / before) * 100)); }
function formatBytes(bytes: number) { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`; }
function errorMessage(reason: unknown, locale: AppLocale) { return reason instanceof Error ? reason.message : tr(locale, "模型处理失败", "Model processing failed"); }
function localizeOptimizerMessage(locale: AppLocale, message: string) {
  if (locale === "zh-CN") return message;
  if (message.startsWith("优化完成，体积减少 ")) return message.replace("优化完成，体积减少 ", "Optimization complete; size reduced by ");
  const messages: Record<string, string> = {
    "导入 GLB 或内嵌资源的 glTF 开始优化": "Import a GLB or embedded glTF to begin",
    "正在分析模型": "Analyzing model",
    "模型已载入，可调整参数后开始优化": "Model loaded; adjust options and start optimization",
    "模型解析失败": "Model parsing failed",
    "正在烘焙顶点光照": "Baking vertex lighting",
    "正在执行 Draco 压缩": "Applying Draco compression",
    "优化失败，原始文件未修改": "Optimization failed; the source file was not modified"
  };
  return messages[message] ?? message;
}
