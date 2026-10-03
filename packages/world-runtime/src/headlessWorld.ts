import RAPIER from "@dimforge/rapier3d-compat";
import {
  WORLD_API_VERSION,
  WORLD_FIXED_HZ,
  WORLD_GROUND_ID,
  WORLD_LIMITS,
  canonicalJson,
  validateWorldObserveRequest,
  validateWorldResetRequest,
  validateWorldSnapshot,
  validateWorldStepRequest,
  type WorldBodyObservation,
  type WorldColliderSpec,
  type WorldContactObservation,
  type WorldEventObservation,
  type WorldObservation,
  type WorldQuat,
  type WorldSnapshot,
  type WorldSnapshotObject,
  type WorldStepResult,
  type WorldVec3,
} from "@bim-studio/contracts";
import { planWorldAction, type WorldOp } from "./worldAction.js";
import {
  DYNAMIC_ANGULAR_DAMPING,
  DYNAMIC_LINEAR_DAMPING,
  parseSceneObjects,
  primitiveBaseCollider,
  scaleCollider,
  sceneSemanticHash,
} from "./worldObjects.js";
import { WorldRng, WorldRuntimeError, eulerXyzToQuaternion, sha256Hex } from "./worldMath.js";

type Rapier = typeof RAPIER;
type World = InstanceType<Rapier["World"]>;
type RigidBody = InstanceType<Rapier["RigidBody"]>;
type ColliderDesc = InstanceType<Rapier["ColliderDesc"]>;

const GROUND_HALF_EXTENTS: WorldVec3 = [5_000, 0.05, 5_000];
const GROUND_FRICTION = 0.9;
/** 单世界内存估算（字节）：Rapier wasm 世界的固定开销 + 每物体经验值，供会话配额使用。 */
const WORLD_BASE_BYTES = 256 * 1024;
const WORLD_BYTES_PER_OBJECT = 4 * 1024;

let rapierReady: Promise<Rapier> | undefined;

/** Rapier compat 内嵌 wasm，Node 无头可用；只屏蔽其已知的上游弃用提示，其它告警原样透传。 */
export function loadRapier(): Promise<Rapier> {
  rapierReady ??= (async () => {
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (args[0] !== "using deprecated parameters for the initialization function; pass a single object instead") warn(...args);
    };
    try {
      await RAPIER.init();
    } finally {
      console.warn = warn;
    }
    return RAPIER;
  })();
  return rapierReady;
}

const xyz = (v: { x: number; y: number; z: number }): WorldVec3 => [v.x, v.y, v.z];
const vec = ([x, y, z]: WorldVec3) => ({ x, y, z });
const quat = ([x, y, z, w]: WorldQuat) => ({ x, y, z, w });

interface WorldInit {
  seed: number;
  tick: number;
  sceneId: string;
  sceneHash: string;
  traceHash: string;
  rngState: number;
  gravity: WorldVec3;
  ground: boolean;
  groundHandle: number | null;
  objects: WorldSnapshotObject[];
}

/** 确定性无头世界：固定 60Hz、整数 tick、Rapier 刚体；无任何墙钟/随机源依赖。 */
export class HeadlessWorld {
  readonly seed: number;
  readonly sceneId: string;
  private readonly sceneHash: string;
  private readonly rng: WorldRng;
  private readonly objects = new Map<string, WorldSnapshotObject>();
  private readonly owners = new Map<number, string>();
  private readonly queue: InstanceType<Rapier["EventQueue"]>;
  private readonly gravity: WorldVec3;
  private readonly ground: boolean;
  private groundHandle: number | null;
  private currentTick: number;
  private traceHash: string;
  private contacts: WorldContactObservation[] = [];
  private events: WorldEventObservation[] = [];
  private truncated = false;

  private constructor(private readonly rapier: Rapier, private readonly world: World, init: WorldInit) {
    this.seed = init.seed;
    this.sceneId = init.sceneId;
    this.sceneHash = init.sceneHash;
    this.rng = new WorldRng(init.rngState);
    this.gravity = init.gravity;
    this.ground = init.ground;
    this.groundHandle = init.groundHandle;
    this.currentTick = init.tick;
    this.traceHash = init.traceHash;
    // autoDrain 关闭：一次 step 内逐 tick 手动 drain，不丢中间 tick 的碰撞事件。
    this.queue = new rapier.EventQueue(false);
    this.world.timestep = 1 / WORLD_FIXED_HZ;
    for (const object of init.objects) this.objects.set(object.id, object);
  }

  get tick(): number { return this.currentTick; }
  get objectCount(): number { return this.objects.size; }
  get estimatedBytes(): number { return WORLD_BASE_BYTES + this.objects.size * WORLD_BYTES_PER_OBJECT; }

  /** reset(seed, scene)：用 SceneSnapshot 初始化新世界；输入按不可信数据校验。 */
  static async reset(input: unknown): Promise<HeadlessWorld> {
    const request = validateWorldResetRequest(input);
    const rapier = await loadRapier();
    const parsed = parseSceneObjects(request.scene);
    const ground = request.options?.ground ?? true;
    const sceneHash = sceneSemanticHash(parsed, ground);
    const world = new rapier.World(vec(parsed.gravity));
    const instance = new HeadlessWorld(rapier, world, {
      seed: request.seed, tick: 0, sceneId: parsed.sceneId, sceneHash, rngState: request.seed, gravity: parsed.gravity, ground, groundHandle: null,
      traceHash: sha256Hex("world-trace/1", sceneHash, String(request.seed)), objects: parsed.objects,
    });
    if (ground) instance.createGround();
    const jitter = request.options?.initialPositionJitter ?? 0;
    for (const object of instance.objects.values()) {
      if (object.body.type === "none") continue;
      if (object.body.type === "dynamic" && jitter > 0) {
        const [x, y, z] = object.transform.position;
        object.transform.position = [x + (instance.rng.next() * 2 - 1) * jitter, y + (instance.rng.next() * 2 - 1) * jitter, z + (instance.rng.next() * 2 - 1) * jitter];
      }
      const velocity = parsed.initialVelocities.get(object.id);
      instance.spawn(object, velocity ? { linvel: velocity } : {});
    }
    return instance;
  }

  /** restore(snapshot)：先核验哈希与句柄，再装载；任何不一致都按 snapshot-corrupt 拒绝。 */
  static async restore(input: unknown): Promise<HeadlessWorld> {
    const snapshot = validateWorldSnapshot(input);
    const bytes = Buffer.from(snapshot.physics.data, "base64");
    if (bytes.length !== snapshot.physics.byteLength || sha256Hex(bytes) !== snapshot.physics.sha256) {
      throw new WorldRuntimeError("snapshot-corrupt", "物理字节与 byteLength/sha256 不一致");
    }
    const { snapshotHash, ...body } = snapshot;
    if (sha256Hex(canonicalJson(body)) !== snapshotHash) throw new WorldRuntimeError("snapshot-corrupt", "snapshotHash 不匹配：快照被改动或损坏");
    const rapier = await loadRapier();
    let world: World;
    try {
      world = rapier.World.restoreSnapshot(new Uint8Array(bytes));
    } catch (error) {
      throw new WorldRuntimeError("snapshot-corrupt", `物理快照无法解码：${error instanceof Error ? error.message : String(error)}`);
    }
    const instance = new HeadlessWorld(rapier, world, { ...snapshot, rngState: snapshot.rngState, objects: structuredClone(snapshot.objects) });
    // getRigidBody 对无效句柄也会返回包装对象，必须与世界里真实存在的刚体集合比对。
    const live = new Map<number, RigidBody>();
    world.bodies.forEach((body: RigidBody) => live.set(body.handle, body));
    const claim = (handle: number, label: string): RigidBody => {
      const body = live.get(handle);
      if (!body || body.numColliders() < 1) {
        instance.dispose();
        throw new WorldRuntimeError("snapshot-corrupt", `快照${label}的刚体句柄无效：${handle}`);
      }
      live.delete(handle);
      return body;
    };
    for (const object of instance.objects.values()) {
      if (object.handle !== null) instance.owners.set(claim(object.handle, `物体 ${object.id} `).collider(0).handle, object.id);
    }
    if (snapshot.groundHandle !== null) instance.owners.set(claim(snapshot.groundHandle, "地面").collider(0).handle, WORLD_GROUND_ID);
    if (live.size > 0) {
      instance.dispose();
      throw new WorldRuntimeError("snapshot-corrupt", `物理世界含 ${live.size} 个未登记刚体`);
    }
    return instance;
  }

  step(input: unknown): WorldStepResult {
    const { action, ticks } = validateWorldStepRequest(input);
    if (this.currentTick + ticks > WORLD_LIMITS.maxTotalTicks) {
      throw new WorldRuntimeError("limit-exceeded", `世界累计 tick 将超过上限 ${WORLD_LIMITS.maxTotalTicks}（当前 ${this.currentTick}）`);
    }
    const plan = planWorldAction(action, this.sceneId, this.objects);
    const tickBefore = this.currentTick;
    this.contacts = [];
    this.events = [];
    this.truncated = false;
    this.applyOps(plan.ops, tickBefore);
    for (let index = 0; index < ticks; index += 1) {
      this.world.step(this.queue);
      this.currentTick += 1;
      this.queue.drainCollisionEvents((first: number, second: number, started: boolean) => this.recordContact(first, second, started));
    }
    const observation = this.observe({});
    this.traceHash = sha256Hex(this.traceHash, String(tickBefore), String(ticks), canonicalJson(action), observation.stateHash);
    return { ticksAdvanced: ticks, tickBefore, tickAfter: this.currentTick, commandResults: plan.commandResults, traceHash: this.traceHash, observation };
  }

  observe(input: unknown): WorldObservation {
    const request = validateWorldObserveRequest(input);
    const channels = new Set(request.channels ?? ["poses", "contacts", "events"]);
    const bodies = this.readBodies();
    return {
      observationVersion: WORLD_API_VERSION,
      tick: this.currentTick,
      timeSeconds: this.currentTick / WORLD_FIXED_HZ,
      seed: this.seed,
      stateHash: this.stateHash(bodies),
      ...(channels.has("poses") ? { bodies: bodies.map((entry) => entry.observation) } : {}),
      ...(channels.has("contacts") ? { contacts: this.contacts.map((contact) => ({ ...contact })) } : {}),
      ...(channels.has("events") ? { events: structuredClone(this.events) } : {}),
      ...(this.truncated ? { truncated: true } : {}),
      ...(request.sensors?.length
        ? { sensors: Object.fromEntries(request.sensors.map((sensor) => [sensor.id, { status: "unsupported" as const, kind: sensor.kind, reason: "reserved-for-stage-3" as const }])) }
        : {}),
    };
  }

  snapshot(): WorldSnapshot {
    const bytes = Buffer.from(this.world.takeSnapshot());
    const body: Omit<WorldSnapshot, "snapshotHash"> = {
      snapshotVersion: WORLD_API_VERSION, seed: this.seed, tick: this.currentTick, sceneId: this.sceneId, sceneHash: this.sceneHash,
      traceHash: this.traceHash, rngState: this.rng.value, gravity: this.gravity, ground: this.ground,
      objects: structuredClone([...this.objects.values()]), groundHandle: this.groundHandle,
      physics: { encoding: "base64", data: bytes.toString("base64"), byteLength: bytes.length, sha256: sha256Hex(bytes) },
    };
    return { ...body, snapshotHash: sha256Hex(canonicalJson(body)) };
  }

  dispose(): void {
    this.queue.free();
    this.world.free();
  }

  private createGround(): void {
    const body = this.world.createRigidBody(this.rapier.RigidBodyDesc.fixed().setTranslation(0, -GROUND_HALF_EXTENTS[1], 0));
    const collider = this.world.createCollider(
      this.rapier.ColliderDesc.cuboid(...GROUND_HALF_EXTENTS).setFriction(GROUND_FRICTION), body,
    );
    this.groundHandle = body.handle;
    this.owners.set(collider.handle, WORLD_GROUND_ID);
  }

  private colliderDesc(spec: WorldColliderSpec): ColliderDesc {
    const { ColliderDesc } = this.rapier;
    switch (spec.shape) {
      case "cuboid": return ColliderDesc.cuboid(...spec.halfExtents);
      case "ball": return ColliderDesc.ball(spec.radius);
      case "cylinder": return ColliderDesc.cylinder(spec.halfHeight, spec.radius);
      case "cone": return ColliderDesc.cone(spec.halfHeight, spec.radius);
      case "capsule": return ColliderDesc.capsule(spec.halfHeight, spec.radius);
    }
  }

  private spawn(object: WorldSnapshotObject, state: { position?: WorldVec3; rotation?: WorldQuat; linvel?: WorldVec3; angvel?: WorldVec3 }): void {
    if (!object.collider) throw new WorldRuntimeError("invalid-action", `${object.id} 没有碰撞体`);
    const { RigidBodyDesc, ActiveEvents } = this.rapier;
    const { type } = object.body;
    const desc = type === "dynamic" ? RigidBodyDesc.dynamic() : type === "kinematic" ? RigidBodyDesc.kinematicPositionBased() : RigidBodyDesc.fixed();
    desc.setTranslation(...(state.position ?? object.transform.position))
      .setRotation(quat(state.rotation ?? eulerXyzToQuaternion(object.transform.rotation)));
    if (type === "dynamic") {
      desc.setCcdEnabled(true).setLinearDamping(DYNAMIC_LINEAR_DAMPING).setAngularDamping(DYNAMIC_ANGULAR_DAMPING);
      if (state.linvel) desc.setLinvel(...state.linvel);
      if (state.angvel) desc.setAngvel(vec(state.angvel));
    }
    const body = this.world.createRigidBody(desc);
    const collider = this.colliderDesc(scaleCollider(object.collider, object.transform.scale))
      .setFriction(object.body.friction).setRestitution(object.body.restitution)
      .setActiveEvents(ActiveEvents.COLLISION_EVENTS);
    if (type === "dynamic") collider.setMass(object.body.mass);
    this.owners.set(this.world.createCollider(collider, body).handle, object.id);
    object.handle = body.handle;
  }

  private despawn(object: WorldSnapshotObject): void {
    if (object.handle === null) return;
    const body = this.world.getRigidBody(object.handle);
    this.owners.delete(body.collider(0).handle);
    this.world.removeRigidBody(body);
    object.handle = null;
  }

  private bodyOf(object: WorldSnapshotObject): RigidBody | undefined {
    return object.handle === null ? undefined : this.world.getRigidBody(object.handle);
  }

  private applyOps(ops: readonly WorldOp[], tick: number): void {
    for (const op of ops) {
      if (op.op === "event") {
        this.events.push({ tick, type: "business.event", name: op.name, sceneId: this.sceneId, ...(op.data !== undefined ? { data: op.data } : {}) });
        continue;
      }
      if (op.op === "create") {
        this.objects.set(op.id, {
          id: op.id, kind: op.kind, source: "primitive", name: op.name, visible: true, handle: null,
          body: { type: "none", mass: 1, friction: 0.5, restitution: 0 },
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          collider: primitiveBaseCollider(op.kind) ?? null,
        });
        continue;
      }
      const object = this.objects.get(op.id) as WorldSnapshotObject;
      this.applyObjectOp(object, op);
    }
  }

  private applyObjectOp(object: WorldSnapshotObject, op: Exclude<WorldOp, { op: "event" | "create" }>): void {
    const body = this.bodyOf(object);
    switch (op.op) {
      case "delete": this.despawn(object); this.objects.delete(object.id); return;
      case "visibility": object.visible = op.visible; return;
      case "impulse": body?.applyImpulse(vec(op.vector), true); return;
      case "linear-velocity": body?.setLinvel(vec(op.vector), true); return;
      case "angular-velocity": body?.setAngvel(vec(op.vector), true); return;
      case "set-body": {
        const previous = body ? { position: xyz(body.translation()), rotation: [body.rotation().x, body.rotation().y, body.rotation().z, body.rotation().w] as unknown as WorldQuat, linvel: xyz(body.linvel()), angvel: xyz(body.angvel()) } : undefined;
        const wasDynamic = object.body.type === "dynamic";
        this.despawn(object);
        object.body = { type: op.body.type, mass: op.body.mass ?? object.body.mass, friction: op.body.friction ?? object.body.friction, restitution: op.body.restitution ?? object.body.restitution };
        if (op.body.type === "none") return;
        const keepVelocity = wasDynamic && op.body.type === "dynamic" && previous;
        this.spawn(object, { ...(previous ? { position: previous.position, rotation: previous.rotation } : {}), ...(keepVelocity ? { linvel: previous.linvel, angvel: previous.angvel } : {}) });
        return;
      }
      case "transform": {
        if (op.scale) object.transform.scale = op.scale;
        if (!body) {
          if (op.position) object.transform.position = op.position;
          if (op.rotation) object.transform.rotation = op.rotation;
          return;
        }
        const rotation = op.rotation ? quat(eulerXyzToQuaternion(op.rotation)) : undefined;
        if (object.body.type === "kinematic") {
          if (op.position) body.setNextKinematicTranslation(vec(op.position));
          if (rotation) body.setNextKinematicRotation(rotation);
          return;
        }
        if (op.position) body.setTranslation(vec(op.position), true);
        if (rotation) body.setRotation(rotation, true);
        if (object.body.type === "dynamic") { body.setLinvel({ x: 0, y: 0, z: 0 }, true); body.setAngvel({ x: 0, y: 0, z: 0 }, true); }
      }
    }
  }

  private recordContact(first: number, second: number, started: boolean): void {
    const a = this.owners.get(first), b = this.owners.get(second);
    if (a === undefined || b === undefined) return;
    if (this.contacts.length >= WORLD_LIMITS.maxContactsPerStep) { this.truncated = true; return; }
    const tick = this.currentTick;
    this.contacts.push({ tick, a, b, started });
    const name = started ? "collisionStart" : "collisionEnd";
    for (const [self, other] of [[a, b], [b, a]] as const) {
      if (self !== WORLD_GROUND_ID) this.events.push({ tick, type: "object.event", name, target: { kind: "object", sceneId: this.sceneId, objectId: self }, data: { other } });
    }
  }

  private readBodies(): Array<{ observation: WorldBodyObservation; raw: number[] }> {
    return [...this.objects.values()].map((object) => {
      const body = this.bodyOf(object);
      const position = body ? xyz(body.translation()) : object.transform.position;
      const q = body ? body.rotation() : undefined;
      const rotation: WorldQuat = q ? [q.x, q.y, q.z, q.w] : eulerXyzToQuaternion(object.transform.rotation);
      const linearVelocity: WorldVec3 = body ? xyz(body.linvel()) : [0, 0, 0];
      const angularVelocity: WorldVec3 = body ? xyz(body.angvel()) : [0, 0, 0];
      const sleeping = body ? body.isSleeping() : false;
      return {
        observation: { id: object.id, kind: object.kind, bodyType: object.body.type, visible: object.visible, position, rotation, linearVelocity, angularVelocity, sleeping },
        raw: [...position, ...rotation, ...linearVelocity, ...angularVelocity, sleeping ? 1 : 0],
      };
    });
  }

  /** 位姿/速度的 float64 原始位 + 对象表 canonical JSON 的 sha256：逐位一致 ⇔ 哈希一致（-0 与 0 也区分）。 */
  private stateHash(bodies: ReadonlyArray<{ raw: number[] }>): string {
    const floats = new Float64Array(bodies.flatMap((entry) => entry.raw));
    return sha256Hex(canonicalJson({ tick: this.currentTick, seed: this.seed, rng: this.rng.value, objects: [...this.objects.values()] }), new Uint8Array(floats.buffer));
  }
}
