import type { FastifyInstance } from "fastify";

export interface IndustrialDemoSnapshot {
  generatedAt: string;
  mode: "simulated-live";
  seed: "industrial-v1";
  factory: {
    output: number;
    target: number;
    planRate: number;
    cycleTime: number;
    wip: number;
    utilization: number;
    energy: number;
    alarmCount: number;
  };
  agvs: Array<{
    vehicleId: string;
    position: { x: number; y: number; z: number };
    heading: number;
    speed: number;
    status: "running" | "charging" | "warning";
    color: string;
    timestamp: string;
  }>;
  equipment: Array<{
    equipmentId: string;
    name: string;
    temperature: number;
    vibration: number;
    health: number;
    alarm: boolean;
    color: string;
  }>;
  history: Array<{
    timestamp: string;
    output: number;
    cycleTime: number;
    wip: number;
  }>;
}

/**
 * Deterministic, dependency-free data for the built-in industrial showcase.
 * The timestamp is the only input, so tests and historical playback can
 * reproduce exactly the same telemetry without a database or external broker.
 */
export function industrialDemoSnapshot(timestampMs = Date.now()): IndustrialDemoSnapshot {
  const second = Math.floor(timestampMs / 1_000);
  const timestamp = new Date(timestampMs).toISOString();
  const cycle = positiveModulo(second, 120);
  const output = 824 + Math.floor(positiveModulo(second, 960) / 12);
  const cycleTime = rounded(41.8 + Math.sin(second / 11) * 2.4, 1);
  const wip = Math.round(34 + Math.sin(second / 8) * 7);
  const utilization = rounded(88.2 + Math.sin(second / 17) * 4.8, 1);
  const warningWindow = cycle >= 88 && cycle < 96;
  const chargingWindow = cycle >= 46 && cycle < 58;
  const status = warningWindow ? "warning" as const : chargingWindow ? "charging" as const : "running" as const;
  const firstPosition = routePosition(cycle / 120);
  const secondPosition = routePosition(positiveModulo(cycle + 48, 120) / 120);
  const equipment = [
    equipmentReading("robot-a", "机器人 A", second, 0),
    equipmentReading("cnc-07", "加工中心 07", second, 13),
    equipmentReading("conveyor-02", "输送线 02", second, 29)
  ];
  const alarmCount = equipment.filter((item) => item.alarm).length + (warningWindow ? 1 : 0);

  return {
    generatedAt: timestamp,
    mode: "simulated-live",
    seed: "industrial-v1",
    factory: {
      output,
      target: 960,
      planRate: rounded(output / 960 * 100, 1),
      cycleTime,
      wip,
      utilization,
      energy: rounded(1_286 + Math.sin(second / 23) * 76, 0),
      alarmCount
    },
    agvs: [
      {
        vehicleId: "AGV-01",
        position: firstPosition,
        heading: routeHeading(cycle / 120),
        speed: status === "running" ? rounded(1.35 + Math.sin(second / 5) * 0.18, 2) : status === "charging" ? 0 : 0.45,
        status,
        color: status === "warning" ? "#f26b5e" : status === "charging" ? "#63a7ff" : "#54d69a",
        timestamp
      },
      {
        vehicleId: "AGV-02",
        position: secondPosition,
        heading: routeHeading(positiveModulo(cycle + 48, 120) / 120),
        speed: rounded(1.08 + Math.cos(second / 7) * 0.14, 2),
        status: "running",
        color: "#d9ad55",
        timestamp
      }
    ],
    equipment,
    history: Array.from({ length: 24 }, (_item, index) => {
      const sampleMs = timestampMs - (23 - index) * 5_000;
      const sampleSecond = Math.floor(sampleMs / 1_000);
      return {
        timestamp: new Date(sampleMs).toISOString(),
        output: 824 + Math.floor(positiveModulo(sampleSecond, 960) / 12),
        cycleTime: rounded(41.8 + Math.sin(sampleSecond / 11) * 2.4, 1),
        wip: Math.round(34 + Math.sin(sampleSecond / 8) * 7)
      };
    })
  };
}

export async function registerIndustrialDemoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/public/demo/industrial", async () => industrialDemoSnapshot());
  app.get("/api/public/demo/industrial/ws", { websocket: true }, (socket) => {
    const publish = () => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(industrialDemoSnapshot()));
    };
    publish();
    const timer = setInterval(publish, 1_000);
    const stop = () => clearInterval(timer);
    socket.once("close", stop);
    socket.once("error", stop);
  });
}

function equipmentReading(equipmentId: string, name: string, second: number, offset: number) {
  const temperature = rounded(58 + Math.sin((second + offset) / 13) * 9, 1);
  const vibration = rounded(2.1 + Math.cos((second + offset) / 9) * 0.75, 2);
  const health = Math.round(92 - Math.max(0, temperature - 62) * 1.2 - Math.max(0, vibration - 2.4) * 7);
  const alarm = health < 84;
  return {
    equipmentId,
    name,
    temperature,
    vibration,
    health,
    alarm,
    color: alarm ? "#f26b5e" : health < 88 ? "#e4b45b" : "#54d69a"
  };
}

function routePosition(progress: number): { x: number; y: number; z: number } {
  const route = [
    { x: -12, y: 0.55, z: -5 },
    { x: 12, y: 0.55, z: -5 },
    { x: 12, y: 0.55, z: 5 },
    { x: -12, y: 0.55, z: 5 },
    { x: -12, y: 0.55, z: -5 }
  ];
  const scaled = positiveModulo(progress, 1) * 4;
  const index = Math.min(3, Math.floor(scaled));
  const local = scaled - index;
  const start = route[index]!;
  const end = route[index + 1]!;
  return {
    x: rounded(start.x + (end.x - start.x) * local, 2),
    y: start.y,
    z: rounded(start.z + (end.z - start.z) * local, 2)
  };
}

function routeHeading(progress: number): number {
  const segment = Math.min(3, Math.floor(positiveModulo(progress, 1) * 4));
  return [0, Math.PI / 2, Math.PI, -Math.PI / 2][segment]!;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function rounded(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
