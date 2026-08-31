import { Eye, Focus } from "lucide-react";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import { translate as tr, type AppLocale } from "../i18n";

export type BimAssistantAction = "focus" | "isolate" | "show-placement" | "clear-isolation" | "clear-placement";

interface BimAssistantEvidenceProps {
  locale: AppLocale;
  evidence: BimAssistantPreparedContext;
  onAction?: (action: BimAssistantAction, context: BimAssistantPreparedContext, componentId?: string) => void;
}

/** BIM 命中结果是客户端几何/属性快照，定位动作始终复用命中项的稳定对象身份。 */
export function BimAssistantEvidence({ locale, evidence, onAction }: BimAssistantEvidenceProps) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const confidence = evidence.confidence === "exact"
    ? t("精确匹配", "Exact")
    : evidence.confidence === "inferred"
      ? t("推断匹配", "Inferred")
      : t("信息不足", "Insufficient");

  return (
    <section className="bim-ai-evidence" aria-label={t("BIM 模型匹配快照", "BIM model match snapshot")}>
      <header>
        <strong>{t("模型匹配快照", "Model match snapshot")}</strong>
        <span>{evidence.matchCount} {t("个匹配", "matches")}</span>
      </header>
      <div className="bim-ai-summary">
        <span>{evidence.scene.componentCount} {t("构件", "components")}</span>
        <span>{evidence.scene.spaceCount} {t("空间", "spaces")}</span>
        <span>{confidence}</span>
      </div>
      {evidence.matches.slice(0, 8).map((item) => (
        <div className="bim-ai-match" key={`${item.modelId}:${item.id}`}>
          <span>
            <strong>{item.name}</strong>
            <small>{[item.level, item.space?.name, item.category || item.type].filter(Boolean).join(" · ")}</small>
          </span>
          {onAction && (
            <>
              <button
                aria-label={t(`定位 ${item.name}`, `Focus ${item.name}`)}
                title={t("定位", "Focus")}
                onClick={() => onAction("focus", evidence, item.id)}
              >
                <Focus size={12} />
              </button>
              <button
                aria-label={t(`隔离 ${item.name}`, `Isolate ${item.name}`)}
                title={t("隔离", "Isolate")}
                onClick={() => onAction("isolate", evidence, item.id)}
              >
                <Eye size={12} />
              </button>
            </>
          )}
        </div>
      ))}
      {evidence.placement && (
        <div className={`bim-ai-placement ${evidence.placement.status}`}>
          <strong>
            {evidence.placement.status === "fits"
              ? t("包围盒净空初筛：可试放", "Bounding-box clearance: candidate fits")
              : evidence.placement.status === "blocked"
                ? t("包围盒净空初筛：空间不足", "Bounding-box clearance: blocked")
                : t("净空信息不足", "Insufficient clearance data")}
          </strong>
          <small>{evidence.placement.note}</small>
          {onAction && evidence.placement.candidateCenter && (
            <button type="button" onClick={() => onAction("show-placement", evidence)}>
              {t("在三维场景显示试放体", "Show placement proxy in 3D")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
