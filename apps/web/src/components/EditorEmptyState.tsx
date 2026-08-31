import type { CSSProperties, ReactNode } from "react";
import "./EditorEmptyState.css";

interface EditorEmptyStateAction {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}

interface EditorEmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  primaryAction: EditorEmptyStateAction;
  secondaryAction?: EditorEmptyStateAction;
  hint?: string;
  variant: "canvas" | "panel";
  /** 画布自身缩放时传入逆比例，让空态仍保持真实屏幕尺寸。 */
  displayScale?: number;
}

/** 2D、3D 编辑器共用的可行动空态，主操作始终对应最快的起步路径。 */
export function EditorEmptyState(props: EditorEmptyStateProps) {
  return (
    <section
      className={`editor-empty-state ${props.variant}`}
      aria-label={props.title}
      style={props.displayScale ? ({ "--editor-empty-scale": props.displayScale } as CSSProperties) : undefined}
    >
      <span className="editor-empty-icon">{props.icon}</span>
      <strong>{props.title}</strong>
      <p>{props.description}</p>
      <div>
        <button type="button" className="primary" onClick={props.primaryAction.onClick}>
          {props.primaryAction.icon}{props.primaryAction.label}
        </button>
        {props.secondaryAction && (
          <button type="button" onClick={props.secondaryAction.onClick}>
            {props.secondaryAction.icon}{props.secondaryAction.label}
          </button>
        )}
      </div>
      {props.hint && <small>{props.hint}</small>}
    </section>
  );
}
