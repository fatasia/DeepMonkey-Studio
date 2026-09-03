import type { SceneMaterialScreenState, SceneMaterialState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

interface ModelScreenEditorProps {
  locale: AppLocale;
  disabled: boolean;
  screen: SceneMaterialScreenState | undefined;
  onChange: (patch: SceneMaterialState) => void;
}

const DEFAULT_SCREEN: SceneMaterialScreenState = {
  enabled: false,
  sourceType: "video",
  url: "",
  autoplay: true,
  loopMode: "loop",
  muted: true,
  emissiveIntensity: 1,
};

/** 只配置模型表面媒体；资源选择和上传仍由统一资源库承担。 */
export function ModelScreenEditor({ locale, disabled, screen, onChange }: ModelScreenEditorProps) {
  const value = screen ?? DEFAULT_SCREEN;
  const update = (patch: Partial<SceneMaterialScreenState>) => onChange({ screen: { ...value, ...patch } });

  return (
    <div className="model-screen-editor">
      <div className="section-label">
        <span>{tr(locale, "模型屏幕", "Model screen")}</span>
        <small>{tr(locale, "图片 / 视频", "Image / video")}</small>
      </div>
      <label className="material-toggle-row">
        <input type="checkbox" disabled={disabled} checked={value.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        <span>{tr(locale, "映射到当前模型或构件表面", "Map to the current model or component")}</span>
      </label>
      {value.enabled && (
        <>
          <label>
            <span>{tr(locale, "媒体类型", "Media type")}</span>
            <select disabled={disabled} value={value.sourceType} onChange={(event) => update({ sourceType: event.target.value as SceneMaterialScreenState["sourceType"] })}>
              <option value="image">{tr(locale, "图片", "Image")}</option>
              <option value="video">{tr(locale, "视频", "Video")}</option>
            </select>
          </label>
          <label>
            <span>{tr(locale, "资源地址", "Asset URL")}</span>
            <input disabled={disabled} value={value.url} placeholder="/assets/screens/line-status.mp4" onChange={(event) => update({ url: event.target.value.trim() })} />
          </label>
          <label>
            <span>{tr(locale, "屏幕亮度", "Screen brightness")}</span>
            <input type="range" min="0" max="5" step="0.05" disabled={disabled} value={value.emissiveIntensity} onChange={(event) => update({ emissiveIntensity: Number(event.target.value) })} />
            <output>{value.emissiveIntensity.toFixed(2)}</output>
          </label>
          {value.sourceType === "video" && (
            <>
              <label className="material-toggle-row">
                <input type="checkbox" disabled={disabled} checked={value.autoplay} onChange={(event) => update({ autoplay: event.target.checked })} />
                <span>{tr(locale, "自动播放", "Autoplay")}</span>
              </label>
              <label>
                <span>{tr(locale, "播放方式", "Playback")}</span>
                <select disabled={disabled} value={value.loopMode} onChange={(event) => update({ loopMode: event.target.value as SceneMaterialScreenState["loopMode"] })}>
                  <option value="once">{tr(locale, "播放一次", "Play once")}</option>
                  <option value="loop">{tr(locale, "循环播放", "Loop")}</option>
                </select>
              </label>
              <label className="material-toggle-row">
                <input type="checkbox" disabled={disabled || value.autoplay} checked={value.autoplay || value.muted} onChange={(event) => update({ muted: event.target.checked })} />
                <span>{tr(locale, "静音", "Muted")}</span>
              </label>
              {value.autoplay && <small>{tr(locale, "浏览器要求自动播放视频保持静音。", "Browsers require autoplaying video to stay muted.")}</small>}
            </>
          )}
          <small>{tr(locale, "如模型包含多个材质，请先在场景列表中选择屏幕所在构件。", "For multi-material models, select the screen component in the scene list first.")}</small>
        </>
      )}
    </div>
  );
}
