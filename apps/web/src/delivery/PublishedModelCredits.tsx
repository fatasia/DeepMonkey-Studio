import type { ModelRecord } from "@bim-studio/contracts";
import { ModelAssetCredit } from "../components/ModelAssetCredit";
import { translate as tr, type AppLocale } from "../i18n";
import "./published-model-credits.css";

/** Attribution remains accessible even when the publisher hides browsing tools. */
export function PublishedModelCredits({ models, modelIds, locale }: {
  models: readonly ModelRecord[]; modelIds?: readonly string[]; locale: AppLocale;
}) {
  const referenced = modelIds && new Set(modelIds);
  const credited = models.filter(model => (!referenced || referenced.has(model.id))
    && (model.libraryOrigin?.attribution || model.optimization?.libraryOrigin?.attribution));
  if (!credited.length) return null;
  return <details className="published-model-credits" onKeyDown={event => {
    if (event.key !== "Escape") return;
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
    event.stopPropagation();
  }}>
    <summary>{tr(locale, "素材署名", "Asset credits")} · {credited.length}</summary>
    <section aria-label={tr(locale, "本次交付的素材来源", "Asset sources in this delivery")}>
      {credited.map(model => <article key={model.id}>
        <strong>{model.name}</strong>
        <ModelAssetCredit model={model} locale={locale} />
      </article>)}
    </section>
  </details>;
}
