import { ArrowLeft } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";

export function SecondaryPageBack({ locale, onBack }: { locale: AppLocale; onBack: () => void }) {
  const label = tr(locale, "返回场景管理", "Back to scenes");

  return <button type="button" className="secondary-page-back" onClick={onBack} title={label} aria-label={label}>
    <ArrowLeft aria-hidden="true" />
    <span>{tr(locale, "返回", "Back")}</span>
  </button>;
}
