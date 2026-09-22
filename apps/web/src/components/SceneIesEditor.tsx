import { useState, type ChangeEvent } from "react";
import type { GlobalLightingState, SceneLightState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { DeferredNumberInput } from "./AppFormControls";
import { compileIesAuthorProfile } from "./sceneIesAuthoring";

interface Props {
  locale: AppLocale;
  lighting: GlobalLightingState;
  light: SceneLightState;
  onLightingChange: (next: GlobalLightingState) => void;
  onUpdate: (patch: Partial<SceneLightState>) => void;
}

/** Product authoring entry for self-contained, quantized LM-63 profiles. */
export function SceneIesEditor({ locale, lighting, light, onLightingChange, onUpdate }: Props) {
  const [message, setMessage] = useState("");
  const profiles = lighting.lightProfiles ?? [];

  function selectProfile(profileId: string) {
    if (!profileId) {
      const { ies: _removed, ...nextLight } = light;
      onLightingChange({ ...lighting, lights: (lighting.lights ?? []).map(item => item.id === light.id ? nextLight : item) });
      return;
    }
    onUpdate({ ies: { profileId, rotationDeg: 0, scaleFactor: 1 } });
  }

  async function importProfile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setMessage(tr(locale, "正在校验 IES…", "Validating IES…"));
    try {
      if (file.size < 1 || file.size > 2 * 1024 * 1024) throw new Error(tr(locale, "文件必须小于 2 MiB", "File must be smaller than 2 MiB"));
      const source = await file.text();
      const profile = compileIesAuthorProfile(file.name, source);
      const { profileId } = profile;
      const nextProfiles = [...profiles.filter(item => item.profileId !== profileId), profile];
      const nextLight = { ...light, ies: { profileId, rotationDeg: 0, scaleFactor: 1 } };
      onLightingChange({ ...lighting, lightProfiles: nextProfiles,
        lights: (lighting.lights ?? []).map(item => item.id === light.id ? nextLight : item) });
      setMessage(tr(locale, `已导入 ${file.name}`, `Imported ${file.name}`));
    } catch (error) {
      setMessage(tr(locale, `IES 导入失败：${error instanceof Error ? error.message : "格式无效"}`,
        `IES import failed: ${error instanceof Error ? error.message : "invalid format"}`));
    }
  }

  return <section className="light-ies-editor" aria-label="IES">
    <label>
      <span>IES</span>
      <select value={light.ies?.profileId ?? ""} onChange={event => selectProfile(event.target.value)}>
        <option value="">{tr(locale, "未使用", "None")}</option>
        {profiles.map(profile => <option key={profile.profileId} value={profile.profileId}>{profile.profileId}</option>)}
      </select>
    </label>
    <label className="light-ies-import">
      <span>{tr(locale, "导入光域网", "Import photometry")}</span>
      <input type="file" accept=".ies,text/plain" onChange={event => void importProfile(event)} />
    </label>
    {light.ies && <div className="light-size">
      <label><span>{tr(locale, "旋转", "Rotation")}</span><DeferredNumberInput min={0} max={359.5} step={0.5}
        value={light.ies.rotationDeg ?? 0} onCommit={rotationDeg => onUpdate({ ies: { ...light.ies!, rotationDeg } })} /><i>°</i></label>
      <label><span>{tr(locale, "倍率", "Scale")}</span><DeferredNumberInput min={0} max={10} step={0.05}
        value={light.ies.scaleFactor ?? 1} onCommit={scaleFactor => onUpdate({ ies: { ...light.ies!, scaleFactor } })} /></label>
    </div>}
    {message && <small role="status" aria-live="polite">{message}</small>}
  </section>;
}
