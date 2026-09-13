import { useEffect, useRef, useState } from "react";
import { Box, Copy, Replace, X } from "lucide-react";
import type { ModelRecord } from "@bim-studio/contracts";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import { modelParentId, modelVersionChain } from "../optimizer/modelEngineering";
import "./SceneModelInstanceDialog.css";

interface Props {
  locale: AppLocale;
  instance: LoadedSceneModel;
  assets: readonly ModelRecord[];
  busy: boolean;
  locked: boolean;
  error: string;
  onDuplicate: () => void;
  onReplace: (asset: ModelRecord) => void;
  onClose: () => void;
}

/** 对象身份与资源分开呈现；替换不允许猜测构件映射。 */
export function SceneModelInstanceDialog(props: Props) {
  const t = (zh: string, en: string) => tr(props.locale, zh, en);
  const sourceId = props.instance.assetModelId ?? props.instance.id;
  const source = props.assets.find(asset => asset.id === sourceId);
  const candidates = props.assets.filter(asset => asset.id !== sourceId && asset.status === "ready" && asset.manifest);
  const [replacementId, setReplacementId] = useState("");
  const replacement = candidates.find(asset => asset.id === replacementId);
  const previous = source ? candidates.find(asset => asset.id === modelParentId(source)) : undefined;
  const currentVersion = source ? modelVersionChain(source, props.assets).length : 0;
  const unsupported = Boolean(replacement && ([source?.manifest?.viewerKind, replacement.manifest?.viewerKind].some(kind => kind === "ifc" || kind === "fragments")));
  const escapeRef = useDialogEscape(props.onClose, props.busy);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className="dialog-backdrop instance-dialog-backdrop" ref={escapeRef} onMouseDown={event => {
    if (event.target === event.currentTarget && !props.busy) props.onClose();
  }}>
    <section className="dialog instance-dialog" role="dialog" aria-modal="true" aria-label={t("模型实例", "Model instance")} tabIndex={-1} ref={dialogRef}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),select:not(:disabled)"));
        const first = items[0]; const last = items.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className="instance-dialog-heading"><Box size={20} /><div><h2>{t("模型实例", "Model instance")}</h2><p title={props.instance.name}>{props.instance.name}</p></div>
        <button className="mini-button" aria-label={t("关闭", "Close")} disabled={props.busy} onClick={props.onClose}><X size={16} /></button>
      </header>
      <div className="instance-dialog-source"><span>{t("当前素材", "Source asset")}</span><strong title={source?.name}>{source?.name ?? t("素材不可用", "Asset unavailable")}</strong></div>
      <label className="instance-dialog-field"><span>{t("替换为项目素材", "Replace with project asset")}</span>
        <select aria-label={t("替换为项目素材", "Replace with project asset")} value={replacementId} disabled={props.busy || props.locked || !candidates.length} onChange={event => setReplacementId(event.target.value)}>
          <option value="">{candidates.length ? t("选择已就绪素材", "Choose a ready asset") : t("暂无其他已就绪素材", "No other ready assets")}</option>
          {candidates.map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {asset.format.toUpperCase()}</option>)}
        </select>
      </label>
      {previous && <button className="button instance-previous-version" disabled={props.busy || props.locked} onClick={() => setReplacementId(previous.id)}>{t("选择上一版本", "Select previous version")} · {previous.name}</button>}
      {replacement && <section className="instance-replacement-review" aria-label={t("替换前检查", "Replacement preflight")}>
        <strong>{t("替换前检查", "Replacement preflight")}</strong>
        <p>{t(`当前 v${currentVersion} → ${replacement.name}`, `Current v${currentVersion} → ${replacement.name}`)}</p>
        <span>{t("保留对象身份、数据绑定、交互、名称、位姿与外观。", "Retain identity, data bindings, interactions, name, pose and appearance.")}</span>
        <small>{unsupported ? t("该构件容器不能直接替换，请选择兼容素材。", "Choose a compatible asset for this object container.") : t("执行时先校验完整层级与动画；不兼容则保留当前实例。成功后可撤销。", "The full hierarchy and animations are checked before applying. Incompatible assets leave the instance unchanged. Successful replacement can be undone.")}</small>
      </section>}
      {props.locked && <p className="instance-dialog-hint">{t("实例已锁定，解锁后可替换。", "Unlock this instance to replace it.")}</p>}
      {props.error && <p className="instance-dialog-error" role="alert">{props.error}</p>}
      {props.busy && <p className="instance-dialog-hint" role="status">{t("正在载入并检查素材…", "Loading and checking the asset…")}</p>}
      <footer className="instance-dialog-actions">
        <button className="button" disabled={props.busy || !source?.manifest} onClick={props.onDuplicate} title={t("复用素材与外观，不复制脚本或业务绑定", "Reuse the asset and appearance, not scripts or business bindings")}><Copy size={14} />{t("新增副本", "Duplicate")}</button>
        <span />
        <button className="button" disabled={props.busy} onClick={props.onClose}>{t("取消", "Cancel")}</button>
        <button className="button primary" disabled={props.busy || props.locked || !replacement || unsupported} onClick={() => replacement && props.onReplace(replacement)} title={t("检查层级与动画后替换；原版本保留，可撤销。", "Check hierarchy and animations, then replace. The previous version is retained and undo is available.")}><Replace size={14} />{t("替换素材", "Replace asset")}</button>
      </footer>
    </section>
  </div>;
}
