import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CircleStop } from "lucide-react";
import type { ProjectRecord } from "@bim-studio/contracts";
import type { ApplicationPlaybackSession } from "../behavior/ApplicationPlaybackSession";
import { PlaybackContext } from "../behavior/playbackContext";
import { PlaybackView } from "./DashboardPlayback";
import { translate as tr, type AppLocale } from "../i18n";
import type { RendererBackend } from "../viewer/ViewerEngine";
import { subscribeApplicationInteractionEffects } from "../studio/applicationInteractionHost";
import "./AuthorBehaviorPreview.css";

export function AuthorBehaviorPreview({ session, project, locale, rendererBackend, onStop }: {
  session: ApplicationPlaybackSession; project: ProjectRecord; locale: AppLocale; rendererBackend: RendererBackend; onStop: () => void;
}) {
  const [host, setHost] = useState<Element | null>(null);
  const [pageId, setPageId] = useState(session.currentPageId);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    // The preview covers only the adjacent work surface; code and console stay usable.
    setHost(document.querySelector(".app-workspace-surface"));
  }, []);
  const application = session.state.document;
  useEffect(() => subscribeApplicationInteractionEffects(({ action }) => {
    if (action.type === "dashboard" || action.type === "navigateScene") {
      const target = session.state.document.pages.find(page => action.type === "dashboard" ? page.id === action.dashboardPageId : page.nodes.some(node => node.kind === "scene-viewport" && node.sceneId === action.sceneId));
      if (target) { setPageId(target.id); session.selectPage(target.id); setNotice(""); }
      else setNotice(tr(locale, "目标未包含在试运行页面中，编辑工作区未切换。", "The target is not in this test. The editor was not navigated."));
    } else if (action.type === "message") setNotice(String(action.value ?? ""));
    else if (action.type === "openUrl") setNotice(tr(locale, "试运行已拦截外部跳转；请在正式浏览中验证该链接。", "External navigation was blocked in this test. Verify the link in application playback."));
  }, session.effects), [session, locale]);
  const page = application.pages.find(page => page.id === pageId) ?? application.pages[0];
  if (!host || !page) return null;
  return createPortal(<section className="author-behavior-preview" aria-label={tr(locale, "脚本隔离预览", "Isolated script preview")}>
    <header>
      <div><strong>{tr(locale, "试运行预览", "Test preview")}</strong><small>{tr(locale, "运行修改不写入草稿", "Runtime changes are not saved")}</small></div>
      {application.pages.length > 1 && <select aria-label={tr(locale, "试运行页面", "Test page")} value={page.id} onChange={event => { setPageId(event.target.value); session.selectPage(event.target.value); }}>
        {application.pages.map(page => <option value={page.id} key={page.id}>{page.name}</option>)}
      </select>}
      <button type="button" onClick={onStop} aria-label={tr(locale, "停止并返回编辑", "Stop and return to editing")} title={tr(locale, "停止并返回编辑", "Stop and return to editing")}><CircleStop size={15} /></button>
    </header>
    {notice && <p role="status" className="author-behavior-notice">{notice}</p>}
    <div className="author-behavior-preview-surface"><PlaybackContext.Provider value={session}>
      <PlaybackView session={session} locale={locale} application={application} project={project} page={page} rendererBackend={rendererBackend}
        metrics={{}} variables={session.state.variables} filters={session.state.filters} connected={false}
        onClose={onStop} onPublish={() => undefined} onSelectPage={id => { setPageId(id); session.selectPage(id); }}
        onSelectionChange={() => undefined} onFilterChange={() => undefined} onVariableChange={() => undefined} onObjectInteraction={() => undefined} onNodeInteraction={() => undefined} />
    </PlaybackContext.Provider></div>
  </section>, host);
}
