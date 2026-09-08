import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { PlantLitePlayback } from "./PlantLitePlayback";
import type { PlantLitePlaybackFrame } from "./plantLitePlaybackModel";
import { translate as tr, type AppLocale } from "../i18n";
import "./ScenePlantPlayback.css";

export function ScenePlantPlayback({ model, trace, onFrame, locale }: {
  locale: AppLocale;
  model: PlantLiteModel;
  trace: PlantLiteReplicationTrace;
  onFrame?: (frame: PlantLitePlaybackFrame | null) => void;
}) {
  const [layers, setLayers] = useState({ heatmap: false, trails: false });
  const [counts, setCounts] = useState({ total: 0, missing: 0 });
  const frame = useRef<PlantLitePlaybackFrame | null>(null);
  const activeLayers = useRef(layers);
  activeLayers.current = layers;
  const callback = useRef(onFrame);
  callback.current = onFrame;
  const anchored = useMemo(() => new Set(model.sceneBinding?.nodes.map(node => node.nodeId)), [model]);
  const receive = useCallback((next: PlantLitePlaybackFrame | null) => {
    frame.current = next;
    callback.current?.(next ? { ...next, sceneLayers: activeLayers.current } : null);
    const waiting = Object.entries(next?.waitingByNode ?? {});
    const total = waiting.reduce((sum, [, count]) => sum + count, 0);
    const missing = waiting.filter(([id]) => !anchored.has(id)).reduce((sum, [, count]) => sum + count, 0);
    // 连续运输帧直通覆盖层；只有等待数量变化才刷新说明，不再增加一层逐帧 React 状态。
    setCounts(previous => previous.total === total && previous.missing === missing ? previous : { total, missing });
  }, [anchored]);
  useEffect(() => { if (frame.current) callback.current?.({ ...frame.current, sceneLayers: layers }); }, [layers]);
  useEffect(() => () => callback.current?.(null), []);
  return <>
    <div className="scene-plant-layers" aria-label={tr(locale, "仿真空间显示", "Simulation spatial layers")}>
      <button type="button" aria-pressed={layers.trails} onClick={() => setLayers(current => ({ ...current, trails: !current.trails }))} title={tr(locale, "当前时刻已记录的搬运行程，沿原场景端点插值；不是物理道路轨迹", "Recorded transport at the current time, interpolated between scene anchors; not a physical road path")}>{tr(locale, "运输轨迹", "Transport trails")}</button>
      <button type="button" aria-pressed={layers.heatmap} onClick={() => setLayers(current => ({ ...current, heatmap: !current.heatmap }))} title={tr(locale, "当前时刻等待的已记录物料，单位：件。圆面积随数量增加；不代表全量队列或时间累计占用", "Recorded items waiting at the current time. Unit: items. Circle area increases with count; not the complete queue or time-integrated occupancy")}>{tr(locale, "等待热力", "Waiting heat")}</button>
      {layers.heatmap && <output aria-label={tr(locale, "空间等待样本", "Spatial waiting samples")} title={tr(locale, "只统计轨迹中当前处于等待状态的物料；轨迹截断时不是完整队列", "Only recorded items currently waiting; truncated traces do not represent the complete queue")}>{tr(locale, `等待 ${counts.total} 件（样本）`, `${counts.total} waiting items (sample)`)}{counts.missing > 0 ? tr(locale, ` · ${counts.missing} 件无空间锚点`, ` · ${counts.missing} without spatial anchors`) : ""}</output>}
      {!model.sceneBinding?.nodes.length && <span>{tr(locale, "无场景锚点，仅显示事件时间线", "No scene anchors; showing the event timeline only")}</span>}
    </div>
    <PlantLitePlayback model={model} trace={trace} onFrame={receive} />
  </>;
}
