import { useEffect, useState } from "react";
import type { ScenePhysicsState } from "@bim-studio/contracts";
import { PhysicsDebugRecorder } from "@bim-studio/deep-engine/physics";
import type { AppLocale } from "../i18n";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import type { PhysicsDebugFilter, PhysicsDebugLayers, PhysicsDebugSnapshot } from "../viewer/physicsDebugSnapshot";
import type { PhysicsPoseFrame } from "../viewer/physicsPoseRecorder";
import { parsePhysicsPoseJson, type ParsedPoseSeries } from "../viewer/physicsPoseRecorder";
import type { PhysicsDebugPanelViewProps } from "./PhysicsDebugPanel";

/**
 * 物理调试面板容器态(体量门拆分,行为零变化):轮询引擎快照、录制/回放状态机、
 * 位姿序列导入导出与确定性调试哈希导出;展示层在 PhysicsDebugPanelView(无 hooks)。
 */
export interface PhysicsDebugPanelProps {
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
  /** T0 刀 3：调试可视化筛选与图层状态（工作区持有，引擎经控制器同步）。 */
  debugFilter: PhysicsDebugFilter;
  onDebugFilterChange: (filter: PhysicsDebugFilter) => void;
  debugLayers: PhysicsDebugLayers;
  onDebugLayersChange: (layers: PhysicsDebugLayers) => void;
  /** 当前选中对象名（筛选=选中时显示目标；无选中时筛选按钮禁用）。 */
  selectedName: string | undefined;
}

const DEFAULT_RECORD_CAPACITY = 600;

/** 录制数据导出为 T17 跨端配对 JSON 下载（文件名带时间戳）。 */
const exportRecordingJson = (engine: ViewerEngine | undefined): void => {
  const text = engine?.exportPhysicsPoseJson();
  if (!text) return;
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `physics-poses-web-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{6})$/, "$1-$2")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
};

export function usePhysicsDebugPanelState(props: PhysicsDebugPanelProps): PhysicsDebugPanelViewProps {
  const { open, engine } = props;
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

  /**
   * Brief-PhysDbg:把 T28 录制(T17 位姿)过引擎侧确定性录制器合同——f32 量化 +
   * 逐 tick FNV 哈希链——导出为跨端对拍 JSON(native physics_debug_compare 直接消费)。
   */
  const exportDebugHashJson = () => {
    const text = engine?.exportPhysicsPoseJson();
    if (!text) return;
    try {
      const series = parsePhysicsPoseJson(text, "editor recording");
      const recorder = new PhysicsDebugRecorder({
        tickCapacity: Math.max(1, series.frames.length),
        maxBodies: Math.max(1, series.bodies.length),
      });
      recorder.start(0);
      for (const frame of series.frames) {
        const poses = new Float64Array(frame.bodies.length * 7);
        frame.bodies.forEach((pose, index) => {
          poses.set(pose.p, index * 7);
          poses.set(pose.q, index * 7 + 3);
        });
        recorder.record({ tick: frame.step, poses, bodyCount: frame.bodies.length });
      }
      const json = recorder.toDebugJson({ hz: 60, note: "converted from T28 editor recording (T17 poses)" });
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "physics-debug-recording-web.json";
      anchor.click();
      URL.revokeObjectURL(url);
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

  return {
    locale: props.locale,
    open,
    onOpenChange: props.onOpenChange,
    engine,
    physics: props.physics,
    onPhysicsChange: props.onPhysicsChange,
    debugVisible: props.debugVisible,
    onDebugVisibleChange: props.onDebugVisibleChange,
    debugFilter: props.debugFilter,
    onDebugFilterChange: props.onDebugFilterChange,
    debugLayers: props.debugLayers,
    onDebugLayersChange: props.onDebugLayersChange,
    selectedName: props.selectedName,
    snapshot,
    recording,
    isRecording,
    isReplaying,
    capacity,
    onCapacityChange: setCapacity,
    manualSteps,
    onManualStepsChange: setManualSteps,
    replayStep,
    onApplyReplayFrame: applyReplayFrame,
    onExitReplay: () => engine?.setPhysicsReplayFrame(undefined),
    onToggleRecording: () => engine?.setPhysicsRecording(!isRecording, capacity),
    onExport: () => exportRecordingJson(engine),
    onClearRecording: () => { engine?.clearPhysicsRecording(); setReplayStep(null); },
    seriesA,
    seriesB,
    importError,
    toleranceMm,
    onToleranceMmChange: setToleranceMm,
    toleranceMrad,
    onToleranceMradChange: setToleranceMrad,
    curveMetric,
    onCurveMetricChange: setCurveMetric,
    onImport: importSeries,
    onUseRecordingForSlotA: useRecordingForSlotA,
    onExportDebugHashJson: exportDebugHashJson,
  };
}
