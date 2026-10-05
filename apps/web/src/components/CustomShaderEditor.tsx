import { useCallback, useEffect, useMemo, useState } from "react";
import type { ShaderGraphAssetV1 } from "@bim-studio/deep-engine/shader-graph";
import type { SceneMaterialState } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { inspectSceneCustomShader } from "../delivery/sceneCustomShader";
import { ShaderNodeCanvas } from "./ShaderNodeCanvas";
import { resolveShaderGraphDraft, saveShaderGraphDraft, type KeyValueStore } from "./shaderNodeCanvasModel.js";
import "./CustomShaderEditor.css";

const STARTER = `shader deep.material {
  surface standard;
  baseColor [0.12, 0.42, 0.9, 1];
  metallic 0.65;
  roughness 0.24;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`;

type Inspection = ReturnType<typeof inspectSceneCustomShader>;
type EditorMode = "text" | "nodes";

interface Props {
  readonly locale: AppLocale;
  readonly disabled: boolean;
  readonly material: SceneMaterialState;
  readonly onChange: (patch: SceneMaterialState) => void;
  /** 节点图草稿的持久化键(材质槽身份);缺省 = 草稿仅本会话内存有效。 */
  readonly storageKey?: string | undefined;
}

/** localStorage 访问守卫:隐私模式/禁用存储时返回 undefined,草稿退化为会话内存态。 */
function safeLocalStorage(): KeyValueStore | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage;
  } catch { return undefined; }
}

export function CustomShaderEditor({ locale, disabled, material, onChange, storageKey }: Props) {
  const [mode, setMode] = useState<EditorMode>("text");
  const bound = material.customShader?.source;
  const [draft, setDraft] = useState(bound ?? "");
  const [inspection, setInspection] = useState<Inspection>();
  useEffect(() => { setDraft(bound ?? ""); setInspection(undefined); }, [bound]);
  const preview = () => setInspection(inspectSceneCustomShader(draft));
  const bind = () => {
    const result = inspectSceneCustomShader(draft);
    setInspection(result);
    if (result.success) onChange({ customShader: { source: draft } });
  };
  const graphStore = useMemo(safeLocalStorage, []);
  const [graphDraft, setGraphDraft] = useState<ShaderGraphAssetV1>(() => resolveShaderGraphDraft(graphStore, storageKey));
  // 材质槽切换(键变化)时重载该槽的草稿;未提供键 = 会话内存草稿,不跨槽复用。
  useEffect(() => { setGraphDraft(resolveShaderGraphDraft(graphStore, storageKey)); }, [graphStore, storageKey]);
  const changeGraphDraft = useCallback((asset: ShaderGraphAssetV1) => {
    setGraphDraft(asset);
    saveShaderGraphDraft(graphStore, storageKey, asset);
  }, [graphStore, storageKey]);
  return <details className="custom-shader-editor" open={Boolean(bound)}>
    <summary>
      <span>DeepSL</span>
      <small>{bound ? tr(locale, "已绑定", "Bound") : tr(locale, "未绑定", "Unbound")}</small>
    </summary>
    <div className="custom-shader-mode-toggle" role="tablist">
      <button type="button" role="tab" aria-selected={mode === "text"} className={mode === "text" ? "active" : ""}
        onClick={() => setMode("text")}>{tr(locale, "源码", "Source")}</button>
      <button type="button" role="tab" aria-selected={mode === "nodes"} className={mode === "nodes" ? "active" : ""}
        onClick={() => setMode("nodes")}>{tr(locale, "节点图", "Node graph")}</button>
    </div>
    {mode === "text" && <>
      <label htmlFor="custom-shader-source">{tr(locale, "着色器源码", "Shader source")}</label>
      <textarea id="custom-shader-source" spellCheck={false} disabled={disabled} value={draft}
        placeholder={STARTER} onChange={event => { setDraft(event.target.value); setInspection(undefined); }} />
      <div className="custom-shader-actions">
        <button type="button" disabled={disabled || !draft.trim()} onClick={preview}>
          {tr(locale, "编译诊断", "Compile diagnostics")}
        </button>
        <button type="button" disabled={disabled || !draft.trim()} onClick={bind}>
          {tr(locale, "绑定到材质", "Bind to material")}
        </button>
        {bound && <button type="button" disabled={disabled} onClick={() => onChange({ customShader: undefined })}>
          {tr(locale, "解除绑定", "Unbind")}
        </button>}
      </div>
      {inspection && <div className="custom-shader-result" role="status" aria-live="polite">
        {inspection.success ? <>
          <strong>{tr(locale, "编译通过 · 包预览", "Compiled · package preview")}</strong>
          <span>{inspection.shader.packageId}</span>
          <span title={inspection.cacheKeys.join("\n")}>PassCacheKey · {inspection.cacheKeys[0]?.slice(0, 16)}…</span>
        </> : <>
          <strong>{tr(locale, "编译失败", "Compilation failed")}</strong>
          {inspection.diagnostics.map((message, index) => <span key={`${index}-${message}`}>{message}</span>)}
        </>}
      </div>}
    </>}
    {mode === "nodes" && (
      <ShaderNodeCanvas
        locale={locale}
        disabled={disabled}
        asset={graphDraft}
        onAssetChange={changeGraphDraft}
      />
    )}
  </details>;
}
