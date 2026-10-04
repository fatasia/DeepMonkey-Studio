import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SceneModelEffectsState } from "@bim-studio/contracts";
import "../src/styles/base.css";
import "../src/styles/platform-components.css";
import { ViewerEngine } from "../src/viewer/ViewerEngine";
import { ModelEffectsEditor } from "../src/components/ModelEffectsEditor";
import { mergeModelEffectsPatch, type ModelEffectsPatch } from "../src/viewer/modelEffectState";

// 与 visualQa 入口同规:?theme=light|dark 指定主题(仅验收入口,不改用户偏好)。
const qaTheme = new URLSearchParams(window.location.search).get("theme");
if (qaTheme === "light" || qaTheme === "dark") document.documentElement.dataset.theme = qaTheme;

/**
 * VFX 图编辑器浏览器验收夹具(编辑器刀 8):
 * 真 ViewerEngine(WebGL)+ 真 createPrimitive 对象 + 生产 ModelEffectsEditor;
 * 页内自动驱动(挂模板→调参数→切模板→行为等价触发→卸载),只读事实导出到
 * window.__vfxQa 供 Playwright 断言与截图。
 */

interface QaReport {
  ready: boolean;
  errors: string[];
  engineReady: boolean;
  /** 引擎内 VFX 状态事实(getModelEffects 读回)。 */
  vfxTemplate: string | undefined;
  vfxEnabled: boolean | undefined;
  vfxIntensity: number | undefined;
  vfxRate: number | undefined;
  vfxColor: string | undefined;
  vfxBlend: string | undefined;
  /** VFX 独立预算池事实(发射器申请量 = 运行时已创建的证据)。 */
  vfxEmitters: number;
  vfxRequested: number;
  /** 行为等价触发后第二个对象的事实。 */
  behaviorTriggered: boolean;
  behaviorTemplate: string | undefined;
  behaviorEnabled: boolean | undefined;
}

const initialReport: QaReport = {
  ready: false, errors: [], engineReady: false,
  vfxTemplate: undefined, vfxEnabled: undefined, vfxIntensity: undefined, vfxRate: undefined,
  vfxColor: undefined, vfxBlend: undefined, vfxEmitters: 0, vfxRequested: 0,
  behaviorTriggered: false, behaviorTemplate: undefined, behaviorEnabled: undefined,
};

const BOX = "qa-box";
const CYLINDER = "qa-cylinder";

function Fixture() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ViewerEngine | undefined>(undefined);
  const [effects, setEffects] = useState<SceneModelEffectsState | undefined>();
  const [report, setReport] = useState<QaReport>(initialReport);
  const [, setTick] = useState(0);
  const startedRef = useRef(false);

  const refresh = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const box = engine.getModelEffects(BOX);
    const vfx = box.vfx;
    const budget = engine.getVfxBudgetReport();
    const behavior = engine.getModelEffects(CYLINDER).vfx;
    setEffects(box);
    setReport(previous => ({
      ...previous,
      vfxTemplate: vfx?.template,
      vfxEnabled: vfx?.enabled,
      vfxIntensity: vfx?.intensity,
      vfxRate: vfx?.rate,
      vfxColor: vfx?.color,
      vfxBlend: vfx?.blend,
      vfxEmitters: budget.emitters.length,
      vfxRequested: budget.requestedTotal,
      behaviorTriggered: Boolean(behavior),
      behaviorTemplate: behavior?.template,
      behaviorEnabled: behavior?.enabled,
    }));
    setTick(value => value + 1);
  }, []);

  const applyPatch = useCallback((patch: ModelEffectsPatch) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setModelEffects(BOX, mergeModelEffectsPatch(engine.getModelEffects(BOX), patch));
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (startedRef.current || !hostRef.current) return;
    startedRef.current = true;
    let disposed = false;
    void (async () => {
      try {
        const engine = await ViewerEngine.create(hostRef.current!, "webgl");
        if (disposed) { engine.dispose(); return; }
        engineRef.current = engine;
        engine.createPrimitive(BOX, "验收罐", "box", "#8a9199");
        engine.createPrimitive(CYLINDER, "验收柱", "cylinder", "#7c8890");
        engine.select(BOX);
        engine.fitAll();
        setEffects(engine.getModelEffects(BOX));
        setReport(previous => ({ ...previous, engineReady: true }));
      } catch (reason) {
        setReport(previous => ({ ...previous, errors: [...previous.errors, String(reason)] }));
      }
    })();
    return () => { disposed = true; engineRef.current?.dispose(); };
  }, []);

  /** 行为 IR 等价触发:对验收柱只发 enabled(与 ViewerSceneCommandPort 的 effects patch 同形)。 */
  const behaviorTrigger = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setModelEffects(CYLINDER, mergeModelEffectsPatch(engine.getModelEffects(CYLINDER),
      { vfx: { template: "alarm-ring", enabled: true } }));
    refresh();
  }, [refresh]);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__vfxQa = {
      get: () => report,
      behaviorTrigger,
      refresh,
      engine: () => (engineRef.current ? { ready: true } : { ready: false }),
    };
  });

  return (
    <main style={{ display: "grid", gridTemplateColumns: "1fr 460px", gap: 12, padding: 12, minHeight: "100vh", background: "var(--bg-0)", color: "var(--text)" }}>
      <section style={{ display: "grid", gap: 8 }}>
        <h2 style={{ fontSize: 14, color: "var(--text-strong)", margin: 0 }}>VFX 图编辑器浏览器验收(编辑器刀 8)</h2>
        <div ref={hostRef} style={{ minHeight: 420, border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-1)" }} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" data-qa="qa-behavior" onClick={behaviorTrigger}>行为等价触发(验收柱告警环)</button>
          <span data-qa="qa-report" role="status">
            {`引擎:${report.engineReady ? "就绪" : "启动中"} · VFX:${report.vfxTemplate ?? "未挂载"} · 发射器:${report.vfxEmitters} · 申请:${report.vfxRequested}`}
          </span>
        </div>
        {report.errors.length > 0 && <pre style={{ color: "var(--danger)", fontSize: 11 }}>{report.errors.join("\n")}</pre>}
      </section>
      <aside style={{ border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-1)", padding: 10, overflowY: "auto" }}>
        {effects && (
          <ModelEffectsEditor
            locale="zh-CN"
            rendererBackend="webgl"
            disabled={false}
            effects={effects}
            onChange={applyPatch}
            particleBudget={engineRef.current?.getParticleBudgetReport()}
            vfxBudget={engineRef.current?.getVfxBudgetReport()}
            particleEmitterId={BOX}
          />
        )}
      </aside>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
