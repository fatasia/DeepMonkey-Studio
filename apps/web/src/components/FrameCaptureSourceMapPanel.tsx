import { useMemo, useState } from "react";
import { Braces, Camera, Search } from "lucide-react";
import type { FrameCaptureRecord, FrameCaptureStage, PbrFrameReadbackResult, PbrFrameReadbackSnapshot } from "@bim-studio/deep-engine";
import { isPbrFrameReadbackSnapshot } from "@bim-studio/deep-engine";
import { translate as tr, type AppLocale } from "../i18n";
import { frameReadbackExportFormat, frameReadbackPngBlob } from "../viewer/frameReadbackPng";
import type { StudioFrameReadbackEntry } from "../viewer/studioFrameCaptureDiagnostics";

interface Props {
  locale: AppLocale;
  available: boolean;
  records: readonly FrameCaptureRecord[];
  readbacks?: readonly StudioFrameReadbackEntry[] | undefined;
}

interface SourceMapRow {
  readonly key: string;
  readonly frameId: string;
  readonly passId: string;
  readonly moduleId: string;
  readonly stage: FrameCaptureStage;
  readonly nodeId: string;
  readonly generatedLine: number;
}

export function FrameCaptureSourceMapPanel({ locale, available, records, readbacks }: Props) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<"all" | FrameCaptureStage>("all");
  const [exportError, setExportError] = useState<string | undefined>();
  const rows = useMemo(() => flattenSourceMaps(records), [records]);
  const readbackRows = useMemo(() => flattenReadbacks(readbacks ?? []), [readbacks]);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = rows.filter(row => (stage === "all" || row.stage === stage)
    && (!normalized || `${row.moduleId} ${row.nodeId} ${row.passId} ${row.frameId} ${row.generatedLine}`.toLocaleLowerCase().includes(normalized)));

  const downloadSnapshot = async (result: PbrFrameReadbackResult) => {
    setExportError(undefined);
    if (!isPbrFrameReadbackSnapshot(result)) return;
    const snapshot: PbrFrameReadbackSnapshot = result;
    const blob = await frameReadbackPngBlob(snapshot);
    if (blob === undefined) {
      setExportError(tr(locale, `格式 ${snapshot.format} 暂不支持导出。`, `Format ${snapshot.format} cannot be exported yet.`));
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `deep-${snapshot.resourceId}-${snapshot.frameId}.png`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="renderer-source-map" aria-label={tr(locale, "作者 Source Map", "Author source map")}>
      <header>
        <span><Braces size={14} /><strong>{tr(locale, "作者 Source Map", "Author source map")}</strong></span>
        <small>{records.length} {tr(locale, "帧", "frames")} · {rows.length} {tr(locale, "映射", "mappings")}</small>
      </header>
      {!available ? (
        <p className="renderer-source-map-empty">
          {tr(locale, "仅在本面板打开时启用 Deep 才开始捕获；普通编辑不采集。", "Capture starts only when Deep is enabled while this panel is open; normal editing is not recorded.")}
        </p>
      ) : rows.length === 0 ? (
        <p className="renderer-source-map-empty">{tr(locale, "等待 Deep 渲染帧中的作者映射…", "Waiting for author mappings from a Deep render frame…")}</p>
      ) : (
        <>
          <div className="renderer-source-map-query">
            <label><Search size={13} /><input value={query} onChange={event => setQuery(event.currentTarget.value)}
              placeholder={tr(locale, "模块、节点、Pass 或行号", "Module, node, pass, or line")} /></label>
            <select aria-label={tr(locale, "着色阶段", "Shader stage")} value={stage}
              onChange={event => setStage(event.currentTarget.value as typeof stage)}>
              <option value="all">{tr(locale, "全部阶段", "All stages")}</option>
              <option value="vertex">Vertex</option>
              <option value="fragment">Fragment</option>
            </select>
          </div>
          {matches.length ? <ol className="renderer-source-map-results">
            {matches.slice(-40).reverse().map(row => <li key={row.key}>
              <span><strong>{row.moduleId}</strong><small>{row.nodeId}</small></span>
              <code>{row.stage}:{row.generatedLine}</code>
              <small>{row.frameId} · {row.passId}</small>
            </li>)}
          </ol> : <p className="renderer-source-map-empty">{tr(locale, "没有匹配的作者映射。", "No author mappings match.")}</p>}
        </>
      )}
      <section className="renderer-readback-snapshots" aria-label={tr(locale, "资源快照", "Resource snapshots")}>
        <header>
          <span><Camera size={13} /><strong>{tr(locale, "资源快照", "Resource snapshots")}</strong></span>
          <small>{tr(locale, "每帧有界读回，仅诊断用途", "Bounded per-frame readback, diagnostics only")}</small>
        </header>
        {readbackRows.length === 0 ? (
          <p className="renderer-source-map-empty">
            {tr(locale, "等待 Deep 渲染帧的资源快照…", "Waiting for Deep render-frame resource snapshots…")}
          </p>
        ) : (
          <ol className="renderer-source-map-results">
            {readbackRows.slice(-12).reverse().map(row => <li key={row.key} data-testid="frame-readback-row">
              <span><strong>{row.resourceId}</strong>
                <small>{row.exportable
                  ? tr(locale, "点击下载 PNG", "Click to download PNG")
                  : tr(locale, "该格式暂不支持导出", "This format cannot be exported yet")}</small></span>
              <code>{row.width}×{row.height} · {row.format}</code>
              <button type="button" disabled={!row.exportable} onClick={() => void downloadSnapshot(row.result)}>
                {isSnapshot(row.result)
                  ? `${tr(locale, "下载", "Download")} PNG`
                  : tr(locale, "不可用", "Unavailable")}
              </button>
              {!isSnapshot(row.result) ? <small title={row.reason}>{row.reason}</small> : null}
            </li>)}
          </ol>
        )}
        {exportError ? <p className="renderer-source-map-empty">{exportError}</p> : null}
        <p className="renderer-source-map-empty">
          {tr(locale, "HDR 快照经 Reinhard 近似色调映射导出，不等同最终 ACES 显示效果。",
            "HDR snapshots are exported with an approximate Reinhard tonemap; they are not the final ACES display output.")}
        </p>
      </section>
    </section>
  );
}

export function flattenSourceMaps(records: readonly FrameCaptureRecord[]): readonly SourceMapRow[] {
  return records.flatMap(frame => frame.passes.flatMap(pass => pass.sourceMapRefs.map((sourceMap, index) => ({
    key: `${frame.frameId}|${pass.passId}|${sourceMap.moduleId}|${sourceMap.stage}|${sourceMap.nodeId}|${sourceMap.generatedLine}|${index}`,
    frameId: frame.frameId,
    passId: pass.passId,
    ...sourceMap,
  }))));
}

interface ReadbackRow {
  readonly key: string;
  readonly resourceId: string;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly format: string | undefined;
  readonly reason: string | undefined;
  readonly exportable: boolean;
  readonly result: PbrFrameReadbackResult;
}

function isSnapshot(result: PbrFrameReadbackResult): boolean {
  return isPbrFrameReadbackSnapshot(result);
}

export function flattenReadbacks(entries: readonly StudioFrameReadbackEntry[]): readonly ReadbackRow[] {
  return entries.flatMap(entry => entry.results.map(result => {
    const snapshot = isSnapshot(result) ? result as Extract<typeof result, { bytes: Uint8Array }> : undefined;
    return {
      key: `${entry.receivedAtMs}|${result.frameId}|${result.resourceId}`,
      resourceId: result.resourceId,
      width: snapshot?.width,
      height: snapshot?.height,
      format: snapshot?.format,
      reason: isSnapshot(result) ? undefined : (result as { reason: string }).reason,
      exportable: snapshot !== undefined && frameReadbackExportFormat(snapshot) !== undefined,
      result,
    };
  }));
}
