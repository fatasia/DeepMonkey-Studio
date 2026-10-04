import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CameraKeyframe, ModelKeyframe, SceneAnimationState } from "@bim-studio/contracts";
import "../src/styles/base.css";
import "../src/styles/scene-workspace-timeline.css";
import "../src/styles/interactionPolish.css";
import { SceneTimelinePanel } from "../src/components/SceneTimelinePanel";
import { sampleCameraKeyframes, sampleModelKeyframes, snapAnimationTime } from "../src/viewer/timeline";

/**
 * 时间线导演台真实交互夹具：
 * 无引擎依赖（engine 缺省），录制/播放/seek 全部由夹具状态机承接，
 * 关键帧采样用生产模块 sampleModelKeyframes / sampleCameraKeyframes 实时求值展示，
 * 页面自带断言区，供浏览器工具读取与截图。
 */

const FRAME_RATE = 30;
const DURATION = 10;

function cameraAt(x: number): CameraKeyframe["camera"] {
  return { position: { x, y: 2.4, z: 6 }, target: { x: 0, y: 0.8, z: 0 }, mode: "orbit" };
}

function transformAt(x: number): ModelKeyframe["transform"] {
  return { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
}

interface CheckItem { id: string; label: string; pass: boolean | undefined; detail?: string }

function Fixture() {
  const [animation, setAnimation] = useState<SceneAnimationState>({ duration: DURATION, loop: true, frameRate: FRAME_RATE, camera: [], models: [] });
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [modelSample, setModelSample] = useState("—");
  const [cameraSample, setCameraSample] = useState("—");
  const rafRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);
  const playingRef = useRef(false);
  playingRef.current = playing;

  const append = (line: string) => setLog(previous => [...previous.slice(-40), line]);

  // 播放循环：rAF 推进播放头，loop 到尾回 0 —— 与引擎 advanceSceneAnimationTime 同语义的简化版。
  useEffect(() => {
    if (!playing) return;
    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      if (!playingRef.current) return;
      const dt = Math.min((now - lastTickRef.current) / 1000, 0.25);
      lastTickRef.current = now;
      setCurrentTime(previous => {
        const next = previous + dt;
        return next >= DURATION ? next - DURATION : next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  // 采样监视：播放头或关键帧变化时用生产采样模块求值，位置随时间变化即"播放生效"的证据。
  useEffect(() => {
    const modelFrames = animation.models.filter(frame => frame.modelId === "pump").sort((a, b) => a.time - b.time);
    if (modelFrames.length >= 2) {
      const sampled = sampleModelKeyframes(modelFrames, currentTime, animation.modelInterpolation ?? "smooth");
      setModelSample(`t=${currentTime.toFixed(2)}s → x=${sampled ? sampled.position.x.toFixed(3) : "—"}`);
    } else setModelSample("—");
    if (animation.camera.length >= 2) {
      const sampled = sampleCameraKeyframes(animation.camera, currentTime, animation.cameraInterpolation ?? "smooth");
      setCameraSample(`t=${currentTime.toFixed(2)}s → x=${sampled ? sampled.position.x.toFixed(3) : "—"}`);
    } else setCameraSample("—");
  }, [currentTime, animation]);

  function recordCamera(time?: number) {
    const frameTime = snapAnimationTime(time ?? currentTime, FRAME_RATE, false);
    const frame: CameraKeyframe = { id: crypto.randomUUID(), time: frameTime, camera: cameraAt(frameTime * 2) };
    setAnimation(previous => ({ ...previous, camera: [...previous.camera.filter(item => Math.abs(item.time - frameTime) > 0.001), frame].sort((a, b) => a.time - b.time) }));
    append(`record:camera@${frameTime.toFixed(2)}`);
    return frame.id;
  }

  function recordObject(modelId?: string, time?: number) {
    const id = modelId ?? "pump";
    const frameTime = snapAnimationTime(time ?? currentTime, FRAME_RATE, false);
    const frame: ModelKeyframe = { id: crypto.randomUUID(), time: frameTime, modelId: id, transform: transformAt(frameTime * 4) };
    setAnimation(previous => ({
      ...previous,
      models: [...previous.models.filter(item => !(item.modelId === id && Math.abs(item.time - frameTime) <= 0.001)), frame].sort((a, b) => a.time - b.time),
    }));
    append(`record:${id}@${frameTime.toFixed(2)}`);
    return frame.id;
  }

  function deleteFrame(id: string) {
    setAnimation(previous => ({ ...previous, camera: previous.camera.filter(item => item.id !== id), models: previous.models.filter(item => item.id !== id) }));
    append(`delete:${id.slice(0, 6)}`);
  }

  function change(next: SceneAnimationState) {
    setAnimation(next);
    const transitions = [...next.models, ...next.camera].map(frame => frame.transition ?? "default").join(",");
    const emissive = next.models.filter(frame => frame.emissiveIntensity !== undefined).map(frame => `${frame.time}:${frame.emissiveIntensity}`).join(",");
    append(`change:interpolation=${next.modelInterpolation ?? "default"} transitions=[${transitions}] emissive=[${emissive}]`);
  }

  const modelNames = useMemo(() => new Map([["pump", "循环泵 P-101"]]), []);

  // 自动断言：按夹具状态推导,供浏览器工具读 PASS/FAIL。
  useEffect(() => {
    const items: CheckItem[] = [];
    const cameraFrames = animation.camera;
    const pumpFrames = animation.models.filter(frame => frame.modelId === "pump");
    items.push({ id: "camera-keyframe", label: "相机关键帧已建立（新增轨道菜单）", pass: cameraFrames.length >= 1 ? true : undefined, detail: `${cameraFrames.length} 帧` });
    items.push({ id: "model-keyframe", label: "K 键建立对象关键帧（循环泵）", pass: pumpFrames.length >= 1 ? true : undefined, detail: `${pumpFrames.length} 帧` });
    items.push({ id: "drag-move", label: "关键帧拖拽后时间被更新", pass: pumpFrames.some(frame => frame.time > 0.31) ? true : pumpFrames.length ? false : undefined, detail: pumpFrames.map(frame => frame.time.toFixed(2)).join("/") });
    items.push({ id: "interpolation", label: "插值切换写入关键帧 transition", pass: animation.models.some(frame => frame.transition !== undefined) ? true : pumpFrames.length ? false : undefined, detail: animation.models.map(frame => frame.transition ?? "-").join(",") });
    items.push({ id: "emissive", label: "自发光强度关键帧（1→3 动画）", pass: animation.models.some(frame => (frame.emissiveIntensity ?? 0) > 1) ? true : pumpFrames.length ? false : undefined });
    items.push({ id: "playback", label: "播放推进采样位置（x 随时间变化）", pass: undefined, detail: modelSample });
    items.push({ id: "camera-playback", label: "相机路径采样（巡检飞行）", pass: undefined, detail: cameraSample });
    items.push({ id: "zoom", label: "时间线缩放徽标出现（滚轮放大）", pass: document.querySelector(".timeline-zoom-badge") ? true : undefined });
    setChecks(items);
  }, [animation, modelSample, cameraSample]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-1)", color: "var(--text)" }}>
      <div id="fixture-status" style={{ position: "fixed", left: 8, top: 8, zIndex: 50, display: "grid", gap: 4, padding: 8, fontSize: 11, fontFamily: "monospace", border: "1px solid var(--line-strong)", borderRadius: 6, background: "var(--surface-1)", maxWidth: 380 }}>
        <strong style={{ fontSize: 12 }}>时间线导演台交互夹具</strong>
        <span>playing={String(playing)} t={currentTime.toFixed(2)}s zoomBadge={String(Boolean(document.querySelector(".timeline-zoom-badge")))}</span>
        <span data-testid="model-sample">对象采样 {modelSample}</span>
        <span data-testid="camera-sample">相机采样 {cameraSample}</span>
        <ol id="fixture-checks" style={{ margin: 0, paddingLeft: 16 }}>
          {checks.map(item => (
            <li key={item.id} data-check={item.id} data-pass={item.pass === undefined ? "pending" : item.pass ? "pass" : "fail"}>
              {item.pass === undefined ? "◌" : item.pass ? "✓" : "✗"} {item.label}{item.detail ? `（${item.detail}）` : ""}
            </li>
          ))}
        </ol>
        <button type="button" id="seed-second-model-frame" onClick={() => {
          // 一键补齐"1s→3s 自发光 1→3"的两帧轨道，给播放断言提供对象动画数据。
          setAnimation(previous => ({
            ...previous,
            models: [
              { id: "seed-a", time: 1, modelId: "pump", transform: transformAt(4), emissiveIntensity: 1 },
              { id: "seed-b", time: 3, modelId: "pump", transform: transformAt(12), emissiveIntensity: 3 },
            ],
          }));
          append("seed:pump 1s→3s emissive 1→3");
        }}>补齐对象动画两帧（自发光 1→3）</button>
        <button type="button" id="toggle-theme" onClick={() => {
          const root = document.documentElement;
          root.setAttribute("data-theme", root.getAttribute("data-theme") === "light" ? "dark" : "light");
        }}>切换深/浅主题</button>
        <div id="fixture-log" style={{ maxHeight: 90, overflow: "auto", color: "var(--text-muted)" }}>{log.map((line, index) => <div key={index}>{line}</div>)}</div>
      </div>
      <SceneTimelinePanel
        locale="zh-CN"
        animation={animation}
        currentTime={currentTime}
        playing={playing}
        selectedObjectName="循环泵 P-101"
        selectedObjectLocked={false}
        modelNames={modelNames}
        onClose={() => append("close")}
        onPlayPause={() => { setPlaying(previous => !previous); append(`play-toggle→${!playing}`); }}
        onSeek={time => { setCurrentTime(time); append(`seek:${time.toFixed(2)}`); }}
        onChange={change}
        onRecordCamera={recordCamera}
        onRecordObject={recordObject}
        onDeleteFrame={deleteFrame}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
