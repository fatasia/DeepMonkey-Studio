import { useEffect, useRef, useState } from "react";
import type { ModelRecord } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { translate as tr, type AppLocale } from "../i18n";

/** 复用主 Viewer，预览姿态不写回项目或场景。 */
export function RobotAssetPreview({ locale, model, onReady, label }: {
  locale: AppLocale; model: ModelRecord; onReady: (engine: ViewerEngine | undefined) => void; label?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!host.current || !model.manifest) return;
    const container = host.current; const manifest = model.manifest;
    let closed = false; let viewer: ViewerEngine | undefined;
    setLoading(true); setError(""); onReady(undefined);
    void import("../viewer/ViewerEngine").then(async ({ ViewerEngine }) => {
      const engine = await ViewerEngine.create(container, "webgl");
      if (closed) { engine.dispose(); return; }
      viewer = engine;
      engine.setReadOnly(true);
      engine.setInteractionScripts([]);
      await engine.loadManifest(manifest);
      if (closed) return;
      engine.focusModel(model.id); onReady(engine); setLoading(false);
    }).catch(reason => {
      if (!closed) { onReady(undefined); setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)); }
    });
    return () => { closed = true; onReady(undefined); viewer?.dispose(); };
  }, [model.id, model.updatedAt, retry, onReady]);
  return <div className="robot-asset-viewport" aria-label={label ?? tr(locale, "机器人预览", "Robot preview")}>
    <div className="robot-asset-canvas" ref={host} />
    {loading && <span className="robot-asset-feedback" role="status">{tr(locale, "正在加载…", "Loading…")}</span>}
    {error && <div className="robot-asset-feedback" role="alert"><span>{error}</span><button className="button" onClick={() => setRetry(value => value + 1)}>{tr(locale, "重试", "Retry")}</button></div>}
  </div>;
}
