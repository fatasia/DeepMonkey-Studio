import { Focus, MessageCircleWarning } from "lucide-react";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import type { BimAssistantAction } from "./BimAssistantEvidence";
import { translate as tr, type AppLocale } from "../i18n";
import "./AiHarnessCards.css";

const CANDIDATE_LIMIT = 6;

/**
 * T3（审计 §二 2.1）：bim 模式 confidence=insufficient 时不再"不问就答"——
 * 就地给出"匹配到 N 个候选构件，请选择"卡：候选点选即定位确认（复用既有
 * BimAssistantAction 的 focus 动作语义，不新增第二套定位通道）；
 * 零命中时如实说明并引导改述（名称/楼层/类别），不伪造匹配。
 * 非 insufficient 置信度渲染 null（精确/推断匹配走 BimAssistantEvidence 快照卡即可）。
 */
export function AiBimClarificationCard({ locale, evidence, onAction }: {
  locale: AppLocale;
  evidence: BimAssistantPreparedContext;
  onAction?: (action: BimAssistantAction, context: BimAssistantPreparedContext, componentId?: string) => void;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  if (evidence.confidence !== "insufficient") return null;
  const candidates = evidence.matches.slice(0, CANDIDATE_LIMIT);
  return (
    <section className="ai-card ai-card-clarification" aria-label={t("构件匹配确认", "Component match confirmation")}>
      <header className="ai-card-header">
        <span className="ai-card-title">
          <MessageCircleWarning size={15} aria-hidden="true" />
          {t("未找到明确匹配的构件", "No exact component match")}
        </span>
        {evidence.matchCount > 0 && <span className="ai-card-badge badge-inconclusive">{t(`${evidence.matchCount} 个候选`, `${evidence.matchCount} candidates`)}</span>}
      </header>
      <div className="ai-card-body">
        {evidence.matchCount > 0
          ? <p>{t("以下候选来自关键词匹配；点选可定位确认。若都不是目标，请改述名称、楼层或类别后重新提问。", "Candidates below come from keyword matching; select one to focus and confirm. If none is the target, rephrase the name, level, or category.")}</p>
          : <p>{t("本次没有匹配到构件。请补充构件名称、所在楼层或系统类别后重新提问。", "No components matched. Add the component name, level, or system category and ask again.")}</p>}
        {candidates.length > 0 && (
          <div className="ai-clarification-options">
            {candidates.map((item) => (
              <button key={`${item.modelId}:${item.id}`} type="button" disabled={!onAction}
                title={[item.level, item.space?.name, item.category || item.type].filter(Boolean).join(" · ")}
                onClick={() => onAction?.("focus", evidence, item.id)}>
                <Focus size={11} aria-hidden="true" />
                {item.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
