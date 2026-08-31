import type { SceneMaterialState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

interface MaterialTextureSettingsProps {
  locale: AppLocale;
  disabled: boolean;
  material: SceneMaterialState;
  onChange: (patch: SceneMaterialState) => void;
}

interface TextureRangeProps {
  locale: AppLocale;
  label: [string, string];
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

/** PBR 贴图共用的静态 UV 变换与播放参数。 */
export function MaterialTextureSettings({ locale, disabled, material, onChange }: MaterialTextureSettingsProps) {
  const legacyRepeat = material.textureRepeat ?? 1;
  return (
    <>
      <div className="material-uv-transform">
        <TextureRange
          locale={locale}
          label={["横向重复 U", "U tiling"]}
          value={material.textureRepeatX ?? legacyRepeat}
          min={0.25}
          max={16}
          step={0.25}
          disabled={disabled}
          format={(value) => `${value.toFixed(2)}×`}
          onChange={(textureRepeatX) => onChange({ textureRepeatX })}
        />
        <TextureRange
          locale={locale}
          label={["纵向重复 V", "V tiling"]}
          value={material.textureRepeatY ?? legacyRepeat}
          min={0.25}
          max={16}
          step={0.25}
          disabled={disabled}
          format={(value) => `${value.toFixed(2)}×`}
          onChange={(textureRepeatY) => onChange({ textureRepeatY })}
        />
        <TextureRange
          locale={locale}
          label={["横向偏移 U", "U offset"]}
          value={material.textureOffsetX ?? 0}
          min={-2}
          max={2}
          step={0.01}
          disabled={disabled}
          onChange={(textureOffsetX) => onChange({ textureOffsetX })}
        />
        <TextureRange
          locale={locale}
          label={["纵向偏移 V", "V offset"]}
          value={material.textureOffsetY ?? 0}
          min={-2}
          max={2}
          step={0.01}
          disabled={disabled}
          onChange={(textureOffsetY) => onChange({ textureOffsetY })}
        />
      </div>
      <TextureRange
        locale={locale}
        label={["贴图旋转", "Texture rotation"]}
        value={((material.textureRotation ?? 0) * 180) / Math.PI}
        min={-180}
        max={180}
        step={1}
        disabled={disabled}
        format={(value) => `${Math.round(value)}°`}
        onChange={(value) => onChange({ textureRotation: (value * Math.PI) / 180 })}
      />
      {material.normalMapUrl && (
        <TextureRange
          locale={locale}
          label={["法线强度", "Normal strength"]}
          value={material.normalScale ?? 1}
          min={0}
          max={4}
          step={0.05}
          disabled={disabled}
          onChange={(normalScale) => onChange({ normalScale })}
        />
      )}
      <UvAnimationSettings locale={locale} disabled={disabled} material={material} onChange={onChange} />
      <button disabled={disabled} onClick={() => onChange(clearTexturePatch())}>
        {tr(locale, "恢复模型原始贴图", "Restore original textures")}
      </button>
    </>
  );
}

function UvAnimationSettings({ locale, disabled, material, onChange }: MaterialTextureSettingsProps) {
  const animation = material.uvAnimation;
  const update = (patch: Partial<NonNullable<SceneMaterialState["uvAnimation"]>>) => {
    if (!animation) return;
    onChange({ uvAnimation: { ...animation, ...patch } });
  };
  return (
    <div className="material-uv-animation">
      <button
        disabled={disabled}
        className={animation?.enabled ? "active" : ""}
        onClick={() => onChange({
          uvAnimation: {
            enabled: !animation?.enabled,
            loopMode: animation?.loopMode ?? "loop",
            durationSeconds: animation?.durationSeconds ?? 5,
            offsetSpeedX: animation?.offsetSpeedX ?? 0.2,
            offsetSpeedY: animation?.offsetSpeedY ?? 0,
            rotationSpeed: animation?.rotationSpeed ?? 0,
          },
        })}
      >
        {tr(locale, "UV 动画", "UV animation")}
      </button>
      {animation?.enabled && (
        <>
          <label>
            <span>{tr(locale, "播放方式", "Playback")}</span>
            <select
              disabled={disabled}
              value={animation.loopMode ?? "loop"}
              onChange={(event) => update({ loopMode: event.target.value as "once" | "loop" })}
            >
              <option value="once">{tr(locale, "播放一次", "Play once")}</option>
              <option value="loop">{tr(locale, "循环播放", "Loop")}</option>
            </select>
          </label>
          {(animation.loopMode ?? "loop") === "once" && (
            <label>
              <span>{tr(locale, "播放时长", "Duration")}</span>
              <input
                type="number"
                min="0.05"
                step="0.1"
                disabled={disabled}
                value={animation.durationSeconds ?? 5}
                onChange={(event) => update({
                  durationSeconds: Math.max(0.05, Number(event.target.value) || 0.05),
                })}
              />
              <small>s</small>
            </label>
          )}
          <TextureRange locale={locale} label={["横向速度", "U speed"]} value={animation.offsetSpeedX}
            min={-2} max={2} step={0.01} disabled={disabled} onChange={(offsetSpeedX) => update({ offsetSpeedX })} />
          <TextureRange locale={locale} label={["纵向速度", "V speed"]} value={animation.offsetSpeedY}
            min={-2} max={2} step={0.01} disabled={disabled} onChange={(offsetSpeedY) => update({ offsetSpeedY })} />
          <TextureRange locale={locale} label={["旋转速度", "Rotation speed"]} value={animation.rotationSpeed}
            min={-2} max={2} step={0.01} disabled={disabled} onChange={(rotationSpeed) => update({ rotationSpeed })} />
        </>
      )}
    </div>
  );
}

function TextureRange({ locale, label, value, min, max, step, disabled, format, onChange }: TextureRangeProps) {
  return (
    <label>
      <span>{tr(locale, ...label)}</span>
      <input
        disabled={disabled}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{format ? format(value) : value.toFixed(2)}</output>
    </label>
  );
}

function clearTexturePatch(): SceneMaterialState {
  return {
    baseColorMapUrl: "",
    baseColorMapName: "",
    normalMapUrl: "",
    normalMapName: "",
    emissiveMapUrl: "",
    emissiveMapName: "",
    ambientOcclusionMapUrl: "",
    ambientOcclusionMapName: "",
    roughnessMapUrl: "",
    roughnessMapName: "",
    metalnessMapUrl: "",
    metalnessMapName: "",
    textureRepeatX: 1,
    textureRepeatY: 1,
    textureOffsetX: 0,
    textureOffsetY: 0,
    textureRotation: 0,
  };
}
