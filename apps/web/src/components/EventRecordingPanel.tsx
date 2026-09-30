import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Download, RefreshCw } from "lucide-react";
import { assessEventRecording, flattenEventRecordingEntries, type EventRecordingFile, type EventRecordingManifest, type IndustrialStudyRecord } from "@bim-studio/contracts";
import { downloadTextFile } from "../browserDownload";
import { checkedRecording, parseRecordingEvent, recordingEvents, recordingStudyCopy, recordingUrl, type RecordingAxis, type RecordingRequest } from "./eventRecordingPanelModel";
import "./EventRecordingPanel.css";

/** Event-level evidence; injected transport keeps production auth and local API selection. */
export function EventRecordingPanel({ projectId, request, studies }: { projectId: string; request: RecordingRequest; studies: IndustrialStudyRecord[] }) {
  const [items, setItems] = useState<EventRecordingManifest[]>([]);
  const [file, setFile] = useState<EventRecordingFile>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [origin, setOrigin] = useState<"injected" | "simulation">("injected");
  const [frameStep, setFrameStep] = useState("");
  const [eventText, setEventText] = useState('{"source":"manual","key":"temperature","value":27,"sequence":1}');
  const [resumeText, setResumeText] = useState('{"connectionId":"manual-origin","generation":1,"lastSequence":null,"lastTimestamp":null}');
  const [axis, setAxis] = useState<RecordingAxis>("all");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [studyId, setStudyId] = useState("");
  const active = useRef(true); const busy = useRef(false);
  const selection = useRef(0);
  const base = recordingUrl(projectId);
  useEffect(() => { active.current = true; return () => { active.current = false; selection.current++; }; }, []);
  function accept(value: unknown) {
    const next = checkedRecording(value, projectId); setFile(next);
    setItems(current => [next.manifest, ...current.filter(item => item.recordingId !== next.manifest.recordingId)]);
    return next;
  }
  async function run(label: string, action: () => Promise<void>, mutation = false) {
    if (busy.current) return; busy.current = true; setPending(label); setError(undefined); setNotice(undefined);
    try { await action(); if (active.current) setNotice(`${label}完成`); }
    catch (reason) { if (active.current) setError(`${reason instanceof Error ? reason.message : String(reason)}${mutation ? "；写入结果请重读核对，勿直接重复提交。" : ""}`); }
    finally { busy.current = false; if (active.current) setPending(undefined); }
  }
  async function refresh() {
    const result = await request<{ items: { manifest: EventRecordingManifest }[] }>(base);
    if (active.current) setItems(result.items.map(item => item.manifest));
  }
  useEffect(() => { void run("读取录制", refresh); }, [base, request]);
  async function open(id: string) {
    const revision = ++selection.current;
    const result = await request<{ recording: unknown }>(recordingUrl(projectId, id));
    if (active.current && revision === selection.current) { accept(result.recording); setAxis("all"); }
  }
  async function mutate(suffix: string, body?: unknown) {
    const result = await request<{ recording: unknown }>(suffix === "" ? base : `${recordingUrl(projectId, file!.manifest.recordingId)}/${suffix}`, {
      method: "POST", ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    // /record nests the existing assessment response inside its receipt.
    const value = suffix === "record" ? (result.recording as { recording: unknown }).recording : result.recording;
    if (active.current) accept(value);
  }
  const assessment = useMemo(() => file ? assessEventRecording(file) : undefined, [file]);
  const allEntries = useMemo(() => file ? flattenEventRecordingEntries(file) : [], [file]);
  const filtered = useMemo(() => {
    try { return { events: file ? recordingEvents(file, axis, from, to) : [], error: undefined }; }
    catch (reason) { return { events: [], error: reason instanceof Error ? reason.message : String(reason) }; }
  }, [file, axis, from, to]);
  const openSegment = file?.segments.some(segment => segment.closedAt === null);
  const selectedStudy = studies.find(study => study.id === studyId && study.projectId === projectId);
  const notes = allEntries.filter(entry => entry.kind !== "event");
  function create() {
    void run("建立录制", async () => {
      const step = Number(frameStep);
      if (frameStep.trim() && (!Number.isFinite(step) || step <= 0)) throw new Error("帧步长须为正数，单位 ms");
      await mutate("", { sourceOrigin: origin, frameMapping: frameStep.trim() ? { frameStepMs: step, mode: "floor" } : null });
    }, true);
  }
  function exportStudy() {
    if (!file || !selectedStudy) return;
    try {
      const copy = recordingStudyCopy(selectedStudy, file);
      downloadTextFile(JSON.stringify(copy, null, 2), `${file.manifest.recordingId}-study-evidence.json`, "application/json");
      setNotice("已导出运行记录的证据副本"); setError(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <section className="event-recording" aria-label="事件持久录制" aria-busy={Boolean(pending)}>
    <header><span><strong>事件录制</strong><small>持久事件 · 缺口 · 重开接缝</small></span><button type="button" disabled={Boolean(pending)} onClick={() => void run("刷新清单", refresh)}><RefreshCw size={14} />刷新清单</button></header>
    <div className="event-recording-toolbar">
      <label>历史录制<select value={file?.manifest.recordingId ?? ""} disabled={Boolean(pending)} onChange={event => event.target.value && void run("读取历史", () => open(event.target.value))}><option value="">选择录制</option>{items.map(item => <option key={item.recordingId} value={item.recordingId}>{item.recordingId} · {item.totals.eventCount} 条</option>)}</select></label>
      <label>新录制来源<select value={origin} onChange={event => setOrigin(event.target.value as typeof origin)}><option value="injected">注入事件</option><option value="simulation">仿真事件</option></select></label>
      <button type="button" className="event-recording-primary" disabled={Boolean(pending)} onClick={create}><Circle size={13} />建立录制</button>
    </div>
    <details><summary>可选帧映射</summary><label>固定帧步长（ms）<input type="number" min="0.001" step="any" value={frameStep} onChange={event => setFrameStep(event.target.value)} placeholder="留空表示无帧映射" /></label><small>按工业时间映射，向下取整；只作用于新录制。</small></details>
    {pending && <p role="status">{pending}中…</p>}
    {error && <p role="alert"><AlertTriangle size={14} />{error}<button type="button" disabled={Boolean(pending)} onClick={() => void run("重读核对", () => file ? open(file.manifest.recordingId) : refresh())}>重读核对</button></p>}
    {notice && <p className="event-recording-notice" role="status">{notice}</p>}
    {!file ? <div className="event-recording-empty"><Circle size={22} /><strong>记录每条事件，保留每个缺口</strong><p>建立注入或仿真录制，或选择已保存的历史录制。事件录制与实时订阅分别管理。</p></div> : <>
      <div className={`event-recording-integrity ${!assessment?.integrityOk ? "invalid" : assessment.completeness === "gapped" || assessment.completeness === "open-unknown" ? "warning" : "verified"}`}>
        {assessment?.integrityOk && assessment.completeness !== "gapped" && assessment.completeness !== "open-unknown" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}<strong>{assessment?.integrityOk ? completenessLabel(assessment.completeness) : "完整性校验失败"}</strong><span>{file.manifest.sourceOrigin === "subscription" ? "订阅来源" : file.manifest.sourceOrigin === "simulation" ? "仿真来源" : "注入来源"}</span><span>{assessment?.integrity.sourceSequenceKnown ? "源序已知" : "源序未知 · 到达序不代表源序"}</span>
      </div>
      {assessment?.mismatches.map(message => <p role="alert" key={message}>{message}</p>)}
      <div className="event-recording-counts"><span>事件 <b>{assessment?.totals.eventCount}</b></span><span>缺口 <b>{assessment?.totals.gapCount}</b></span><span>乱序 <b>{assessment?.totals.outOfOrderCount}</b></span><span>接缝 <b>{assessment?.totals.seamCount}</b></span><span>录制段 <b>{file.segments.length}</b></span></div>
      <div className="event-recording-actions"><button type="button" disabled={Boolean(pending)} onClick={() => void run("重读核对", () => open(file.manifest.recordingId))}>重读文件</button><button type="button" disabled={Boolean(pending) || !openSegment} title={!openSegment ? "录制段已关闭" : undefined} onClick={() => void run("关闭录制段", () => mutate("close"), true)}>关闭录制段</button><button type="button" onClick={() => { downloadTextFile(JSON.stringify(file, null, 2), `${file.manifest.recordingId}.json`, "application/json"); setNotice("已导出录制文件"); }}><Download size={13} />导出录制</button></div>
      <details><summary>{openSegment ? "写入一条事件" : "重开录制段"}</summary>
        {openSegment ? <><small>source、key、value 必填；源序未知时省略 sequence。timestamp 留空使用写入时钟，sceneId 可选。</small><textarea aria-label="录制事件 JSON" rows={3} value={eventText} onChange={event => setEventText(event.target.value)} /><button type="button" disabled={Boolean(pending) || file.manifest.sourceOrigin === "subscription"} title={file.manifest.sourceOrigin === "subscription" ? "订阅来源的历史录制不在此入口写入注入事件" : undefined} onClick={() => void run("写入事件", () => mutate("record", parseRecordingEvent(eventText)), true)}>写入并落盘</button></>
          : <><small>填写真实恢复出处；手工重开不代替订阅 checkpoint。未知源序和时间保持 null。</small><textarea aria-label="重开出处 JSON" rows={3} value={resumeText} onChange={event => setResumeText(event.target.value)} /><button type="button" disabled={Boolean(pending)} onClick={() => void run("重开录制段", () => mutate("resume", { ...JSON.parse(resumeText), reason: "manual-reopen" }), true)}>手工重开</button></>}
      </details>
      <div className="event-recording-filter"><label>回放对齐<select value={axis} onChange={event => { setAxis(event.target.value as RecordingAxis); setFrom(""); setTo(""); }}><option value="all">全部事件</option><option value="time">工业时间</option><option value="sequence">源序范围</option><option value="frame" disabled={!file.manifest.frameMapping}>帧轴{!file.manifest.frameMapping ? "（未声明映射）" : ""}</option></select></label>
        {axis !== "all" && <label>{axis === "frame" ? "帧号" : "起始"}<input aria-label="对齐起始" type={axis === "time" ? "datetime-local" : "number"} min="0" value={from} onChange={event => setFrom(event.target.value)} /></label>}{axis !== "all" && axis !== "frame" && <label>终止<input aria-label="对齐终止" type={axis === "time" ? "datetime-local" : "number"} min="0" value={to} onChange={event => setTo(event.target.value)} /></label>}
      </div>
      {filtered.error && <p role="alert">{filtered.error}</p>}
      <div className="event-recording-table"><table><thead><tr><th>工业时间</th><th>序</th><th>来源 / 信号</th><th>值</th></tr></thead><tbody>{filtered.events.slice(0, 100).map((entry, index) => <tr key={`${entry.monotonicMs}:${index}`}><td>{new Date(entry.industrialTime).toLocaleString("zh-CN", { hour12: false })}</td><td>{entry.sequenceAssigned ? `到达 ${entry.sequence}` : entry.sequence}</td><td>{entry.event.source} / {entry.event.key}</td><td>{JSON.stringify(entry.event.value)}</td></tr>)}</tbody></table></div>
      <small>匹配 {filtered.events.length} 条，展示前 100 条；回放检查只读，不向设备重发事件。</small>
      {!!notes.length && <details><summary>缺口、乱序与接缝（{notes.length}）</summary><pre>{JSON.stringify(notes.slice(0, 100), null, 2)}</pre></details>}
      <details><summary>Study 证据副本</summary><small>追加录制指纹到运行记录只读副本，同时携带完整性评估与录制文件。</small><label>运行记录<select value={studyId} onChange={event => setStudyId(event.target.value)}><option value="">选择已完成记录</option>{studies.filter(study => study.projectId === projectId && study.result).map(study => <option key={study.id} value={study.id}>{study.title}</option>)}</select></label><button type="button" disabled={!selectedStudy || !assessment?.integrityOk} title={!selectedStudy ? "先选择已有结果的运行记录" : undefined} onClick={exportStudy}>导出证据副本</button></details>
    </>}
  </section>;
}

function completenessLabel(value: string) {
  return ({ continuous: "段已闭合 · 无已知缺口", gapped: "存在缺口或乱序", "open-unknown": "完整性未知", open: "录制中 · 尚未闭合" } as Record<string, string>)[value] ?? value;
}
