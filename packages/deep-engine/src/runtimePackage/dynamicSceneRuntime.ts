import { array, fields, integer, record, requireValue, resourceId, revision, snapshotJson, string } from "./primitives.js";
import type { RuntimeJson } from "./types.js";

export const DYNAMIC_SCENE_RUNTIME_SCHEMA = "deep-engine.dynamic-runtime" as const;
/** v2 adds clip controllers; v3 adds the native-ready physics command source. */
export const DYNAMIC_SCENE_RUNTIME_VERSION = 3 as const;
const MAX_TRACKS = 4096;
const MAX_KEYFRAMES = 65536;
const MAX_EVENTS = 65536;
const MAX_CONTROLLER_STATES = 512;
const MAX_CONTROLLER_PARAMETERS = 128;
const MAX_CONTROLLER_TRANSITIONS = 1024;
const MAX_PHYSICS_BODIES = 16_384;
const MAX_PHYSICS_JOINTS = 16_384;
const MAX_COLLIDER_INSTANCES = 65_536;

export type DynamicAnimationValue = readonly [number, number, number, number, number, number, number];
export type DynamicAnimationTransition = "linear" | "smooth" | "ease-in" | "ease-out" | "step";
export interface DynamicAnimationKeyframe { readonly timeMs: number; readonly value: DynamicAnimationValue; readonly transition?: DynamicAnimationTransition }
export type DynamicAnimationProperty = "translation" | "rotation" | "scale" | "camera-position" | "camera-target";
export interface DynamicAnimationTrack { readonly targetId: string; readonly property: DynamicAnimationProperty; readonly keyframes: readonly DynamicAnimationKeyframe[] }
export interface DynamicAnimationRuntime { readonly schema: "deep-engine.dynamic-animation"; readonly schemaVersion: 1; readonly durationMs: number; readonly autoplay?: boolean; readonly loop?: boolean; readonly tracks: readonly DynamicAnimationTrack[] }
export interface DynamicDataReplayEvent { readonly revision: number; readonly timeMs: number; readonly payload: RuntimeJson }
export interface DynamicDataReplayRuntime { readonly schema: "deep-engine.dynamic-data-replay"; readonly schemaVersion: 1; readonly channel: string; readonly events: readonly DynamicDataReplayEvent[] }
export type DynamicInteractionAction = "select" | "clear-selection" | "clip" | "set-visible";
export interface DynamicInteractionRuntime { readonly schema: "deep-engine.dynamic-interaction"; readonly schemaVersion: 1; readonly trigger: "pointer-select" | "pointer-clear" | "command"; readonly action: DynamicInteractionAction; readonly targetId: string | null }
export interface DynamicAnimationControllerState { readonly id: string; readonly modelId: string; readonly clipId: string; readonly loop: boolean }
export interface DynamicAnimationControllerTransition { readonly id: string; readonly fromStateId: string; readonly toStateId: string; readonly parameter: string; readonly equals: boolean }
export interface DynamicAnimationControllerRuntime {
  readonly schema: "deep-engine.animation-controller";
  readonly schemaVersion: 1;
  readonly initialStateId: string;
  readonly activeStateId: string;
  readonly transitionDurationMs: number;
  readonly states: readonly DynamicAnimationControllerState[];
  readonly parameters: Readonly<Record<string, boolean>>;
  readonly transitions: readonly DynamicAnimationControllerTransition[];
}
export interface DynamicPhysicsCharacterControllerRuntime {
  readonly offset?: number;
  readonly maxSlopeClimbAngle?: number;
  readonly minSlopeSlideAngle?: number;
  readonly autostep?: { readonly enabled: boolean; readonly maxHeight?: number; readonly minWidth?: number; readonly includeDynamicBodies?: boolean };
  readonly snapToGround?: { readonly enabled: boolean; readonly distance?: number };
}
export interface DynamicPhysicsBodyRuntime {
  readonly id: string;
  /** kinematic 为位姿驱动刚体；旧包只有 fixed/dynamic，解析保持向后兼容。 */
  readonly type: "fixed" | "dynamic" | "kinematic";
  readonly initialPose: { readonly translation: readonly [number, number, number]; readonly rotation: readonly [number, number, number, number] };
  readonly mass: number;
  readonly friction: number;
  readonly restitution: number;
  /** 仅 kinematic 刚体消费；其余类型携带该字段会被拒绝，避免无意义载荷进入 Native。 */
  readonly character?: DynamicPhysicsCharacterControllerRuntime;
  readonly collider: { readonly kind: "render-bounds"; readonly instanceIds: readonly string[] };
}
export interface DynamicPhysicsJointRuntime {
  readonly id: string;
  readonly kind: "revolute";
  readonly solver: "impulse" | "multibody";
  readonly bodyId: string;
  readonly connectedBodyId: string | null;
  readonly worldAnchor: readonly [number, number, number];
  readonly localAnchor: readonly [number, number, number];
  readonly axis: readonly [number, number, number];
  readonly limits: { readonly enabled: boolean; readonly min: number; readonly max: number };
  readonly motor: { readonly enabled: boolean; readonly targetVelocity: number; readonly strength: number };
}
export interface DynamicPhysicsRuntime {
  readonly schema: "deep-engine.physics-runtime";
  readonly schemaVersion: 1;
  readonly enabled: true;
  readonly playing: boolean;
  readonly gravity: readonly [number, number, number];
  readonly bodies: readonly DynamicPhysicsBodyRuntime[];
  readonly joints: readonly DynamicPhysicsJointRuntime[];
}
export interface DynamicSceneRuntime { readonly schema: typeof DYNAMIC_SCENE_RUNTIME_SCHEMA; readonly schemaVersion: 1 | 2 | 3; readonly id: string; readonly revision: number; readonly animation?: DynamicAnimationRuntime; readonly dataReplay?: DynamicDataReplayRuntime; readonly interaction?: DynamicInteractionRuntime; readonly animationController?: DynamicAnimationControllerRuntime; readonly physics?: DynamicPhysicsRuntime }

function finite(value: unknown, path: string): number {
  requireValue(typeof value === "number" && Number.isFinite(value), path, "Expected a finite number.");
  return value;
}
function tuple(value: unknown, path: string): DynamicAnimationValue {
  const values = array(value, path, 7);
  requireValue(values.length === 7, path, "Expected a 7-component TRS value.");
  return values.map((item, index) => finite(item, `${path}[${index}]`)) as unknown as DynamicAnimationValue;
}
function parseAnimation(value: unknown, path: string): DynamicAnimationRuntime {
  const object = record(value, path);
  fields(object, ["schema", "schemaVersion", "durationMs", "tracks"], ["autoplay", "loop"], path);
  requireValue(object.schema === "deep-engine.dynamic-animation" && object.schemaVersion === 1, path, "Unsupported animation schema.");
  const durationMs = integer(object.durationMs, 0, 86_400_000, `${path}.durationMs`);
  const tracks = array(object.tracks, `${path}.tracks`, MAX_TRACKS).map((item, index) => {
    const trackPath = `${path}.tracks[${index}]`, track = record(item, trackPath);
    fields(track, ["targetId", "property", "keyframes"], [], trackPath);
    const targetId = resourceId(track.targetId, `${trackPath}.targetId`);
    requireValue(["translation", "rotation", "scale", "camera-position", "camera-target"].includes(String(track.property)), `${trackPath}.property`, "Unsupported animation property.");
    const keyframes = array(track.keyframes, `${trackPath}.keyframes`, MAX_KEYFRAMES).map((frame, frameIndex) => {
      const framePath = `${trackPath}.keyframes[${frameIndex}]`, item = record(frame, framePath);
      fields(item, ["timeMs", "value"], ["transition"], framePath);
      const transition = item.transition === undefined ? undefined : String(item.transition);
      requireValue(transition === undefined || ["linear", "smooth", "ease-in", "ease-out", "step"].includes(transition), `${framePath}.transition`, "Unsupported transition.");
      return { timeMs: integer(item.timeMs, 0, durationMs, `${framePath}.timeMs`), value: tuple(item.value, `${framePath}.value`),
        ...(transition === undefined ? {} : { transition: transition as DynamicAnimationTransition }) };
    });
    requireValue(keyframes.length > 0 && keyframes.every((frame, i) => i === 0 || frame.timeMs >= keyframes[i - 1]!.timeMs), `${trackPath}.keyframes`, "Keyframes must be non-empty and sorted.");
    return { targetId, property: track.property as DynamicAnimationTrack["property"], keyframes };
  });
  requireValue(object.autoplay === undefined || typeof object.autoplay === "boolean", `${path}.autoplay`, "Expected a boolean.");
  requireValue(object.loop === undefined || typeof object.loop === "boolean", `${path}.loop`, "Expected a boolean.");
  const autoplay = object.autoplay as boolean | undefined;
  const loop = object.loop as boolean | undefined;
  return { schema: "deep-engine.dynamic-animation", schemaVersion: 1, durationMs, ...(autoplay === undefined ? {} : { autoplay }), ...(loop === undefined ? {} : { loop }), tracks };
}
function parseReplay(value: unknown, path: string): DynamicDataReplayRuntime {
  const object = record(value, path);
  fields(object, ["schema", "schemaVersion", "channel", "events"], [], path);
  requireValue(object.schema === "deep-engine.dynamic-data-replay" && object.schemaVersion === 1, path, "Unsupported data replay schema.");
  const channel = string(object.channel, `${path}.channel`);
  requireValue(channel.length > 0 && channel.length <= 128, `${path}.channel`, "Invalid replay channel.");
  const events = array(object.events, `${path}.events`, MAX_EVENTS).map((event, index) => {
    const eventPath = `${path}.events[${index}]`, item = record(event, eventPath);
    fields(item, ["revision", "timeMs", "payload"], [], eventPath);
    return { revision: revision(item.revision, `${eventPath}.revision`), timeMs: integer(item.timeMs, 0, 86_400_000, `${eventPath}.timeMs`), payload: snapshotJson(item.payload) };
  });
  requireValue(events.length > 0 && events.every((event, i) => i === 0 || event.revision > events[i - 1]!.revision), `${path}.events`, "Replay revisions must be strictly increasing.");
  return { schema: "deep-engine.dynamic-data-replay", schemaVersion: 1, channel, events };
}
function parseInteraction(value: unknown, path: string): DynamicInteractionRuntime {
  const object = record(value, path);
  fields(object, ["schema", "schemaVersion", "trigger", "action", "targetId"], [], path);
  requireValue(object.schema === "deep-engine.dynamic-interaction" && object.schemaVersion === 1, path, "Unsupported interaction schema.");
  requireValue(["pointer-select", "pointer-clear", "command"].includes(String(object.trigger)), `${path}.trigger`, "Unsupported trigger.");
  requireValue(["select", "clear-selection", "clip", "set-visible"].includes(String(object.action)), `${path}.action`, "Unsupported action.");
  const targetId = object.targetId === null ? null : resourceId(object.targetId, `${path}.targetId`);
  requireValue(object.action === "clear-selection" ? targetId === null : targetId !== null, path, "Action target shape is invalid.");
  return { schema: "deep-engine.dynamic-interaction", schemaVersion: 1, trigger: object.trigger as DynamicInteractionRuntime["trigger"], action: object.action as DynamicInteractionAction, targetId };
}

function boundedText(value: unknown, path: string): string {
  const text = string(value, path);
  requireValue(text.length > 0 && text.length <= 256, path, "Expected a non-empty string up to 256 characters.");
  return text;
}

function parseAnimationController(value: unknown, path: string): DynamicAnimationControllerRuntime {
  const object = record(value, path);
  fields(object, ["schema", "schemaVersion", "initialStateId", "activeStateId", "transitionDurationMs", "states", "parameters", "transitions"], [], path);
  requireValue(object.schema === "deep-engine.animation-controller" && object.schemaVersion === 1, path, "Unsupported animation controller schema.");
  const states = array(object.states, `${path}.states`, MAX_CONTROLLER_STATES).map((value, index) => {
    const statePath = `${path}.states[${index}]`, state = record(value, statePath);
    fields(state, ["id", "modelId", "clipId", "loop"], [], statePath);
    requireValue(typeof state.loop === "boolean", `${statePath}.loop`, "Expected a boolean.");
    return { id: resourceId(state.id, `${statePath}.id`), modelId: resourceId(state.modelId, `${statePath}.modelId`), clipId: boundedText(state.clipId, `${statePath}.clipId`), loop: state.loop };
  });
  requireValue(states.length > 0, `${path}.states`, "At least one animation controller state is required.");
  const stateIds = new Set(states.map(state => state.id));
  requireValue(stateIds.size === states.length, `${path}.states`, "Animation controller state ids must be unique.");

  const parameterObject = record(object.parameters, `${path}.parameters`);
  const parameterEntries = Object.entries(parameterObject);
  requireValue(parameterEntries.length <= MAX_CONTROLLER_PARAMETERS, `${path}.parameters`, "Too many animation controller parameters.");
  const parameters: Record<string, boolean> = Object.create(null);
  for (const [key, value] of parameterEntries) {
    resourceId(key, `${path}.parameters.${key}`);
    requireValue(typeof value === "boolean", `${path}.parameters.${key}`, "Expected a boolean.");
    parameters[key] = value;
  }

  const transitions = array(object.transitions, `${path}.transitions`, MAX_CONTROLLER_TRANSITIONS).map((value, index) => {
    const transitionPath = `${path}.transitions[${index}]`, transition = record(value, transitionPath);
    fields(transition, ["id", "fromStateId", "toStateId", "parameter", "equals"], [], transitionPath);
    requireValue(typeof transition.equals === "boolean", `${transitionPath}.equals`, "Expected a boolean.");
    return {
      id: resourceId(transition.id, `${transitionPath}.id`),
      fromStateId: resourceId(transition.fromStateId, `${transitionPath}.fromStateId`),
      toStateId: resourceId(transition.toStateId, `${transitionPath}.toStateId`),
      parameter: resourceId(transition.parameter, `${transitionPath}.parameter`),
      equals: transition.equals,
    };
  });
  requireValue(new Set(transitions.map(transition => transition.id)).size === transitions.length, `${path}.transitions`, "Animation controller transition ids must be unique.");
  const initialStateId = resourceId(object.initialStateId, `${path}.initialStateId`);
  const activeStateId = resourceId(object.activeStateId, `${path}.activeStateId`);
  requireValue(stateIds.has(initialStateId) && stateIds.has(activeStateId), path, "Animation controller state reference is invalid.");
  requireValue(transitions.every(transition => stateIds.has(transition.fromStateId) && stateIds.has(transition.toStateId) && Object.hasOwn(parameters, transition.parameter)), `${path}.transitions`, "Animation controller transition reference is invalid.");
  const statesById = new Map(states.map(state => [state.id, state]));
  requireValue(transitions.every(transition => statesById.get(transition.fromStateId)?.modelId === statesById.get(transition.toStateId)?.modelId), `${path}.transitions`, "Animation controller transitions cannot cross models.");
  return {
    schema: "deep-engine.animation-controller", schemaVersion: 1, initialStateId, activeStateId,
    transitionDurationMs: integer(object.transitionDurationMs, 0, 60_000, `${path}.transitionDurationMs`),
    states, parameters, transitions,
  };
}

function vec3(value: unknown, path: string): readonly [number, number, number] {
  const values = array(value, path, 3);
  requireValue(values.length === 3, path, "Expected a 3-component vector.");
  return values.map((item, index) => finite(item, `${path}[${index}]`)) as unknown as readonly [number, number, number];
}

/** 角色控制器参数：与 Rapier KinematicCharacterController 一一对应，未给字段交由引擎默认。 */
function parseCharacterController(value: unknown, path: string): DynamicPhysicsCharacterControllerRuntime {
  const object = record(value, path);
  fields(object, [], ["offset", "maxSlopeClimbAngle", "minSlopeSlideAngle", "autostep", "snapToGround"], path);
  const bounded = (input: unknown, inputPath: string, min: number, max: number, message: string) => {
    const result = finite(input, inputPath);
    requireValue(result > min && result <= max, inputPath, message);
    return result;
  };
  const angle = (input: unknown, inputPath: string) => {
    const result = finite(input, inputPath);
    requireValue(result >= 0 && result <= Math.PI / 2, inputPath, "Slope angles must be within 0..π/2 radians.");
    return result;
  };
  const character: {
    offset?: number;
    maxSlopeClimbAngle?: number;
    minSlopeSlideAngle?: number;
    autostep?: { enabled: boolean; maxHeight?: number; minWidth?: number; includeDynamicBodies?: boolean };
    snapToGround?: { enabled: boolean; distance?: number };
  } = {};
  if (Object.hasOwn(object, "offset")) character.offset = bounded(object.offset, `${path}.offset`, 0, 10, "Offset must be within (0, 10] metres.");
  if (Object.hasOwn(object, "maxSlopeClimbAngle")) character.maxSlopeClimbAngle = angle(object.maxSlopeClimbAngle, `${path}.maxSlopeClimbAngle`);
  if (Object.hasOwn(object, "minSlopeSlideAngle")) character.minSlopeSlideAngle = angle(object.minSlopeSlideAngle, `${path}.minSlopeSlideAngle`);
  if (Object.hasOwn(object, "autostep")) {
    const autostep = record(object.autostep, `${path}.autostep`);
    fields(autostep, ["enabled"], ["maxHeight", "minWidth", "includeDynamicBodies"], `${path}.autostep`);
    requireValue(typeof autostep.enabled === "boolean", `${path}.autostep.enabled`, "Expected a boolean.");
    requireValue(!Object.hasOwn(autostep, "includeDynamicBodies") || typeof autostep.includeDynamicBodies === "boolean", `${path}.autostep.includeDynamicBodies`, "Expected a boolean.");
    character.autostep = {
      enabled: autostep.enabled,
      ...(Object.hasOwn(autostep, "maxHeight") ? { maxHeight: bounded(autostep.maxHeight, `${path}.autostep.maxHeight`, 0, 10, "Autostep height must be within (0, 10] metres.") } : {}),
      ...(Object.hasOwn(autostep, "minWidth") ? { minWidth: bounded(autostep.minWidth, `${path}.autostep.minWidth`, 0, 10, "Autostep width must be within (0, 10] metres.") } : {}),
      ...(Object.hasOwn(autostep, "includeDynamicBodies") ? { includeDynamicBodies: autostep.includeDynamicBodies as boolean } : {}),
    };
  }
  if (Object.hasOwn(object, "snapToGround")) {
    const snap = record(object.snapToGround, `${path}.snapToGround`);
    fields(snap, ["enabled"], ["distance"], `${path}.snapToGround`);
    requireValue(typeof snap.enabled === "boolean", `${path}.snapToGround.enabled`, "Expected a boolean.");
    character.snapToGround = {
      enabled: snap.enabled,
      ...(Object.hasOwn(snap, "distance") ? { distance: bounded(snap.distance, `${path}.snapToGround.distance`, 0, 10, "Snap distance must be within (0, 10] metres.") } : {}),
    };
  }
  return character;
}

function parsePhysics(value: unknown, path: string): DynamicPhysicsRuntime {
  const object = record(value, path);
  fields(object, ["schema", "schemaVersion", "enabled", "playing", "gravity", "bodies", "joints"], [], path);
  requireValue(object.schema === "deep-engine.physics-runtime" && object.schemaVersion === 1 && object.enabled === true, path, "Unsupported physics schema.");
  requireValue(typeof object.playing === "boolean", `${path}.playing`, "Expected a boolean.");
  const gravity = vec3(object.gravity, `${path}.gravity`);
  const bodies = array(object.bodies, `${path}.bodies`, MAX_PHYSICS_BODIES).map((value, index) => {
    const bodyPath = `${path}.bodies[${index}]`, body = record(value, bodyPath);
    fields(body, ["id", "type", "initialPose", "mass", "friction", "restitution", "collider"], ["character"], bodyPath);
    requireValue(body.type === "fixed" || body.type === "dynamic" || body.type === "kinematic", `${bodyPath}.type`, "Unsupported rigid body type.");
    const initialPose = record(body.initialPose, `${bodyPath}.initialPose`);
    fields(initialPose, ["translation", "rotation"], [], `${bodyPath}.initialPose`);
    const translation = vec3(initialPose.translation, `${bodyPath}.initialPose.translation`);
    const rotationValues = array(initialPose.rotation, `${bodyPath}.initialPose.rotation`, 4);
    requireValue(rotationValues.length === 4, `${bodyPath}.initialPose.rotation`, "Expected a quaternion.");
    const rotation = rotationValues.map((item, itemIndex) => finite(item, `${bodyPath}.initialPose.rotation[${itemIndex}]`)) as unknown as readonly [number, number, number, number];
    requireValue(Math.hypot(...rotation) > 1e-9, `${bodyPath}.initialPose.rotation`, "Quaternion must be non-zero.");
    const collider = record(body.collider, `${bodyPath}.collider`);
    fields(collider, ["kind", "instanceIds"], [], `${bodyPath}.collider`);
    requireValue(collider.kind === "render-bounds", `${bodyPath}.collider.kind`, "Unsupported collider source.");
    const instanceIds = array(collider.instanceIds, `${bodyPath}.collider.instanceIds`, MAX_COLLIDER_INSTANCES)
      .map((id, itemIndex) => resourceId(id, `${bodyPath}.collider.instanceIds[${itemIndex}]`));
    requireValue(instanceIds.length > 0 && new Set(instanceIds).size === instanceIds.length
      && instanceIds.every((id, itemIndex) => itemIndex === 0 || id > instanceIds[itemIndex - 1]!), `${bodyPath}.collider.instanceIds`, "Collider instance ids must be non-empty, unique and sorted.");
    const mass = finite(body.mass, `${bodyPath}.mass`), friction = finite(body.friction, `${bodyPath}.friction`), restitution = finite(body.restitution, `${bodyPath}.restitution`);
    requireValue(mass > 0 && friction >= 0 && friction <= 2 && restitution >= 0 && restitution <= 1, bodyPath, "Rigid body coefficients are outside the supported range.");
    // 角色控制器只对 kinematic 刚体有意义；其余类型带该字段属于下译缺陷，直接拒绝。
    requireValue(Object.hasOwn(body, "character") ? body.type === "kinematic" : true, `${bodyPath}.character`, "Character controllers require a kinematic rigid body.");
    const character = Object.hasOwn(body, "character") ? parseCharacterController(body.character, `${bodyPath}.character`) : undefined;
    return { id: resourceId(body.id, `${bodyPath}.id`), type: body.type as "fixed" | "dynamic" | "kinematic", initialPose: { translation, rotation }, mass, friction, restitution,
      ...(character ? { character } : {}),
      collider: { kind: "render-bounds" as const, instanceIds } };
  });
  requireValue(bodies.length > 0 && new Set(bodies.map(body => body.id)).size === bodies.length
    && bodies.every((body, index) => index === 0 || body.id > bodies[index - 1]!.id), `${path}.bodies`, "Physics bodies must be non-empty, unique and sorted.");
  const bodyIds = new Set(bodies.map(body => body.id));
  const joints = array(object.joints, `${path}.joints`, MAX_PHYSICS_JOINTS).map((value, index) => {
    const jointPath = `${path}.joints[${index}]`, joint = record(value, jointPath);
    fields(joint, ["id", "kind", "solver", "bodyId", "connectedBodyId", "worldAnchor", "localAnchor", "axis", "limits", "motor"], [], jointPath);
    requireValue(joint.kind === "revolute" && (joint.solver === "impulse" || joint.solver === "multibody"), jointPath, "Unsupported physics joint.");
    const bodyId = resourceId(joint.bodyId, `${jointPath}.bodyId`);
    const connectedBodyId = joint.connectedBodyId === null ? null : resourceId(joint.connectedBodyId, `${jointPath}.connectedBodyId`);
    requireValue(bodyIds.has(bodyId) && (connectedBodyId === null || bodyIds.has(connectedBodyId)) && connectedBodyId !== bodyId, jointPath, "Physics joint body reference is invalid.");
    const axis = vec3(joint.axis, `${jointPath}.axis`);
    requireValue(axis.some(component => Math.abs(component) > 1e-9), `${jointPath}.axis`, "Joint axis must be non-zero.");
    const limits = record(joint.limits, `${jointPath}.limits`), motor = record(joint.motor, `${jointPath}.motor`);
    fields(limits, ["enabled", "min", "max"], [], `${jointPath}.limits`);
    fields(motor, ["enabled", "targetVelocity", "strength"], [], `${jointPath}.motor`);
    requireValue(typeof limits.enabled === "boolean" && typeof motor.enabled === "boolean", jointPath, "Joint feature flags must be boolean.");
    const min = finite(limits.min, `${jointPath}.limits.min`), max = finite(limits.max, `${jointPath}.limits.max`);
    const targetVelocity = finite(motor.targetVelocity, `${jointPath}.motor.targetVelocity`), strength = finite(motor.strength, `${jointPath}.motor.strength`);
    requireValue(min <= max && strength >= 0, jointPath, "Joint limits or motor strength are invalid.");
    requireValue(joint.solver !== "multibody" || (!limits.enabled && !motor.enabled), jointPath, "Multibody limits and motors are not supported.");
    return { id: resourceId(joint.id, `${jointPath}.id`), kind: "revolute" as const, solver: joint.solver as "impulse" | "multibody", bodyId, connectedBodyId,
      worldAnchor: vec3(joint.worldAnchor, `${jointPath}.worldAnchor`), localAnchor: vec3(joint.localAnchor, `${jointPath}.localAnchor`), axis,
      limits: { enabled: limits.enabled, min, max }, motor: { enabled: motor.enabled, targetVelocity, strength } };
  });
  requireValue(new Set(joints.map(joint => joint.id)).size === joints.length
    && joints.every((joint, index) => index === 0 || joint.id > joints[index - 1]!.id), `${path}.joints`, "Physics joints must be unique and sorted.");
  const multibodyParents = new Map<string, string | null>();
  for (const joint of joints.filter(joint => joint.solver === "multibody")) {
    requireValue(!multibodyParents.has(joint.bodyId), `${path}.joints`, "A multibody child can have only one parent.");
    multibodyParents.set(joint.bodyId, joint.connectedBodyId);
  }
  for (const child of multibodyParents.keys()) {
    const visited = new Set<string>();
    let current: string | null | undefined = child;
    while (current !== null && current !== undefined) {
      requireValue(!visited.has(current), `${path}.joints`, "Multibody graph contains a cycle.");
      visited.add(current);
      current = multibodyParents.get(current);
    }
  }
  return { schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: object.playing, gravity, bodies, joints };
}

export function validateDynamicSceneRuntime(input: unknown): { valid: true; value: DynamicSceneRuntime; issues: readonly [] } | { valid: false; issues: readonly { path: string; message: string }[] } {
  try {
    const object = record(input, "$");
    requireValue(object.schema === DYNAMIC_SCENE_RUNTIME_SCHEMA && (object.schemaVersion === 1 || object.schemaVersion === 2 || object.schemaVersion === 3), "$.schema", "Unsupported dynamic runtime schema.");
    const schemaVersion = object.schemaVersion as 1 | 2 | 3;
    fields(object, ["schema", "schemaVersion", "id", "revision"], schemaVersion === 3 ? ["animation", "dataReplay", "interaction", "animationController", "physics"] : schemaVersion === 2 ? ["animation", "dataReplay", "interaction", "animationController"] : ["animation", "dataReplay", "interaction"], "$");
    const value: DynamicSceneRuntime = { schema: DYNAMIC_SCENE_RUNTIME_SCHEMA, schemaVersion, id: resourceId(object.id, "$.id"), revision: revision(object.revision, "$.revision"),
      ...(Object.hasOwn(object, "animation") ? { animation: parseAnimation(object.animation, "$.animation") } : {}),
      ...(Object.hasOwn(object, "dataReplay") ? { dataReplay: parseReplay(object.dataReplay, "$.dataReplay") } : {}),
      ...(Object.hasOwn(object, "interaction") ? { interaction: parseInteraction(object.interaction, "$.interaction") } : {}),
      ...(Object.hasOwn(object, "animationController") ? { animationController: parseAnimationController(object.animationController, "$.animationController") } : {}),
      ...(Object.hasOwn(object, "physics") ? { physics: parsePhysics(object.physics, "$.physics") } : {}) };
    requireValue(value.animation || value.dataReplay || value.interaction || value.animationController || value.physics, "$", "At least one dynamic channel is required.");
    return { valid: true, value, issues: [] };
  } catch (error) { return { valid: false, issues: [{ path: error instanceof Error && "path" in error ? String((error as { path: unknown }).path) : "$", message: error instanceof Error ? error.message : "Invalid dynamic runtime." }] }; }
}
