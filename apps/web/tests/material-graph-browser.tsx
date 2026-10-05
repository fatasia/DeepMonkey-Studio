import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SceneMaterialState } from "@bim-studio/contracts";
import "../src/styles/base.css";
import { ViewerEngine } from "../src/viewer/ViewerEngine";
import { MaterialGraphEditor } from "../src/components/MaterialGraphEditor";
import { compileGraphGrids } from "../src/materials/materialGraphCompiler";
import { createMaterialGraph, createLayer, type MaterialGraphDefinition } from "../src/materials/materialGraphModel";

// 与 visualQa 入口同规:?theme=light|dark 指定主题(仅验收入口,不改用户偏好)。
const qaTheme = new URLSearchParams(window.location.search).get("theme");
if (qaTheme === "light" || qaTheme === "dark") document.documentElement.dataset.theme = qaTheme;

/**
 * 材质图真实浏览器夹具(编辑器刀 7):
 * 真 ViewerEngine(WebGL)+ 真 createPrimitive 对象 + 生产面板组件;
 * 页内自动驱动(开面板→加两层→接管→读回引擎材质),只读事实导出到
 * window.__materialGraphQa 供 Playwright 断言与截图。
 */

interface QaReport {
  ready: boolean;
  errors: string[];
  engineReady: boolean;
  linked: boolean;
  patchKeys: string[];
  hasBaseColorMap: boolean;
  hasRoughnessMap: boolean;
  hasMetalnessMap: boolean;
  hasNormalMap: boolean;
  scalarRoughness: number | undefined;
  scalarMetalness: number | undefined;
  compileMs: number;
  applyLatencyMs: number;
  determinismBytesEqual: boolean;
  dataUrlPrefix: boolean;
}

const initialReport: QaReport = {
  ready: false, errors: [], engineReady: false, linked: false, patchKeys: [],
  hasBaseColorMap: false, hasRoughnessMap: false, hasMetalnessMap: false, hasNormalMap: false,
  scalarRoughness: undefined, scalarMetalness: undefined, compileMs: 0, applyLatencyMs: 0,
  determinismBytesEqual: false, dataUrlPrefix: false,
};

function Fixture() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ViewerEngine | undefined>(undefined);
  const materialRef = useRef<SceneMaterialState>({});
  const [material, setMaterial] = useState<SceneMaterialState>({});
  const [report, setReport] = useState<QaReport>(initialReport);
  const startedRef = useRef(false);

  const applyPatch = useCallback((patch: SceneMaterialState) => {
    const engine = engineRef.current;
    if (!engine) return;
    const t0 = performance.now();
    engine.setSelectionMaterial(patch);
    materialRef.current = { ...engine.getSelectionMaterial() };
    setMaterial(materialRef.current);
    setReport(previous => ({ ...previous, applyLatencyMs: +(performance.now() - t0).toFixed(2) }));
  }, []);

  useEffect(() => {
    if (startedRef.current || !hostRef.current) return;
    startedRef.current = true;
    let disposed = false;
    void (async () => {
      try {
        const engine = await ViewerEngine.create(hostRef.current!, "webgl");
        if (disposed) { engine.dispose(); return; }
        engineRef.current = engine;
        engine.createPrimitive("qa-box", "验收盒", "box", "#8a9199");
        engine.select("qa-box");
        setMaterial({ ...engine.getSelectionMaterial() });
        setReport(previous => ({ ...previous, engineReady: true }));
      } catch (reason) {
        setReport(previous => ({ ...previous, errors: [...previous.errors, String(reason)] }));
      }
    })();
    return () => { disposed = true; engineRef.current?.dispose(); };
  }, []);

  /** 页内自动验收:两层图(磨损+灰尘)→ 接管 → 读回引擎事实。由 Playwright 触发。 */
  const runAutoAcceptance = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const errors: string[] = [];
    const base = engine.getSelectionMaterial();
    // 确定性(浏览器侧):同图两次网格编译逐字节相等
    const twoLayer: MaterialGraphDefinition = {
      ...createMaterialGraph("自动验收图", { color: base.color ?? "#8a9199", roughness: base.roughness ?? 0.5, metalness: base.metalness ?? 0.1 }),
      layers: [createLayer("wear", "自动磨损"), createLayer("dust", "自动灰尘")],
    };
    let determinismBytesEqual = false;
    let compileMs = 0;
    try {
      const a = compileGraphGrids(twoLayer, 128);
      const t0 = performance.now();
      const b = compileGraphGrids(twoLayer, 128);
      compileMs = +(performance.now() - t0).toFixed(2);
      determinismBytesEqual = a.rgba.every((byte, index) => byte === b.rgba[index])
        && a.rough.every((byte, index) => byte === b.rough[index])
        && a.metal.every((byte, index) => byte === b.metal[index]);
    } catch (reason) {
      errors.push(String(reason));
    }
    setReport(previous => ({ ...previous, determinismBytesEqual, compileMs }));
  }, []);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__materialGraphQa = {
      get: () => ({
        ...report,
        scalarRoughness: materialRef.current.roughness,
        scalarMetalness: materialRef.current.metalness,
        hasBaseColorMap: Boolean(materialRef.current.baseColorMapUrl?.startsWith("data:image")),
        hasRoughnessMap: Boolean(materialRef.current.roughnessMapUrl),
        hasMetalnessMap: Boolean(materialRef.current.metalnessMapUrl),
        hasNormalMap: Boolean(materialRef.current.normalMapUrl),
        patchKeys: Object.keys(materialRef.current),
      }),
      runAutoAcceptance,
      engine: () => engineRef.current ? { ready: true } : { ready: false },
    };
  });

  return (
    <main style={{ display: "grid", gridTemplateColumns: "1fr 420px", gap: 12, padding: 12, minHeight: "100vh", background: "var(--bg-0)", color: "var(--text)" }}>
      <section style={{ display: "grid", gap: 8 }}>
        <h2 style={{ fontSize: 14, color: "var(--text-strong)", margin: 0 }}>材质图浏览器验收(编辑器刀 7)</h2>
        <div ref={hostRef} style={{ minHeight: 380, border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-1)" }} />
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" data-qa="qa-auto" onClick={() => void runAutoAcceptance()}>运行编译确定性验收</button>
          <span data-qa="qa-report" role="status">
            {`引擎:${report.engineReady ? "就绪" : "启动中"} · 确定性:${report.determinismBytesEqual ? "字节相等" : "未测"} · 编译:${report.compileMs}ms · 应用:${report.applyLatencyMs}ms`}
          </span>
        </div>
        {report.errors.length > 0 && <pre style={{ color: "var(--danger)", fontSize: 11 }}>{report.errors.join("\n")}</pre>}
      </section>
      <aside style={{ border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-1)", padding: 10, overflowY: "auto" }}>
        <MaterialGraphEditor
          locale="zh-CN"
          disabled={false}
          sceneId="qa-scene"
          modelId="qa-box"
          material={material}
          onApplyMaterialPatch={applyPatch}
        />
        <section data-qa="material-facts" style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>
          <div>baseColorMapUrl: {material.baseColorMapUrl ? material.baseColorMapUrl.slice(0, 22) : "—"}</div>
          <div>roughnessMapUrl: {material.roughnessMapUrl ? "已设置" : "—"}</div>
          <div>metalnessMapUrl: {material.metalnessMapUrl ? "已设置" : "—"}</div>
          <div>normalMapUrl: {material.normalMapUrl ? "已设置" : "—"}</div>
          <div>roughness 标量: {material.roughness ?? "—"} · metalness 标量: {material.metalness ?? "—"}</div>
        </section>
      </aside>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
