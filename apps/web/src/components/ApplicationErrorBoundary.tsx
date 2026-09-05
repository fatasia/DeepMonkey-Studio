import { Component, type ReactNode } from "react";
import "../styles/applicationError.css";

export function ApplicationErrorFallback({ startup = false }: { startup?: boolean }) {
  const english = typeof document !== "undefined" && document.documentElement.lang.startsWith("en");
  return (
    <main className="application-error" role="alert">
      <section>
        <span className="application-error-symbol" aria-hidden="true">!</span>
        <p className="application-error-kicker">Deep Monkey Studio</p>
        <h1>{english ? startup ? "Unable to start the application" : "This page could not be displayed"
          : startup ? "应用未能启动" : "当前页面暂时无法显示"}</h1>
        <p>{english
          ? "Reload this page to try again. Unsaved changes may not be recoverable. No project data will be deleted by this action."
          : "请刷新当前页面后重试。尚未保存的修改可能无法恢复，此操作不会删除项目数据。"}</p>
        <button type="button" onClick={() => window.location.reload()}>{english ? "Reload page" : "刷新当前页面"}</button>
        <small>{english ? "If this continues, share this error code with the project maintainer: " : "若仍无法打开，请将以下错误编号反馈给维护人员："}
          <code>{startup ? "STUDIO_STARTUP_FAILED" : "STUDIO_RENDER_FAILED"}</code>
        </small>
      </section>
    </main>
  );
}

/** Covers React render/lazy-load failures; never reloads automatically or clears drafts. */
export class ApplicationErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error) { console.error("STUDIO_RENDER_FAILED", error); }
  override render() { return this.state.failed ? <ApplicationErrorFallback /> : this.props.children; }
}
