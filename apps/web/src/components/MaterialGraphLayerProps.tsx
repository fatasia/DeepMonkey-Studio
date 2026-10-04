import type { ChangeEvent } from "react";
import type { MaterialGraphDefinition, MaterialGraphLayer, MaterialGraphMaskKind } from "../materials/materialGraphModel";
import { MATERIAL_GRAPH_MASK_KINDS, MATERIAL_GRAPH_MAX_LAYERS, defaultMask } from "../materials/materialGraphModel";
import { translate as tr, type AppLocale } from "../i18n";

/**
 * 材质图属性表单(编辑器刀 7):按选中节点类型渲染编辑器。
 * 全部改动即时上抛(编辑器侧负责防抖编译与 ≤100ms 应用);受控无内部状态副本。
 */

export type MaterialGraphSelection =
  | { kind: "base" }
  | { kind: "output" }
  | { kind: "layer"; layerId: string }
  | { kind: "mask"; layerId: string }
  | undefined;

interface Props {
  readonly locale: AppLocale;
  readonly disabled: boolean;
  readonly graph: MaterialGraphDefinition;
  readonly selection: MaterialGraphSelection;
  readonly onGraphChange: (next: MaterialGraphDefinition) => void;
  readonly onTextureMaskFile: (layerId: string, file: File) => void;
  readonly layerCount: number;
  readonly onAddLayer: (kind: MaterialGraphMaskKind) => void;
  readonly onRemoveLayer: (layerId: string) => void;
}

/** 输出节点:仅说明;底材质:基础参数+从当前材质读取;层/遮罩:完整参数。 */
export function MaterialGraphLayerProps({ locale, disabled, graph, selection, onGraphChange, onTextureMaskFile, layerCount, onAddLayer, onRemoveLayer }: Props) {
  const selectedLayer = selection && (selection.kind === "layer" || selection.kind === "mask")
    ? graph.layers.find(layer => layer.id === selection.layerId)
    : undefined;
  const isMask = selection?.kind === "mask";

  if (!selection || selection.kind === "output") {
    return (
      <div className="material-graph-props" data-qa="material-graph-props">
        <p className="material-graph-hint">
          {tr(locale, "点选节点编辑参数;改动即时编译并应用到选中对象(预合成 ≤100ms)。",
            "Select a node to edit; changes compile and apply instantly (precomposed ≤100ms).")}
        </p>
        <div className="material-graph-add-row">
          {MATERIAL_GRAPH_MASK_KINDS.map(({ kind, zh, en }) => (
            <button
              key={kind}
              type="button"
              data-qa={`material-graph-add-${kind}`}
              disabled={disabled || layerCount >= MATERIAL_GRAPH_MAX_LAYERS}
              onClick={() => onAddLayer(kind)}
              title={tr(locale, `添加${zh}层`, `Add ${en} layer`)}
            >
              +{tr(locale, zh, en)}
            </button>
          ))}
        </div>
        <small className="material-graph-hint">
          {tr(locale, `调整层上限 ${MATERIAL_GRAPH_MAX_LAYERS} 层;磨损/污渍/标带/纹理遮罩。`, `Up to ${MATERIAL_GRAPH_MAX_LAYERS} layers; wear / dust / stripe / texture masks.`)}
        </small>
      </div>
    );
  }

  if (selection.kind === "base") {
    return (
      <div className="material-graph-props" data-qa="material-graph-props-base">
        <label className="material-graph-row">
          <span>{tr(locale, "底色", "Base color")}</span>
          <input type="color" disabled={disabled} value={graph.base.color}
            onChange={event => onGraphChange({ ...graph, base: { ...graph.base, color: event.target.value }, updatedAt: new Date().toISOString() })} />
        </label>
        <ScalarRow locale={locale} disabled={disabled} label={tr(locale, "粗糙度", "Roughness")} value={graph.base.roughness}
          onChange={value => onGraphChange({ ...graph, base: { ...graph.base, roughness: value }, updatedAt: new Date().toISOString() })} />
        <ScalarRow locale={locale} disabled={disabled} label={tr(locale, "金属度", "Metalness")} value={graph.base.metalness}
          onChange={value => onGraphChange({ ...graph, base: { ...graph.base, metalness: value }, updatedAt: new Date().toISOString() })} />
        <small className="material-graph-hint">
          {tr(locale, "启用颜色层时,合成色贴图会接管基础色贴图槽;断开图可还原。",
            "With a color layer enabled, the composite takes over the base-color map slot; disconnect restores it.")}
        </small>
      </div>
    );
  }

  if (!selectedLayer) return null;
  const layer = selectedLayer;
  const patchLayer = (patch: Partial<MaterialGraphLayer>) => {
    onGraphChange({
      ...graph,
      layers: graph.layers.map(item => item.id === layer.id ? { ...item, ...patch } : item),
      updatedAt: new Date().toISOString(),
    });
  };
  const patchMask = (patch: Partial<MaterialGraphLayer["mask"]>) => patchLayer({ mask: { ...layer.mask, ...patch } });

  return (
    <div className="material-graph-props" data-qa="material-graph-props-layer">
      <div className="material-graph-row">
        <label className="material-graph-name">
          <span>{tr(locale, "名称", "Name")}</span>
          <input disabled={disabled} value={layer.name} maxLength={24}
            onChange={event => patchLayer({ name: event.target.value })} />
        </label>
        <label className="material-graph-toggle">
          <input type="checkbox" disabled={disabled} checked={layer.enabled} onChange={event => patchLayer({ enabled: event.target.checked })} />
          <span>{tr(locale, "启用", "Enabled")}</span>
        </label>
        <button type="button" className="material-graph-danger" disabled={disabled} onClick={() => onRemoveLayer(layer.id)}>
          {tr(locale, "删除层", "Remove layer")}
        </button>
      </div>

      {!isMask && (
        <>
          <ChannelToggle locale={locale} disabled={disabled} checked={layer.useColor} label={tr(locale, "颜色", "Color")}
            onChange={value => patchLayer({ useColor: value })}>
            <input type="color" disabled={disabled || !layer.useColor} value={layer.color} onChange={event => patchLayer({ color: event.target.value })} />
            <select disabled={disabled || !layer.useColor} value={layer.blend} aria-label={tr(locale, "混合方式", "Blend mode")}
              onChange={event => patchLayer({ blend: event.target.value === "multiply" ? "multiply" : "mix" })}>
              <option value="mix">{tr(locale, "覆盖", "Overlay")}</option>
              <option value="multiply">{tr(locale, "正片叠底", "Multiply")}</option>
            </select>
          </ChannelToggle>
          <ChannelToggle locale={locale} disabled={disabled} checked={layer.useRoughness} label={tr(locale, "粗糙度", "Roughness")}
            onChange={value => patchLayer({ useRoughness: value })}>
            <ScalarInput disabled={disabled || !layer.useRoughness} value={layer.roughness} onChange={value => patchLayer({ roughness: value })} />
          </ChannelToggle>
          <ChannelToggle locale={locale} disabled={disabled} checked={layer.useMetalness} label={tr(locale, "金属度", "Metalness")}
            onChange={value => patchLayer({ useMetalness: value })}>
            <ScalarInput disabled={disabled || !layer.useMetalness} value={layer.metalness} onChange={value => patchLayer({ metalness: value })} />
          </ChannelToggle>
          <label className="material-graph-row">
            <span>{tr(locale, "凹凸", "Bump")}</span>
            <ScalarInput disabled={disabled} value={layer.bump} onChange={value => patchLayer({ bump: value })} />
          </label>
          <ScalarRow locale={locale} disabled={disabled} label={tr(locale, "层强度", "Layer strength")} value={layer.opacity}
            onChange={value => patchLayer({ opacity: value })} />
        </>
      )}

      {isMask && (
        <>
          <label className="material-graph-row">
            <span>{tr(locale, "遮罩类型", "Mask type")}</span>
            <select disabled={disabled} value={layer.mask.kind}
              onChange={event => patchMask({ ...defaultMask(event.target.value as MaterialGraphMaskKind), kind: event.target.value as MaterialGraphMaskKind })}>
              {MATERIAL_GRAPH_MASK_KINDS.map(({ kind, zh, en }) => <option key={kind} value={kind}>{tr(locale, zh, en)}</option>)}
            </select>
          </label>
          {layer.mask.kind === "texture" ? (
            <div className="material-graph-row">
              <span>{tr(locale, "遮罩贴图", "Mask image")}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const file = event.target.files?.[0];
                  if (file) onTextureMaskFile(layer.id, file);
                  event.target.value = "";
                }} />
              <small>{layer.mask.textureName ?? tr(locale, "未设置(≤256KB 灰度图)", "Not set (≤256KB grayscale)")}</small>
            </div>
          ) : (
            <>
              <label className="material-graph-row">
                <span>{tr(locale, "图案密度", "Pattern density")}</span>
                <input type="range" min="1" max="8" step="0.5" disabled={disabled} value={layer.mask.scale}
                  onChange={event => patchMask({ scale: Number(event.target.value) })} />
                <output>{layer.mask.scale.toFixed(1)}</output>
              </label>
              <label className="material-graph-row">
                <span>{tr(locale, "覆盖率", "Coverage")}</span>
                <ScalarInput disabled={disabled} value={layer.mask.coverage} onChange={value => patchMask({ coverage: value })} />
              </label>
              <label className="material-graph-row">
                <span>{tr(locale, "边缘柔和", "Edge softness")}</span>
                <ScalarInput disabled={disabled} value={layer.mask.softness} onChange={value => patchMask({ softness: value })} />
              </label>
            </>
          )}
          {layer.mask.kind !== "dust" && (
            <label className="material-graph-row">
              <span>{tr(locale, "角度", "Angle")}</span>
              <input type="range" min="0" max="90" step="5" disabled={disabled} value={layer.mask.angle}
                onChange={event => patchMask({ angle: Number(event.target.value) })} />
              <output>{layer.mask.angle}°</output>
            </label>
          )}
          <ScalarRow locale={locale} disabled={disabled} label={tr(locale, "噪声种子", "Noise seed")}
            value={layer.mask.seed / 9999}
            onChange={value => patchMask({ seed: Math.max(1, Math.round(value * 9999)) })} />
        </>
      )}
    </div>
  );
}

function ChannelToggle({ locale, disabled, checked, label, onChange, children }: {
  locale: AppLocale; disabled: boolean; checked: boolean; label: string; onChange: (value: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="material-graph-channel">
      <label className="material-graph-toggle">
        <input type="checkbox" disabled={disabled} checked={checked} onChange={event => onChange(event.target.checked)} />
        <span>{label}</span>
      </label>
      <div className="material-graph-channel-body" data-active={checked || undefined}>
        {children}
        {!checked && <span className="material-graph-hint">{tr(locale, "未启用 —— 本层不修改该通道", "Off — this layer leaves the channel untouched")}</span>}
      </div>
    </div>
  );
}

function ScalarRow({ locale, disabled, label, value, onChange }: {
  locale: AppLocale; disabled: boolean; label: string; value: number; onChange: (value: number) => void;
}) {
  return (
    <label className="material-graph-row">
      <span>{label}</span>
      <ScalarInput disabled={disabled} value={value} onChange={onChange} />
    </label>
  );
}

function ScalarInput({ disabled, value, onChange }: { disabled: boolean; value: number; onChange: (value: number) => void }) {
  return (
    <>
      <input type="range" min="0" max="1" step="0.01" disabled={disabled} value={Math.min(1, Math.max(0, value))}
        onChange={event => onChange(Number(event.target.value))} />
      <output>{value.toFixed(2)}</output>
    </>
  );
}
