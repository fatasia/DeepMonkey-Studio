import type {
  DashboardDataWidgetConfig,
  JsonValue,
  UnityBuildManifestRecord,
  UnityResourceRecord,
  UnityResourceVersionRecord,
  UnityRuntimeCapability,
} from "@bim-studio/contracts";

export const UNITY_BRIDGE_VERSION = 1 as const;
const UNITY_RUNTIME_CAPABILITIES: readonly UnityRuntimeCapability[] = [
  "ack",
  "heartbeat",
  "data-layers",
  "properties",
  "actions",
  "events",
];

export type UnityBuildManifest = UnityBuildManifestRecord;

export interface UnityBridgeHostMessage {
  source: "bim-studio";
  version: 1;
  type: "init" | "parameters" | "data" | "dataLayers" | "properties" | "action" | "scene" | "ping";
  widgetId: string;
  messageId: string;
  sentAt: number;
  payload: JsonValue;
}

export interface UnityBridgeEventMessage {
  source: "unity-webgl";
  version: 1;
  type: "ready" | "event" | "error" | "ack" | "health" | "capabilities";
  widgetId?: string;
  eventName?: string;
  payload?: JsonValue;
  message?: string;
  messageId?: string;
  messageType?: UnityBridgeHostMessage["type"];
  fps?: number;
  scene?: string;
  capabilities?: UnityRuntimeCapability[];
}

export function unityHostMessage(
  type: UnityBridgeHostMessage["type"],
  widgetId: string,
  payload: JsonValue,
  messageId = `${widgetId}:${type}:${Date.now()}`,
  sentAt = Date.now(),
): UnityBridgeHostMessage {
  return {
    source: "bim-studio",
    version: UNITY_BRIDGE_VERSION,
    type,
    widgetId,
    messageId,
    sentAt,
    payload: structuredClone(payload),
  };
}

export function readUnityBridgeEvent(value: unknown): UnityBridgeEventMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.source !== "unity-webgl" ||
    candidate.version !== UNITY_BRIDGE_VERSION ||
    !["ready", "event", "error", "ack", "health", "capabilities"].includes(String(candidate.type))
  )
    return undefined;
  if (candidate.type === "event" && (typeof candidate.eventName !== "string" || !candidate.eventName.trim()))
    return undefined;
  if (candidate.type === "ack" && (typeof candidate.messageId !== "string" || !candidate.messageId.trim()))
    return undefined;
  if (candidate.type === "health" && (typeof candidate.fps !== "number" || !Number.isFinite(candidate.fps)))
    return undefined;
  if (candidate.type === "capabilities" && !Array.isArray(candidate.capabilities)) return undefined;
  if (candidate.widgetId !== undefined && typeof candidate.widgetId !== "string") return undefined;
  if (candidate.type === "capabilities") {
    const capabilities = (candidate.capabilities as unknown[]).filter(
      (item): item is UnityRuntimeCapability =>
        typeof item === "string" && UNITY_RUNTIME_CAPABILITIES.includes(item as UnityRuntimeCapability),
    );
    return { ...(candidate as unknown as UnityBridgeEventMessage), capabilities };
  }
  return candidate as unknown as UnityBridgeEventMessage;
}

export function unityTargetOrigin(url: string, configuredOrigin?: string): string | undefined {
  try {
    const configured = configuredOrigin?.trim();
    const base = typeof window !== "undefined" ? window.location.href : "http://localhost/";
    const origin = configured ? new URL(configured, base).origin : new URL(url, base).origin;
    return ["http:", "https:"].includes(new URL(origin).protocol) ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function resolveUnityDataLayers(
  bindings: DashboardDataWidgetConfig["unityDataBindings"],
  variables: Readonly<Record<string, JsonValue>>,
  filters: Readonly<Record<string, JsonValue>>,
  data: JsonValue | undefined,
): Record<string, JsonValue> {
  const context: Record<string, JsonValue> = {
    variables: { ...variables },
    filters: { ...filters },
    data: data ?? null,
  };
  return Object.fromEntries(
    (bindings ?? []).map((binding) => [
      binding.layerKey,
      resolveUnityDataKey(binding.dataKey, variables, filters, context),
    ]),
  );
}

function resolveUnityDataKey(
  dataKey: string,
  variables: Readonly<Record<string, JsonValue>>,
  filters: Readonly<Record<string, JsonValue>>,
  context: Record<string, JsonValue>,
): JsonValue {
  const key = dataKey.trim();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(variables, key)) return variables[key] ?? null;
  if (Object.prototype.hasOwnProperty.call(filters, key)) return filters[key] ?? null;
  if (key === "data") return context.data ?? null;
  const explicit = readJsonPath(context, key);
  if (explicit !== undefined) return explicit;
  const fromData = readJsonPath(context.data, key);
  return fromData === undefined ? null : fromData;
}

function readJsonPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function reconcileUnityVersionWidget(
  widget: DashboardDataWidgetConfig,
  resource: UnityResourceRecord,
  version: UnityResourceVersionRecord,
): DashboardDataWidgetConfig {
  const manifest = version.manifest;
  const next: DashboardDataWidgetConfig = {
    ...widget,
    unityResourceId: resource.id,
    unityResourceVersionId: version.id,
    unityManifestUrl: version.manifestUrl,
    unityUrl: version.playerUrl,
    unityVersion: manifest.unityVersion ?? "",
    unityBridgeVersion: manifest.bridgeVersion,
    unityScenes: manifest.scenes ?? [],
    unityEventNames: manifest.events ?? [],
    unityScene:
      widget.unityScene && manifest.scenes?.includes(widget.unityScene)
        ? widget.unityScene
        : (manifest.scenes?.[0] ?? ""),
    unityDataBindings: (manifest.dataLayers ?? []).map((layer) => ({
      layerKey: layer.key,
      dataKey: widget.unityDataBindings?.find((binding) => binding.layerKey === layer.key)?.dataKey || layer.key,
    })),
  };
  const propertyKeys = new Set((manifest.properties ?? []).map((property) => property.key));
  next.unityPropertyValues = Object.fromEntries(
    Object.entries(widget.unityPropertyValues ?? {}).filter(([key]) => propertyKeys.has(key)),
  );
  if (
    !next.unityDefaultAction ||
    !manifest.actions?.includes(next.unityDefaultAction.action) ||
    (next.unityDefaultAction.objectId &&
      !manifest.objects?.some((object) => object.id === next.unityDefaultAction?.objectId))
  )
    delete next.unityDefaultAction;
  return next;
}

export function parseUnityBuildManifest(value: unknown, manifestUrl: string): UnityBuildManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unity manifest must be an object");
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 1 || source.bridgeVersion !== UNITY_BRIDGE_VERSION)
    throw new Error("Unsupported Unity manifest or bridge version");
  if (typeof source.playerUrl !== "string" || !source.playerUrl.trim())
    throw new Error("Unity manifest playerUrl is required");
  const base = typeof window !== "undefined" ? window.location.href : "http://localhost/";
  const playerUrl = new URL(source.playerUrl, new URL(manifestUrl, base));
  if (!["http:", "https:"].includes(playerUrl.protocol)) throw new Error("Unity playerUrl must use HTTP(S)");
  const strings = (candidate: unknown) =>
    Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : undefined;
  const layers = Array.isArray(source.dataLayers)
    ? source.dataLayers.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.key !== "string") return [];
        return [
          {
            key: record.key,
            ...(typeof record.description === "string" ? { description: record.description } : {}),
            ...(typeof record.keyField === "string" ? { keyField: record.keyField } : {}),
            ...(typeof record.target === "string" ? { target: record.target } : {}),
          },
        ];
      })
    : undefined;
  const objects = Array.isArray(source.objects)
    ? source.objects.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string") return [];
        const tags = Array.isArray(record.tags)
          ? record.tags.filter((tag: unknown): tag is string => typeof tag === "string" && Boolean(tag.trim()))
          : undefined;
        return [
          {
            id: record.id,
            ...(typeof record.name === "string" ? { name: record.name } : {}),
            ...(typeof record.path === "string" ? { path: record.path } : {}),
            ...(tags?.length ? { tags } : {}),
          },
        ];
      })
    : undefined;
  const properties = Array.isArray(source.properties)
    ? source.properties.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (
          typeof record.key !== "string" ||
          !["string", "number", "boolean", "color", "select"].includes(String(record.type))
        )
          return [];
        const options = Array.isArray(record.options)
          ? record.options.filter((option: unknown): option is string => typeof option === "string")
          : undefined;
        return [
          {
            key: record.key,
            type: String(record.type) as "string" | "number" | "boolean" | "color" | "select",
            ...(typeof record.label === "string" ? { label: record.label } : {}),
            ...(typeof record.target === "string" ? { target: record.target } : {}),
            ...(options?.length ? { options } : {}),
          },
        ];
      })
    : undefined;
  const runtimeCapabilities = strings(source.runtimeCapabilities)?.filter((item): item is UnityRuntimeCapability =>
    UNITY_RUNTIME_CAPABILITIES.includes(item as UnityRuntimeCapability),
  );
  return {
    schemaVersion: 1,
    bridgeVersion: 1,
    playerUrl: playerUrl.href,
    ...(typeof source.unityVersion === "string" ? { unityVersion: source.unityVersion } : {}),
    ...(strings(source.scenes) ? { scenes: strings(source.scenes)! } : {}),
    ...(strings(source.events) ? { events: strings(source.events)! } : {}),
    ...(layers ? { dataLayers: layers } : {}),
    ...(strings(source.actions) ? { actions: strings(source.actions)! } : {}),
    ...(objects?.length ? { objects } : {}),
    ...(properties?.length ? { properties } : {}),
    ...(runtimeCapabilities?.length ? { runtimeCapabilities } : {}),
  };
}
