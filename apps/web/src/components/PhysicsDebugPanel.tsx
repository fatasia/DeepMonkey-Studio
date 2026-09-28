import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Pause, Play, StepForward, Trash2, X } from "lucide-react";
import type { ScenePhysicsState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { DeferredNumberInput } from "./AppFormControls";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import type { PhysicsDebugBodySnapshot, PhysicsDebugJointSnapshot, PhysicsDebugSnapshot } from "../viewer/physicsDebugSnapshot";
import type { PhysicsPoseFrame } from "../viewer/physicsPoseRecorder";
import { parsePhysicsPoseJson, type ParsedPoseSeries } from "../viewer/physicsPoseRecorder";
import { comparePoseSeries, type PoseCompareResult } from "../viewer/physicsPoseCompare";
import "./PhysicsDebugPanel.css";

interface PhysicsDebugPanelProps {
  locale: AppLocale;
  /** 关闭后面板缩为启动芯片；由工作区持有状态以免随物理面板开关丢失。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  engine: ViewerEngine | undefined;
  /** 物理总开关/播放状态来自工作区物理状态，播放控制与其共用一条变更路径。 */
  physics: ScenePhysicsState;
  onPhysicsChange: (next: ScenePhysicsState) => void;
  debugVisible: boolean;
  onDebugVisibleChange: (visible: boolean) => void;
}

/** 面板容器：轮询引擎快照并持有 UI 状态；展示层在 PhysicsDebugPanelView（无 hooks）。 */
export function PhysicsDebugPanel(props: PhysicsDebugPanelProps) {
  const { open, engine, physics } = props;
  const [snapshot, setSnapshot] = useState<PhysicsDebugSnapshot | undefined>();
  const [recording, setRecording] = useState<{ frameCount: number; capacity: number; frames: readonly PhysicsPoseFrame[] } | undefined>();
  const [isRecording, setIsRecording] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [capacity, setCapacity] = useState(DEFAULT_RECORD_CAPACITY);
  const [manualSteps, setManualSteps] = useState(10);
  const [replayStep, setReplayStep] = useState<number | null>(null);
  const [toleranceMm, setToleranceMm] = useState(5);
  const [toleranceMrad, setToleranceMrad] = useState(20);
  const [seriesA, setSeriesA] = useState<ParsedPoseSeries | undefined>();
  const [seriesB, setSeriesB] = useState<ParsedPoseSeries | undefined>();
  const [importError, setImportError] = useState<string | undefined>();
  const [curveMetric, setCurveMetric] = useState<"position" | "rotation">("position");

  // 面板打开时以 250 ms 轮询引擎快照（纯读取），关闭即停止，物理数据面零轮询。
  useEffect(() => {
    if (!open || !engine) return;
    const poll = () => {
      setSnapshot(engine.getPhysicsDebugSnapshot());
      setRecording(engine.getPhysicsRecording());
      setIsRecording(engine.isPhysicsRecording());
      setIsReplaying(engine.isPhysicsReplaying());
    };
    poll();
    const timer = window.setInterval(poll, 250);
    return () => window.clearInterval(timer);
  }, [open, engine]);

  // 播放中引擎会清除回放覆盖；同步本地滑块状态。
  useEffect(() => {
    if (!isReplaying) setReplayStep(null);
  }, [isReplaying]);

  const importSeries = async (slot: "a" | "b", file: File) => {
    try {
      const parsed = parsePhysicsPoseJson(await file.text(), file.name);
      setImportError(undefined);
      if (slot === "a") setSeriesA(parsed); else setSeriesB(parsed);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };

  const useRecordingForSlotA = () => {
    const text = engine?.exportPhysicsPoseJson();
    if (!text) return;
    try {
      setSeriesA(parsePhysicsPoseJson(text, "当前录制 (web)"));
      setImportError(undefined);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };

  const applyReplayFrame = (step: number) => {
    const frames = recording?.frames;
    if (!frames || frames.length === 0) return;
    const clamped = Math.min(Math.max(step, 1), frames.length);
    engine?.setPhysicsReplayFrame(frames[clamped - 1]);
    setReplayStep(clamped);
  };

  return (
    <PhysicsDebugPanelView
      locale={props.locale}
      open={open}
      onOpenChange={props.onOpenChange}
      engine={engine}
      physics={physics}
      onPhysicsChange={props.onPhysicsChange}
      debugVisible={props.debugVisible}
      onDebugVisibleChange={props.onDebugVisibleChange}
      snapshot={snapshot}
      recording={recording}
      isRecording={isRecording}
      isReplaying={isReplaying}
      capacity={capacity}
      onCapacityChange={setCapacity}
      manualSteps={manualSteps}
      onManualStepsChange={setManualSteps}
      replayStep={replayStep}
      onApplyReplayFrame={applyReplayFrame}
      onExitReplay={() => engine?.setPhysicsReplayFrame(undefined)}
      onToggleRecording={() => engine?.setPhysicsRecording(!isRecording, capacity)}
      onExport={() => exportRecordingJson(engine)}
      onClearRecording={() => { engine?.clearPhysicsRecording(); setReplayStep(null); }}
      seriesA={seriesA}
      seriesB={seriesB}
      importError={importError}
      toleranceMm={toleranceMm}
      onToleranceMmChange={setToleranceMm}
      toleranceMrad={toleranceMrad}
      onToleranceMradChange={setToleranceMrad}
      curveMetric={curveMetric}
      onCurveMetricChange={setCurveMetric}
      onImport={importSeries}
      onUseRecordingForSlotA={useRecordingForSlotA}
    />
  );
}

const DEFAULT_RECORD_CAPACITY = 600;
const BODY_TYPE_LABELS: Record<string, { zh: string; en: string; kind: string }> = {
  dynamic: { zh: "动态", en: "Dyn", kind: "dynamic" },
  kinematic: { zh: "运动学", en: "Kin", kind: "kinematic" },
  fixed: { zh: "静态", en: "Fix", kind: "fixed" },
};

const formatMetres = (value: number): string => value.toFixed(3);
const formatMilli = (value: number, digits = 2): string => (value * 1000).toFixed(digits);

/** 录制数据导出为 T17 跨端配对 JSON 下载（文件名带时间戳）。 */
function exportRecordingJson(engine: ViewerEngine | undefined): void {
  const text = engine?.exportPhysicsPoseJson();
  if (!text) return;
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `physics-poses-web-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{6})$/, "$1-$2")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface PhysicsDebugPanelViewProps {
  locale: AppLocale;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  engine: ViewerEngine | undefined;
  physics: ScenePhysicsState;
  onPhysicsChange: (next: ScenePhysicsState) => void;
  debugVisible: boolean;
  onDebugVisibleChange: (visible: boolean) => void;
  snapshot: PhysicsDebugSnapshot | undefined;
  recording: { frameCount: number; capacity: number; frames: readonly PhysicsPoseFrame[] } | undefined;
  isRecording: boolean;
  isReplaying: boolean;
  capacity: number;
  onCapacityChange: (value: number) => void;
  manualSteps: number;
  onManualStepsChange: (value: number) => void;
  replayStep: number | null;
  onApplyReplayFrame: (step: number) => void;
  onExitReplay: () => void;
  onToggleRecording: () => void;
  onExport: () => void;
  onClearRecording: () => void;
  seriesA: ParsedPoseSeries | undefined;
  seriesB: ParsedPoseSeries | undefined;
  importError: string | undefined;
  toleranceMm: number;
  onToleranceMmChange: (value: number) => void;
  toleranceMrad: number;
  onToleranceMradChange: (value: number) => void;
  curveMetric: "position" | "rotation";
  onCurveMetricChange: (metric: "position" | "rotation") => void;
  onImport: (slot: "a" | "b", file: File) => Promise<void>;
  onUseRecordingForSlotA: () => void;
}

/** 面板展示层（无 hooks）：状态全部来自容器，交互经回调上行。 */
export function PhysicsDebugPanelView(props: PhysicsDebugPanelViewProps) {
  const { locale, open, engine, physics } = props;
  const drag = useFloatingPanelDrag<HTMLDivElement>();
  if (!open) {
    return (
      <button
        className="pdbg-launcher"
        onClick={() => props.onOpenChange(true)}
        title={tr(locale, "打开物理调试面板", "Open the physics debug panel")}
      >
        {tr(locale, "物理调试", "Physics debug")}
      </button>
    );
  }

  const physicsEnabled = physics.enabled;
  const playing = physics.playing;
  const frameCount = props.recording?.frameCount ?? 0;
  const replayAvailable = physicsEnabled && !playing && frameCount > 0;
  const stepAvailable = physicsEnabled && !playing;
  const bodies = props.snapshot?.bodies ?? [];
  const joints = props.snapshot?.joints ?? [];

  return (
    <div
      ref={drag.panelRef}
      style={drag.style}
      className="pdbg-panel"
      aria-label={tr(locale, "物理调试", "Physics debug")}
    >
      <header
        data-drag-handle="true"
        title={tr(locale, "拖动标题栏移动调试面板", "Drag the title bar to move the debug panel")}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
      >
        <div>
          <strong>{tr(locale, "物理调试", "Physics debug")}</strong>
          <small>Rapier · {tr(locale, "固定步长", "fixed step")}</small>
        </div>
        <button onClick={() => props.onOpenChange(false)} aria-label={tr(locale, "关闭物理调试面板", "Close physics debug panel")}>
          <X size={14} />
        </button>
      </header>

      <section className="pdbg-section">
        <strong>{tr(locale, "步进控制", "Stepping")}</strong>
        <div className="pdbg-row">
          <button
            disabled={!physicsEnabled}
            className={playing ? "active" : ""}
            title={physicsEnabled ? undefined : tr(locale, "先启用物理系统", "Enable physics first")}
            onClick={() => props.onPhysicsChange({ ...physics, playing: !playing })}
          >
            {playing ? <Pause size={12} /> : <Play size={12} />}
            {playing ? tr(locale, "暂停", "Pause") : tr(locale, "连续", "Run")}
          </button>
          <button
            disabled={!stepAvailable}
            title={!physicsEnabled
              ? tr(locale, "先启用物理系统", "Enable physics first")
              : playing ? tr(locale, "暂停后可单步", "Pause to single-step") : undefined}
            onClick={() => engine?.stepPhysicsFrames(1)}
          >
            <StepForward size={12} />
            {tr(locale, "单步", "Step")}
          </button>
        </div>
        <div className="pdbg-row">
          <label>
            <span>{tr(locale, "步数", "Steps")}</span>
            <DeferredNumberInput min={1} max={600} step={1} value={props.manualSteps}
              onCommit={(value) => props.onManualStepsChange(clampNumber(value, 1, 600, 1))} />
          </label>
          <button
            disabled={!stepAvailable}
            title={!physicsEnabled
              ? tr(locale, "先启用物理系统", "Enable physics first")
              : playing ? tr(locale, "暂停后可步进", "Pause to step") : undefined}
            onClick={() => engine?.stepPhysicsFrames(props.manualSteps)}
          >
            ×{props.manualSteps}
          </button>
        </div>
        <div className="pdbg-meta">
          {tr(locale, "固定步", "Fixed step")} <output>{props.snapshot?.fixedStepIndex ?? 0}</output>
          · {props.snapshot?.available
            ? (playing ? tr(locale, "播放中", "running") : tr(locale, "已暂停", "paused"))
            : tr(locale, "物理未挂载", "physics not mounted")}
        </div>
      </section>

      <section className="pdbg-section">
        <strong>{tr(locale, "录制", "Record")}</strong>
        <div className="pdbg-row">
          <button
            disabled={!physicsEnabled}
            className={props.isRecording ? "active recording" : ""}
            title={physicsEnabled ? undefined : tr(locale, "先启用物理系统", "Enable physics first")}
            onClick={props.onToggleRecording}
          >
            {props.isRecording ? tr(locale, "停止录制", "Stop") : tr(locale, "开始录制", "Record")}
          </button>
          <button
            disabled={frameCount === 0}
            title={frameCount === 0 ? tr(locale, "暂无录制帧", "No recorded frames") : undefined}
            onClick={props.onExport}
          >
            <Download size={12} />
            {tr(locale, "导出 JSON", "Export JSON")}
          </button>
          <button
            disabled={frameCount === 0 && !props.isRecording}
            title={frameCount === 0 && !props.isRecording ? tr(locale, "暂无录制数据", "Nothing to clear") : undefined}
            onClick={props.onClearRecording}
            aria-label={tr(locale, "清空录制", "Clear recording")}
          >
            <Trash2 size={12} />
          </button>
        </div>
        <label>
          <span>{tr(locale, "容量 (步)", "Capacity (steps)")}</span>
          <DeferredNumberInput min={10} max={10_000} step={50} value={props.capacity} disabled={props.isRecording}
            onCommit={(value) => props.onCapacityChange(clampNumber(value, 10, 10_000, DEFAULT_RECORD_CAPACITY))} />
        </label>
        <div className="pdbg-meta">
          {tr(locale, "已录", "Recorded")} <output>{frameCount}</output> / {props.recording?.capacity ?? props.capacity}
          {tr(locale, " 步", " steps")}
          {props.isRecording ? ` · ${tr(locale, "环形覆盖最早帧", "ring buffer overwrites oldest")}` : ""}
        </div>
      </section>

      <section className="pdbg-section">
        <strong>{tr(locale, "回放", "Replay")}</strong>
        <div className="pdbg-row">
          <button
            disabled={!replayAvailable || props.replayStep === null}
            title={!replayAvailable
              ? (playing ? tr(locale, "暂停物理后可回放", "Pause physics to replay")
                : frameCount === 0 ? tr(locale, "暂无录制帧", "No recorded frames") : undefined)
              : props.replayStep === null ? tr(locale, "先拖动时间轴或点步进", "Drag the timeline or step first") : undefined}
            onClick={() => props.replayStep !== null && props.onApplyReplayFrame(props.replayStep - 1)}
            aria-label={tr(locale, "上一帧", "Previous frame")}
          >
            <ChevronLeft size={12} />
          </button>
          <input
            className="pdbg-slider"
            type="range"
            min={1}
            max={Math.max(frameCount, 1)}
            step={1}
            disabled={!replayAvailable}
            value={props.replayStep ?? 1}
            title={!replayAvailable
              ? (playing ? tr(locale, "暂停物理后可回放", "Pause physics to replay")
                : frameCount === 0 ? tr(locale, "暂无录制帧", "No recorded frames") : undefined)
              : undefined}
            aria-label={tr(locale, "回放时间轴", "Replay timeline")}
            onChange={(event) => props.onApplyReplayFrame(Number(event.target.value))}
          />
          <button
            disabled={!replayAvailable || props.replayStep === null || props.replayStep >= frameCount}
            title={props.replayStep !== null && props.replayStep >= frameCount ? tr(locale, "已到最后一帧", "At the last frame") : undefined}
            onClick={() => props.replayStep !== null && props.onApplyReplayFrame(props.replayStep + 1)}
            aria-label={tr(locale, "下一帧", "Next frame")}
          >
            <ChevronRight size={12} />
          </button>
        </div>
        <div className="pdbg-meta">
          {props.isReplaying
            ? <>{tr(locale, "回放帧", "Frame")} <output>{props.replayStep ?? 1}</output> / {frameCount}</>
            : tr(locale, "回放把录制位姿写到场景对象；恢复播放即退出", "Replay writes recorded poses to scene objects; playback exits replay")}
        </div>
        <button
          className="pdbg-wide"
          disabled={!props.isReplaying}
          title={props.isReplaying ? undefined : tr(locale, "当前不在回放", "Not replaying")}
          onClick={props.onExitReplay}
        >
          {tr(locale, "退出回放", "Exit replay")}
        </button>
      </section>

      <PhysicsRosterSection locale={locale} bodies={bodies} joints={joints} available={props.snapshot?.available ?? false} />

      <PhysicsCompareSection
        locale={locale}
        seriesA={props.seriesA}
        seriesB={props.seriesB}
        comparison={props.seriesA && props.seriesB
          ? computeComparison(props.seriesA, props.seriesB, props.toleranceMm, props.toleranceMrad)
          : undefined}
        importError={props.importError}
        curveMetric={props.curveMetric}
        toleranceMm={props.toleranceMm}
        toleranceMrad={props.toleranceMrad}
        recordingAvailable={frameCount > 0}
        onCurveMetricChange={props.onCurveMetricChange}
        onToleranceMmChange={props.onToleranceMmChange}
        onToleranceMradChange={props.onToleranceMradChange}
        onImport={props.onImport}
        onUseRecordingForSlotA={props.onUseRecordingForSlotA}
      />

      <section className="pdbg-section">
        <strong>{tr(locale, "碰撞体线框", "Collider wireframes")}</strong>
        <button
          className={`pdbg-wide ${props.debugVisible ? "active" : ""}`}
          onClick={() => props.onDebugVisibleChange(!props.debugVisible)}
        >
          {props.debugVisible ? tr(locale, "隐藏碰撞体", "Hide colliders") : tr(locale, "显示碰撞体", "Show colliders")}
        </button>
      </section>
    </div>
  );
}

/** 数值钳制：非法或越界回退到 fallback/边界，避免 NaN 进入引擎。 */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? value : fallback, min), max);
}

/** 容差换算（mm/mrad → m/rad）并比对；两侧刚体无交集等错误由调用方空结果兜底。 */
function computeComparison(a: ParsedPoseSeries, b: ParsedPoseSeries, toleranceMm: number, toleranceMrad: number): PoseCompareResult | undefined {
  try {
    return comparePoseSeries(a, b, { positionMeters: toleranceMm / 1000, rotationRadians: toleranceMrad / 1000 });
  } catch {
    return undefined;
  }
}

interface PhysicsRosterSectionProps {
  locale: AppLocale;
  bodies: readonly PhysicsDebugBodySnapshot[];
  joints: readonly PhysicsDebugJointSnapshot[];
  available: boolean;
}

/**
 * 刚体/关节花名册（无 hooks 的展示组件，可静态单测）。
 * 语义三重编码：类型徽章颜色 + 文本 + 数值，睡眠/限位/马达独立徽章。
 */
export function PhysicsRosterSection({ locale, bodies, joints, available }: PhysicsRosterSectionProps) {
  return (
    <>
      <section className="pdbg-section">
        <strong>{tr(locale, "刚体", "Rigid bodies")} <em>({bodies.length})</em></strong>
        {bodies.length === 0 && (
          <div className="pdbg-empty">
            {available
              ? tr(locale, "尚无已登记刚体", "No registered bodies yet")
              : tr(locale, "在物理面板启用物理系统后观察刚体", "Enable physics to inspect bodies")}
          </div>
        )}
        <ul className="pdbg-list">
          {bodies.map((body) => (
            <li key={body.id} title={body.id}>
              <span className={`pdbg-badge pdbg-${BODY_TYPE_LABELS[body.type]?.kind ?? "fixed"}`}>
                {tr(locale, BODY_TYPE_LABELS[body.type]?.zh ?? body.type, BODY_TYPE_LABELS[body.type]?.en ?? body.type)}
              </span>
              <span className="pdbg-name">{body.name}</span>
              <span className="pdbg-num">{formatMetres(body.speed)} m/s</span>
              {body.sleeping && <span className="pdbg-badge pdbg-sleep">{tr(locale, "睡眠", "sleep")}</span>}
              <span className="pdbg-num pdbg-pos" title={tr(locale, "位置 (m)", "Position (m)")}>
                {formatMetres(body.position.x)}, {formatMetres(body.position.y)}, {formatMetres(body.position.z)}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="pdbg-section">
        <strong>{tr(locale, "关节", "Joints")} <em>({joints.length})</em></strong>
        {joints.length === 0 && (
          <div className="pdbg-empty">{tr(locale, "尚无关节或世界未挂载", "No joints, or physics not mounted")}</div>
        )}
        <ul className="pdbg-list">
          {joints.map((joint) => (
            <li key={joint.id} title={joint.id}>
              <span className={`pdbg-badge pdbg-${joint.kind}`}>
                {joint.kind === "revolute" ? tr(locale, "旋转", "Rev") : tr(locale, "移动", "Prs")}
              </span>
              <span className="pdbg-name">{joint.bodyName} ↔ {joint.connectedBodyName || tr(locale, "世界", "world")}</span>
              <span className="pdbg-num">
                {joint.kind === "revolute"
                  ? `${((joint.travel * 180) / Math.PI).toFixed(1)}°`
                  : `${formatMetres(joint.travel)} m`}
              </span>
              <span className="pdbg-num pdbg-dim" title={tr(locale, "轴上速率", "Rate along axis")}>
                {joint.kind === "revolute" ? `${joint.rate.toFixed(2)} rad/s` : `${formatMetres(joint.rate)} m/s`}
              </span>
              <span className={`pdbg-badge ${joint.limitState === "at-limit" ? "pdbg-limit" : "pdbg-dimbadge"}`}>
                {joint.limits.enabled
                  ? (joint.kind === "revolute"
                    ? `${((joint.limits.min * 180) / Math.PI).toFixed(0)}~${((joint.limits.max * 180) / Math.PI).toFixed(0)}°`
                    : `${joint.limits.min.toFixed(2)}~${joint.limits.max.toFixed(2)} m`)
                  : tr(locale, "无限位", "no limit")}
                {joint.limitState === "at-limit" ? ` · ${tr(locale, "限位中", "at limit")}` : ""}
              </span>
              <span className={`pdbg-badge ${joint.motor.enabled ? "pdbg-motor" : "pdbg-dimbadge"}`}>
                {joint.motor.enabled ? `${tr(locale, "马达", "motor")} ${joint.motor.targetVelocity.toFixed(1)}` : tr(locale, "无马达", "no motor")}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

interface PhysicsCompareSectionProps {
  locale: AppLocale;
  seriesA: ParsedPoseSeries | undefined;
  seriesB: ParsedPoseSeries | undefined;
  comparison: PoseCompareResult | undefined;
  importError: string | undefined;
  curveMetric: "position" | "rotation";
  toleranceMm: number;
  toleranceMrad: number;
  recordingAvailable: boolean;
  onCurveMetricChange: (metric: "position" | "rotation") => void;
  onToleranceMmChange: (value: number) => void;
  onToleranceMradChange: (value: number) => void;
  onImport: (slot: "a" | "b", file: File) => Promise<void>;
  onUseRecordingForSlotA: () => void;
}

/** 跨端位姿比对区：双槽导入 + 容差 + 逐步差曲线与超差清单（无 hooks）。 */
export function PhysicsCompareSection(props: PhysicsCompareSectionProps) {
  const { locale, seriesA, seriesB, comparison, curveMetric } = props;
  const values = comparison?.perStep.map((row) => curveMetric === "position" ? row.maxPosition : row.maxRotation) ?? [];
  const maxValue = values.length ? Math.max(...values, 1e-12) : 1;
  const width = 268;
  const height = 64;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
    const y = height - 4 - (value / maxValue) * (height - 10);
    // 红点语义跟随当前指标：位置差曲线标位置超差，旋转差曲线标旋转超差；
    // 整帧超差清单（含双指标数值）在下方列表，两处口径不混用。
    const row = comparison!.perStep[index]!;
    return { x, y, exceeded: curveMetric === "position" ? row.positionExceeded : row.rotationExceeded };
  });
  const exceededRows = comparison?.perStep.filter((row) => row.exceeded).slice(0, 12) ?? [];
  const slotLabel = (series: ParsedPoseSeries | undefined) =>
    series ? `${series.end} · ${series.steps}${tr(locale, " 步", " steps")}` : tr(locale, "未导入", "not loaded");

  return (
    <section className="pdbg-section">
      <strong>{tr(locale, "跨端位姿比对", "Cross-end pose compare")}</strong>
      <div className="pdbg-row">
        <label className="pdbg-file">
          <span className="pdbg-slot">{tr(locale, "槽 A", "Slot A")}</span>
          <span className="pdbg-slotmeta">{slotLabel(seriesA)}</span>
          <input type="file" accept=".json,application/json" aria-label={tr(locale, "导入槽 A 位姿 JSON", "Import slot A pose JSON")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void props.onImport("a", file);
              event.target.value = "";
            }} />
          {tr(locale, "导入 A", "Load A")}
        </label>
        <button
          disabled={!props.recordingAvailable}
          title={props.recordingAvailable ? undefined : tr(locale, "暂无录制数据", "No recording yet")}
          onClick={props.onUseRecordingForSlotA}
        >
          {tr(locale, "录制→A", "Rec→A")}
        </button>
      </div>
      <label className="pdbg-file">
        <span className="pdbg-slot">{tr(locale, "槽 B", "Slot B")}</span>
        <span className="pdbg-slotmeta">{slotLabel(seriesB)}</span>
        <input type="file" accept=".json,application/json" aria-label={tr(locale, "导入槽 B 位姿 JSON", "Import slot B pose JSON")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void props.onImport("b", file);
            event.target.value = "";
          }} />
        {tr(locale, "导入 B", "Load B")}
      </label>
      {props.importError && <div className="pdbg-error" role="alert">{props.importError}</div>}
      <div className="pdbg-row">
        <label>
          <span>{tr(locale, "位置容差 (mm)", "Position tol (mm)")}</span>
          <DeferredNumberInput min={0.01} max={1000} step={0.5} value={props.toleranceMm} onCommit={props.onToleranceMmChange} />
        </label>
        <label>
          <span>{tr(locale, "旋转容差 (mrad)", "Rotation tol (mrad)")}</span>
          <DeferredNumberInput min={0.01} max={1000} step={1} value={props.toleranceMrad} onCommit={props.onToleranceMradChange} />
        </label>
      </div>
      {!comparison && (
        <div className="pdbg-empty">
          {tr(locale, "导入两份 T17 位姿 JSON（Web/Native）后自动比对", "Load two T17 pose JSON files (web/native) to compare")}
        </div>
      )}
      {comparison && (
        <>
          <div className="pdbg-meta pdbg-summary">
            <output>{(comparison.maxPosition * 1000).toFixed(2)}</output> mm ·{" "}
            <output>{(comparison.maxRotation * 1000).toFixed(2)}</output> mrad ·{" "}
            {comparison.firstExceededStep === null
              ? tr(locale, "无超差", "within tolerance")
              : `${tr(locale, "首超差帧", "first exceed")} ${comparison.firstExceededStep}`}
          </div>
          <div className={`pdbg-verdict ${comparison.firstExceededStep === null ? "pass" : "fail"}`}>
            {comparison.firstExceededStep === null
              ? tr(locale, "通过容差", "Within tolerance")
              : tr(locale, "存在超差帧", "Frames exceed tolerance")}
          </div>
          <div className="pdbg-row pdbg-curvehead">
            <button className={curveMetric === "position" ? "active" : ""} onClick={() => props.onCurveMetricChange("position")}>
              {tr(locale, "位置差", "Position")}
            </button>
            <button className={curveMetric === "rotation" ? "active" : ""} onClick={() => props.onCurveMetricChange("rotation")}>
              {tr(locale, "旋转差", "Rotation")}
            </button>
            <span className="pdbg-num">
              {curveMetric === "position" ? "mm" : "mrad"} · {tr(locale, "峰", "peak")}{" "}
              {formatMilli(curveMetric === "position" ? comparison.maxPosition : comparison.maxRotation)}
            </span>
          </div>
          <svg className="pdbg-curve" viewBox={`0 0 ${width} ${height}`} role="img"
            aria-label={tr(locale, "逐步差值曲线", "Per-step difference curve")}>
            <line x1={0} y1={height - 4} x2={width} y2={height - 4} className="pdbg-axis" />
            <polyline className="pdbg-line" points={points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")} />
            {points.map((point, index) => point.exceeded ? (
              <circle key={index} cx={point.x} cy={point.y} r={2} className="pdbg-exceed" />
            ) : null)}
          </svg>
          <div className="pdbg-meta">
            {comparison.exceededStepCount}/{comparison.stepsCompared} {tr(locale, "帧超差", "frames exceed")}
            {exceededRows.length > 0 && ` · ${tr(locale, "前", "first")} ${exceededRows.length}:`}
          </div>
          {exceededRows.length > 0 && (
            <ul className="pdbg-list pdbg-exceedlist">
              {exceededRows.map((row) => (
                <li key={row.step}>
                  <span className="pdbg-badge pdbg-limit">{tr(locale, "帧", "Frame")} {row.step}</span>
                  <span className="pdbg-num">{formatMilli(row.maxPosition)} mm</span>
                  <span className="pdbg-num">{formatMilli(row.maxRotation)} mrad</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
