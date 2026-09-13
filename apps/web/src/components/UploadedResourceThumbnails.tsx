import { useState } from "react";
import { ImagePlus } from "lucide-react";
import type { ModelRecord, ProjectAssetRecord } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { ProjectResourcePreview } from "./ProjectResourcePreview";

export function UploadedResourceThumbnails({ items, locale, onSaved, onDismiss }: {
  items: Array<ModelRecord | ProjectAssetRecord>; locale: AppLocale; onSaved: () => Promise<void>; onDismiss?: () => void;
}) {
  const [selected, setSelected] = useState<ModelRecord | ProjectAssetRecord>();
  return <>
    <div className="resource-upload-thumbnails" role="group" aria-label={tr(locale, "设置上传资源的缩略图", "Set uploaded asset thumbnails")}>
      {items.map(item => <button key={item.id} type="button" className="button" title={tr(locale, `设置缩略图：${item.name}`, `Set thumbnail: ${item.name}`)} onClick={() => setSelected(item)}><ImagePlus size={15} /><span>{tr(locale, "缩略图", "Thumbnail")} · {item.name}</span></button>)}
      {onDismiss && <button type="button" className="button" onClick={onDismiss}>{tr(locale, "完成", "Done")}</button>}
    </div>
    {selected && <ProjectResourcePreview key={selected.id} item={selected} locale={locale} onClose={() => setSelected(undefined)} onThumbnailSaved={async updated => { setSelected(updated); await onSaved(); }} />}
  </>;
}
