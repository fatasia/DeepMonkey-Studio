import type {
  IndustrialPrefabDefinition,
  IndustrialPrefabInstanceState,
  IndustrialPrefabKind,
  PrimitiveKind,
  Vector3Value,
} from "@bim-studio/contracts";

export interface IndustrialPrefabPrimitiveVisual {
  primitive: PrimitiveKind;
  color: string;
  scale: [number, number, number];
  rotation?: [number, number, number];
  centerHeight: number;
}

/** 为资源面板直接插入的工业预制体提供一致的蓝绿系可编辑代理。 */
export function industrialPrefabPrimitiveVisual(kind: IndustrialPrefabKind): IndustrialPrefabPrimitiveVisual {
  if (kind === "robot-arm") return visual("cylinder", "#2f80ed", [0.45, 1.1, 0.45], 1.1);
  if (kind === "person") return visual("capsule", "#36a3a0", [0.28, 0.9, 0.28], 0.9);
  if (kind === "sensor") return visual("sphere", "#35b7a2", [0.24, 0.24, 0.24], 0.24);
  if (kind === "camera") return visual("cylinder", "#3d8bd9", [0.2, 0.42, 0.2], 0.42, [Math.PI / 2, 0, 0]);
  if (kind === "conveyor") return visual("box", "#2b9c8b", [1.8, 0.3, 0.55], 0.3);
  if (kind === "agv") return visual("box", "#318f7d", [0.7, 0.28, 0.5], 0.28);
  if (kind === "vehicle") return visual("box", "#337fd1", [1.25, 0.45, 0.65], 0.45);
  if (kind === "fence") return visual("box", "#329b8b", [1.5, 0.7, 0.08], 0.7);
  if (kind === "access-control") return visual("box", "#347ebc", [0.55, 1, 0.18], 1);
  if (kind === "display") return visual("box", "#2b8f91", [0.8, 0.5, 0.08], 0.8);
  if (kind === "storage") return visual("box", "#258e75", [0.8, 0.9, 0.55], 0.9);
  return visual("box", kind === "electrical" ? "#357fbe" : "#278f83", [0.7, 0.75, 0.55], 0.75);
}

export function createIndustrialPrefabInstance(
  definition: IndustrialPrefabDefinition,
  start: Vector3Value,
  createId: () => string = () => crypto.randomUUID(),
): IndustrialPrefabInstanceState {
  const parameters = Object.fromEntries(definition.parameters.map((item) => [item.key, item.defaultValue]));
  const speedMps = numeric(parameters.speedMps, 1);
  const accelerationMps2 = numeric(parameters.accelerationMps2, 0.8);
  const routeMode = parameters.routeMode;
  return {
    definitionId: definition.id,
    definitionVersion: definition.version,
    kind: definition.kind,
    parameters,
    operatingState: "idle",
    ...(definition.routeCapable ? {
      motionRoute: {
        enabled: true,
        autoplay: false,
        points: [
          { id: createId(), position: { ...start } },
          { id: createId(), position: { ...start, x: start.x + 5 } },
        ],
        speedMps,
        accelerationMps2,
        loopMode: routeMode === "loop" || routeMode === "ping-pong" ? routeMode : "once",
        orientToPath: parameters.orientToPath !== false,
        startOffsetSeconds: 0,
      },
    } : {}),
  };
}

function visual(
  primitive: PrimitiveKind,
  color: string,
  scale: [number, number, number],
  centerHeight: number,
  rotation?: [number, number, number],
): IndustrialPrefabPrimitiveVisual {
  return { primitive, color, scale, centerHeight, ...(rotation ? { rotation } : {}) };
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
