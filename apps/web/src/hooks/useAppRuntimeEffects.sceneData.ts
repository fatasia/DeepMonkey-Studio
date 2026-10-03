import { useEffect } from "react";
import type { SceneDataBindingState } from "@bim-studio/contracts";
import { api } from "../api";
import type { SceneDataBindingRuntimeState } from "../components/SceneDataBindingEditor";
import { dataBindingProduct, directSceneDataBindingMessage, sceneDataBindingMessage } from "../sceneDataBindings";
import { DirectBindingRuntime } from "../directBindingRuntime";
import { publishLocalSceneData, subscribeSceneData } from "../sceneDataBridge";
import { isSceneViewerDeliveryRuntime } from "../delivery/sceneViewerDelivery";
import type { AppRuntimeEffectsContext } from "./useAppRuntimeEffects.context";

/** 实时数据订阅、数据绑定轮询与视觉事件轮询(pipeline/dataset/vision 三源)。 */
export function useSceneDataRuntimeEffects(context: AppRuntimeEffectsContext): void {
  const {
    engine,
    project,
    route,
    sceneDataBindings,
    showError,
    setMessage,
    setRevision,
    setSceneDataReceived,
    setSceneDataStatus,
    setSceneDataBindingRuntime,
    visionEventCursorRef,
  } = context;
  useEffect(() => {
    if (isSceneViewerDeliveryRuntime() || !engine || !project || !["studio", "view", "published"].includes(route.view)) return;
    return subscribeSceneData(
      project.id,
      (data) => {
        if (data.sceneId && data.sceneId !== route.sceneId) return;
        setSceneDataReceived((value) => value + 1);
        if (engine.applySceneDataMessage(data)) {
          if (!data.source.startsWith("pipeline:") && !data.source.startsWith("dataset:")) setMessage(`数据 ${data.source}/${data.key} 已映射到场景`);
          setRevision((value) => value + 1);
        }
      },
      setSceneDataStatus,
    );
  }, [engine, project, route.sceneId, route.view]);

  useEffect(() => {
    if (isSceneViewerDeliveryRuntime() || !project || !route.sceneId || !["studio", "view", "published"].includes(route.view)) return;
    const enabled = sceneDataBindings.filter((binding) => binding.enabled);
    if (enabled.length === 0) {
      setSceneDataBindingRuntime({});
      return;
    }
    let cancelled = false;
    const timers: number[] = [];
    const directStops: Array<() => void> = [];
    const groups = new Map<string, { bindings: SceneDataBindingState[]; kind: "dataset" | "pipeline"; productId: string; seconds: number }>();
    for (const binding of enabled) {
      if (binding.directBinding) continue;
      const product = dataBindingProduct(binding);
      const key = `${product.kind}:${product.id}:${binding.refreshSeconds}`;
      const group = groups.get(key) ?? { bindings: [], kind: product.kind, productId: product.id, seconds: binding.refreshSeconds };
      group.bindings.push(binding);
      groups.set(key, group);
    }
    const updateBindings = (
      bindings: readonly SceneDataBindingState[],
      state: SceneDataBindingRuntimeState | ((binding: SceneDataBindingState) => SceneDataBindingRuntimeState),
    ) => {
      if (cancelled) return;
      setSceneDataBindingRuntime((current) => ({
        ...current,
        ...Object.fromEntries(bindings.map((binding) => [binding.id, typeof state === "function" ? state(binding) : state])),
      }));
    };
    for (const binding of enabled.filter((candidate) => candidate.directBinding)) {
      const stop = new DirectBindingRuntime(
        binding.directBinding!,
        {},
        {
          onValue: (value) => {
            const message = directSceneDataBindingMessage(binding, value, route.sceneId!);
            publishLocalSceneData(message, project.id);
            updateBindings([binding], { status: "ready", value: message.value, updatedAt: message.timestamp });
          },
          onStatus: (status) => {
            if (["loading", "connecting", "reconnecting"].includes(status)) {
              setSceneDataBindingRuntime((current) => ({ ...current, [binding.id]: current[binding.id] ?? { status: "loading" } }));
            }
          },
          onError: (error) => updateBindings([binding], { status: "error", error }),
        },
      ).start();
      directStops.push(stop);
    }
    for (const group of groups.values()) {
      const poll = async () => {
        if (!cancelled)
          setSceneDataBindingRuntime((current) => ({
            ...current,
            ...Object.fromEntries(group.bindings.map((binding) => [binding.id, current[binding.id] ?? { status: "loading" }])),
          }));
        try {
          const preview = group.kind === "dataset" ? await api.previewDataset(project.id, group.productId) : await api.previewDataPipeline(project.id, group.productId);
          if ("status" in preview && preview.status === "error") throw new Error(preview.error || "数据管道运行失败");
          const messages = new Map<string, ReturnType<typeof sceneDataBindingMessage>>();
          for (const binding of group.bindings) {
            const message = sceneDataBindingMessage(binding, preview, route.sceneId!);
            messages.set(binding.id, message);
            publishLocalSceneData(message, project.id);
          }
          updateBindings(group.bindings, (binding) => {
            const message = messages.get(binding.id)!;
            return { status: "ready", value: message.value, updatedAt: message.timestamp };
          });
        } catch (reason) {
          updateBindings(group.bindings, { status: "error", error: reason instanceof Error ? reason.message : "数据绑定刷新失败" });
        }
      };
      void poll();
      timers.push(window.setInterval(() => void poll(), Math.max(2, group.seconds) * 1_000));
    }
    return () => {
      cancelled = true;
      for (const timer of timers) window.clearInterval(timer);
      for (const stop of directStops) stop();
    };
  }, [project?.id, route.sceneId, route.view, sceneDataBindings]);

  useEffect(() => {
    if (isSceneViewerDeliveryRuntime() || !engine || !project || !route.sceneId || !["studio", "view", "published"].includes(route.view)) return;
    let cancelled = false;
    const sceneId = route.sceneId;
    const scope = `${project.id}:${sceneId}`;
    const poll = async () => {
      const events = (await api.listVisionEvents(project.id, 30)).filter((event) => event.sceneId === sceneId);
      if (cancelled) return;
      const cursor = visionEventCursorRef.current;
      if (cursor.scope !== scope) {
        visionEventCursorRef.current = { scope, id: events[0]?.id ?? "" };
        return;
      }
      if (!events.length || events[0]?.id === cursor.id) return;
      const previousIndex = cursor.id ? events.findIndex((event) => event.id === cursor.id) : -1;
      const fresh = events.slice(0, previousIndex >= 0 ? previousIndex : 1).reverse();
      visionEventCursorRef.current = { scope, id: events[0]?.id ?? "" };
      for (const event of fresh) {
        for (const [index, objectId] of event.objectIds.entries()) {
          const [modelId, ...layerParts] = objectId.split("/");
          if (!modelId) continue;
          const target = { modelId, ...(layerParts.length ? { layerId: layerParts.join("/") } : {}) };
          publishLocalSceneData({
            source: "vision",
            key: event.id,
            value: { outline: true, glow: true, color: "#ff3b30", intensity: 1.35 },
            timestamp: event.createdAt,
            sceneId,
            target,
            action: "effects",
          });
          if (index === 0)
            publishLocalSceneData({
              source: "vision",
              key: `${event.id}:focus`,
              value: true,
              timestamp: event.createdAt,
              sceneId,
              target,
              action: "focus",
            });
        }
        setMessage(
          `视觉告警：${
            event.detections
              .slice(0, 3)
              .map((item) => item.label)
              .join("、") || "检测到异常"
          }`,
        );
      }
    };
    void poll().catch(() => undefined);
    const timer = window.setInterval(() => void poll().catch(() => undefined), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [engine, project?.id, route.sceneId, route.view]);
}
