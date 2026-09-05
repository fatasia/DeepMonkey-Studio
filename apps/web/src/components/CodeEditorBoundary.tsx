import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";

interface CodeEditorBoundaryProps {
  locale: AppLocale;
  value: string;
  children: ReactNode;
  onChange: (value: string) => void;
  onSave?: () => void;
  onRun?: () => void;
}

export class CodeEditorBoundary extends Component<CodeEditorBoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Professional code editor failed; using the safe editor fallback", error, info);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="professional-code-fallback" role="alert">
        <div>
          <TriangleAlert size={14} />
          <span>
            <strong>{tr(this.props.locale, "代码智能服务加载失败", "Code intelligence failed to load")}</strong>
            <small>{tr(this.props.locale, "已切换到安全编辑模式，代码仍可编辑和保存。", "Safe editing mode is active; code can still be edited and saved.")}</small>
          </span>
        </div>
        <textarea value={this.props.value} onChange={(event) => this.props.onChange(event.target.value)} spellCheck={false} />
        <footer>
          {this.props.onRun && <button onClick={this.props.onRun}>{tr(this.props.locale, "运行", "Run")}</button>}
          {this.props.onSave && (
            <button className="primary" onClick={this.props.onSave}>
              {tr(this.props.locale, "保存", "Save")}
            </button>
          )}
          <button onClick={() => this.setState({ error: null })}>{tr(this.props.locale, "重试智能编辑器", "Retry smart editor")}</button>
        </footer>
      </div>
    );
  }
}
