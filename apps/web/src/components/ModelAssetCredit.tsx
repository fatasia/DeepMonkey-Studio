import type { ModelRecord } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { AssetAttributionDetails } from "./AssetAttributionDetails";

export function ModelAssetCredit({ model, locale }: { model: ModelRecord; locale: AppLocale }) {
  const origin = model.libraryOrigin ?? model.optimization?.libraryOrigin;
  return <div className="model-asset-credit">
    {model.optimization && <small>{tr(locale, "优化来源", "Optimized from")}：{model.optimization.sourceModelName}</small>}
    {origin?.attribution && <AssetAttributionDetails locale={locale} attribution={model.optimization
      ? { ...origin.attribution, modifications: `${origin.attribution.modifications} · ${tr(locale, "经模型优化处理，原始素材保留。", "Processed by model optimization; the original asset is preserved.")}` }
      : origin.attribution} />}
  </div>;
}
