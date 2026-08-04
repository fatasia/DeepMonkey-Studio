import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Box, Crosshair, Download, Gauge, Image, LoaderCircle, Sparkles, Trash2, Triangle, Upload } from "lucide-react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  inspectModelFile,
  optimizeModelFile,
  type ModelFileStatistics,
  type ModelOptimizationOptions
} from "../optimizer/modelOptimizer";

const DEFAULT_OPTIONS: ModelOptimizationOptions = {
  simplifyEnabled: true,
  simplifyRatio: 0.5,
  simplifyError: 0.001,
  dracoEnabled: true,
  textureEnabled: true,
  textureSize: 2048,
  textureFormat: "webp",
  origin: "ground",
  removeUnused: true
};

export function ModelOptimizer({ onBack }: { onBack: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceUrlRef = useRef<string | undefined>(undefined);
  const optimizedUrlRef = useRef<string | undefined>(undefined);
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
      setError(errorMessage(reason));
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
      setBefore(result.before);
      setAfter(result.after);
      setOutput(result.binary);
      setOptimizedUrl(url);
      setShowOptimized(true);
      setMessage(`优化完成，体积减少 ${reduction(result.before.bytes, result.after.bytes)}%`);
    } catch (reason) {
      setError(errorMessage(reason));
      setMessage("优化失败，原始文件未修改");
    } finally {
      setBusy(false);
    }
  }

  function exportGlb() {
    if (!output || !file) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([output], { type: "model/gltf-binary" }));
    link.download = `${file.name.replace(/\.(glb|gltf)$/i, "")}.optimized.glb`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  }

  const previewUrl = showOptimized && optimizedUrl ? optimizedUrl : sourceUrl;
  return <div className="optimizer-page">
    <header className="optimizer-header">
      <button className="optimizer-back" onClick={onBack}><ArrowLeft size={17} />返回场景管理</button>
      <div><span className="eyebrow">LOCAL GLB PIPELINE</span><h1>模型压缩优化</h1></div>
      <div className="optimizer-header-actions">
        <button onClick={() => inputRef.current?.click()}><Upload size={15} />导入模型</button>
        <button className="primary" disabled={!output} onClick={exportGlb}><Download size={15} />导出 GLB</button>
      </div>
    </header>
    <main className="optimizer-layout">
      <aside className="optimizer-settings">
        <div className="optimizer-file">
          <Box size={18} /><div><strong>{file?.name ?? "尚未导入模型"}</strong><span>{before ? `${formatBytes(before.bytes)} · ${before.triangles.toLocaleString("zh-CN")} 面` : "支持 GLB / glTF"}</span></div>
        </div>
        <OptionSection icon={<Triangle size={15} />} title="模型减面" enabled={options.simplifyEnabled} onToggle={(enabled) => setOptions({ ...options, simplifyEnabled: enabled })}>
          <label><span>目标保留比例</span><output>{Math.round(options.simplifyRatio * 100)}%</output><input type="range" min="0.05" max="1" step="0.01" value={options.simplifyRatio} onChange={(event) => setOptions({ ...options, simplifyRatio: Number(event.target.value) })} /></label>
          <label><span>最大误差</span><output>{(options.simplifyError * 100).toFixed(2)}%</output><input type="range" min="0.0001" max="0.02" step="0.0001" value={options.simplifyError} onChange={(event) => setOptions({ ...options, simplifyError: Number(event.target.value) })} /></label>
        </OptionSection>
        <OptionSection icon={<Sparkles size={15} />} title="Draco 压缩" enabled={options.dracoEnabled} onToggle={(enabled) => setOptions({ ...options, dracoEnabled: enabled })}><p>压缩顶点、法线和索引；Viewer 已内置 Draco 解码器。</p></OptionSection>
        <OptionSection icon={<Image size={15} />} title="压缩贴图" enabled={options.textureEnabled} onToggle={(enabled) => setOptions({ ...options, textureEnabled: enabled })}>
          <div className="optimizer-selects"><label><span>最大尺寸</span><select value={options.textureSize} onChange={(event) => setOptions({ ...options, textureSize: Number(event.target.value) })}><option value="512">512</option><option value="1024">1024</option><option value="2048">2048</option><option value="4096">4096</option></select></label><label><span>输出格式</span><select value={options.textureFormat} onChange={(event) => setOptions({ ...options, textureFormat: event.target.value as ModelOptimizationOptions["textureFormat"] })}><option value="webp">WebP</option><option value="jpeg">JPEG</option><option value="original">保持原格式</option></select></label></div>
        </OptionSection>
        <OptionSection icon={<Crosshair size={15} />} title="设置原点">
          <div className="origin-options">{([['keep','保持'],['center','模型中心'],['ground','底部中心']] as const).map(([value, label]) => <button key={value} className={options.origin === value ? "active" : ""} onClick={() => setOptions({ ...options, origin: value })}>{label}</button>)}</div>
        </OptionSection>
        <OptionSection icon={<Trash2 size={15} />} title="删除无用数据" enabled={options.removeUnused} onToggle={(enabled) => setOptions({ ...options, removeUnused: enabled })}><p>合并重复数据、焊接重复点，并清理未引用节点、材质和访问器。</p></OptionSection>
        <button className="optimizer-run" disabled={!file || busy} onClick={() => void runOptimization()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Gauge size={16} />}{busy ? message : "开始优化"}</button>
      </aside>
      <section className="optimizer-preview">
        <div className="optimizer-preview-toolbar">
          <div>{optimizedUrl && <><button className={!showOptimized ? "active" : ""} onClick={() => setShowOptimized(false)}>原始模型</button><button className={showOptimized ? "active" : ""} onClick={() => setShowOptimized(true)}>优化结果</button></>}</div>
          <span>{message}</span>
        </div>
        {previewUrl ? <OptimizerPreview url={previewUrl} /> : <button className="optimizer-drop" onClick={() => inputRef.current?.click()}><Upload size={32} /><strong>导入模型开始</strong><span>所有处理均在当前浏览器本地完成</span></button>}
        {error && <div className="optimizer-error">{error}</div>}
        {(before || after) && <div className="optimizer-statistics"><Stat label="文件大小" before={before ? formatBytes(before.bytes) : "—"} after={after ? formatBytes(after.bytes) : undefined} /><Stat label="三角面" before={before?.triangles.toLocaleString("zh-CN") ?? "—"} after={after?.triangles.toLocaleString("zh-CN")} /><Stat label="顶点" before={before?.vertices.toLocaleString("zh-CN") ?? "—"} after={after?.vertices.toLocaleString("zh-CN")} /><Stat label="节点 / 材质" before={before ? `${before.nodes} / ${before.materials}` : "—"} after={after ? `${after.nodes} / ${after.materials}` : undefined} /></div>}
      </section>
    </main>
    <input ref={inputRef} hidden type="file" accept=".glb,.gltf" onChange={(event) => void importFile(event.target.files?.[0])} />
  </div>;
}

function OptionSection({ icon, title, enabled, onToggle, children }: { icon: React.ReactNode; title: string; enabled?: boolean; onToggle?: (enabled: boolean) => void; children: React.ReactNode }) {
  return <section className={`optimizer-option ${enabled === false ? "disabled" : ""}`}><div className="optimizer-option-head">{icon}<strong>{title}</strong>{onToggle && <button className={`toggle ${enabled ? "on" : ""}`} onClick={() => onToggle(!enabled)}><i /></button>}</div><div className="optimizer-option-body">{children}</div></section>;
}

function Stat({ label, before, after }: { label: string; before: string; after: string | undefined }) {
  return <div><span>{label}</span><strong>{after ?? before}</strong>{after && <small>原始 {before}</small>}</div>;
}

function OptimizerPreview({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111518);
    scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x36404a, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2.2);
    light.position.set(5, 10, 7);
    scene.add(light);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100_000);
    camera.position.set(5, 4, 5);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
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
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(1, .7, 1).normalize().multiplyScalar(size * 1.3));
      camera.near = Math.max(size / 10000, .001);
      camera.far = Math.max(size * 100, 1000);
      camera.updateProjectionMatrix();
      controls.update();
    });
    const resize = new ResizeObserver(() => {
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      renderer.setSize(width, height, false);
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
      dracoLoader.dispose();
      if (model) disposeModel(model);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url]);
  return <div className="optimizer-canvas" ref={containerRef} />;
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
function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : "模型处理失败"; }
