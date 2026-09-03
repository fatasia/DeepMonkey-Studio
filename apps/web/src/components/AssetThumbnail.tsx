import { ImageOff } from "lucide-react";
import { useState } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

interface AssetThumbnailProps {
  locale: AppLocale;
  name: string;
  src: string;
}

/** 图片加载失败时保留卡片结构和可理解反馈，避免商业资源库出现空白卡。 */
export function AssetThumbnail({ locale, name, src }: AssetThumbnailProps) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="asset-thumbnail-fallback" role="img" aria-label={tr(locale, `${name}缩略图暂不可用`, `${name} preview unavailable`)}>
        <ImageOff size={28} />
        <span>{tr(locale, "预览暂不可用", "Preview unavailable")}</span>
      </div>
    );
  }
  return <img src={src} alt={name} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}
