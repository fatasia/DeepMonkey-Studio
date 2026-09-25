import { useEffect, useState } from "react";
import type { SceneMaterialState } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { inspectSceneCustomShader } from "../delivery/sceneCustomShader";
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

interface Props {
  readonly locale: AppLocale;
  readonly disabled: boolean;
  readonly material: SceneMaterialState;
  readonly onChange: (patch: SceneMaterialState) => void;
}

export function CustomShaderEditor({ locale, disabled, material, onChange }: Props) {
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
  return <details className="custom-shader-editor" open={Boolean(bound)}>
    <summary>
      <span>DeepSL</span>
      <small>{bound ? tr(locale, "已绑定", "Bound") : tr(locale, "未绑定", "Unbound")}</small>
    </summary>
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
  </details>;
}
