import type { PlantLiteModel, SimulationLimits } from "./model.js";
import type { Random } from "./random.js";

export interface Item {
  id: string;
  createdAt: number;
}

export interface NodeState {
  input: Item[];
  output: Item[];
  active: number;
  generated: number;
  busyArea: number;
  availableArea: number;
  queueArea: number;
  blocked: number;
  starved: number;
}

export interface ResourceState {
  busy: number;
  busyArea: number;
  availableArea: number;
  failed: boolean;
  failedArea: number;
}

export type EventType = "arrival" | "complete" | "failure" | "repair" | "availability";

export interface SimulationEvent {
  at: number;
  sequence: number;
  type: EventType;
  id: string;
  item?: Item;
}

export interface Runtime {
  model: PlantLiteModel;
  random: Random;
  limits: Required<SimulationLimits>;
  states: Map<string, NodeState>;
  resources: Map<string, ResourceState>;
  outgoing: Map<string, string[]>;
  events: SimulationEvent[];
  now: number;
  sequence: number;
  eventsProcessed: number;
  created: number;
  completed: number;
  leadTotal: number;
  wipArea: number;
}
