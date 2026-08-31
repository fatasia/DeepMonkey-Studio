import { useEffect, useRef } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  ClipboardCheck,
  FlaskConical,
  Focus,
} from "lucide-react";
import type { IndustrialDiagnosisResult } from "@bim-studio/contracts";
import "./MaintenanceDiagnosisCard.css";

interface Props {
  diagnosis: IndustrialDiagnosisResult;
  busy: boolean;
  canFocus: boolean;
  onCreateCase: () => void;
  onOpenValidation: () => void;
  onFocus: () => void;
}

/** 普通用户先看到结论和下一步，模型证据按需展开，避免把 AI 做成参数面板。 */
export function MaintenanceDiagnosisCard({
  diagnosis,
  busy,
  canFocus,
  onCreateCase,
  onOpenValidation,
  onFocus,
}: Props) {
  const cardRef = useRef<HTMLElement>(null);
  const requiresData =
    diagnosis.decisionStatus === "insufficient-data" ||
    diagnosis.decisionStatus === "drift-blocked";
  const requiresAction =
    diagnosis.severity === "warning" || diagnosis.severity === "critical";
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      cardRef.current?.scrollIntoView({ block: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [diagnosis.evidenceFingerprint]);

  return (
    <article
      ref={cardRef}
      className={`maintenance-diagnosis ${diagnosis.severity}`}
    >
      <header>
        <span className="maintenance-diagnosis-icon">
          <BrainCircuit size={18} />
        </span>
        <div>
          <small>
            AI 证据诊断 · 可信度 {(diagnosis.confidence * 100).toFixed(0)}%
          </small>
          <strong>{diagnosis.headline}</strong>
        </div>
        <span className="maintenance-diagnosis-status">
          {diagnosis.decisionStatus === "validated"
            ? "生产证据"
            : diagnosis.decisionStatus === "shadow"
              ? "影子验证"
              : "需补数据"}
        </span>
      </header>

      <p>{diagnosis.summary}</p>

      {diagnosis.hypotheses.length > 0 && (
        <section className="maintenance-hypotheses">
          <strong>优先验证</strong>
          {diagnosis.hypotheses.map((item) => (
            <div key={item.id}>
              <span>{item.rank}</span>
              <div>
                <b>{item.title}</b>
                <small>{item.rationale}</small>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="maintenance-diagnosis-actions">
        {!requiresData && requiresAction && (
          <button
            className="primary"
            disabled={busy}
            onClick={onOpenValidation}
          >
            <FlaskConical size={14} />
            虚拟验证
            <ArrowRight size={13} />
          </button>
        )}
        {!requiresData && requiresAction && (
          <button disabled={busy} onClick={onCreateCase}>
            <ClipboardCheck size={14} />
            创建维护 Case
          </button>
        )}
        {canFocus && (
          <button disabled={busy} onClick={onFocus}>
            <Focus size={14} />
            定位设备
          </button>
        )}
      </div>

      <details>
        <summary>
          <CheckCircle2 size={13} />
          查看模型依据与限制
        </summary>
        <div className="maintenance-diagnosis-evidence">
          <section>
            <strong>已知事实</strong>
            {diagnosis.facts.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </section>
          <section>
            <strong>
              <AlertTriangle size={12} />
              使用限制
            </strong>
            {diagnosis.limitations.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </section>
        </div>
      </details>
    </article>
  );
}
