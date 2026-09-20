// R10 跨端对照:wasm 内核(@dimforge/rapier3d-compat)跑与 Rust native 完全相同的
// 场景(spec 单一来源),本地独立产出 physics-frame-v1 规范帧与位级摘要,
// 再与 native 产物逐帧逐位比对,最后汇总写 evidence.json。
//
// 用法:
//   node run-and-compare.mjs --spec <scene-spec-v1.json> \
//     --native <native-result.json> --native-frames <frames-native.jsonl> \
//     --out <evidence-dir> [--tests-json <tests-summary.json>]
//
// 确定性纪律:无 sleep、无随机、无真实时间参与物理;dt 显式 f32(Math.fround)。

import RAPIER from "@dimforge/rapier3d-compat";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected arg: ${key}`);
    // --native-frames -> nativeFrames(驼峰归一,避免属性名带连字符)
    const camel = key
      .slice(2)
      .split("-")
      .map((part, order) => (order === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join("");
    options[camel] = argv[index + 1];
  }
  return options;
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// 与 dynamic-frame-v1 同款守卫:仅精确 ±0 归一,极小负数保持 "-0.000000"
// (Rust `{:.6}` 与 TS `toFixed(6)` 对该形态输出逐字节一致,已在证据中核验)。
function fixed6(value) {
  const normalized = value === 0 ? 0 : value;
  return normalized.toFixed(6);
}

function canonicalFrame(frame) {
  const bodies = [...frame.bodies].sort((left, right) => (left[0] < right[0] ? -1 : 1));
  const parts = bodies.map(([id, pose]) => `${id}>${pose.map(fixed6).join(",")}`);
  const joints = [...(frame.joints ?? [])].sort((left, right) => (left.id < right.id ? -1 : 1));
  const jointText = joints.length === 0
    ? ""
    : `|joints=${joints.map((joint) => `${joint.id}>${joint.kind},${joint.body1},${joint.body2}|a1=${joint.anchor1.map(fixed6).join(",")}|a2=${joint.anchor2.map(fixed6).join(",")}|f1=${joint.frame1.map(fixed6).join(",")}|f2=${joint.frame2.map(fixed6).join(",")}`).join(";")}`;
  return `physics-frame-v1|step=${frame.step}|bodies=${parts.join(";")}${jointText}`;
}

// 位级摘要:step 升序 → body 字典序 → [tx,ty,tz,qx,qy,qz,qw],逐 f32 小端 4 字节。
const bitsScratchFloat = new Float32Array(1);
const bitsScratchU32 = new Uint32Array(bitsScratchFloat.buffer);

function bitsOf(value) {
  bitsScratchFloat[0] = value;
  return bitsScratchU32[0];
}

function poseBitsBuffer(frames) {
  const chunks = [];
  for (const frame of frames) {
    const bodies = [...frame.bodies].sort((left, right) => (left[0] < right[0] ? -1 : 1));
    for (const [, pose] of bodies) {
      for (const value of pose) {
        if (!Number.isFinite(value)) throw new Error("non-finite pose component");
        if (Math.fround(value) !== value) throw new Error(`value is not an exact f32: ${value}`);
        const bits = bitsOf(value);
        chunks.push(Buffer.from([bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]));
      }
    }
  }
  return Buffer.concat(chunks);
}

function jointBitsBuffer(frames) {
  const chunks = [];
  for (const frame of frames) {
    const joints = [...(frame.joints ?? [])].sort((left, right) => (left.id < right.id ? -1 : 1));
    for (const joint of joints) {
      const step = Buffer.alloc(4);
      step.writeUInt32LE(frame.step, 0);
      chunks.push(step);
      for (const text of [joint.id, joint.kind, joint.body1, joint.body2]) {
        chunks.push(Buffer.from(text, "utf8"), Buffer.from([0]));
      }
      for (const values of [joint.anchor1, joint.anchor2, joint.frame1, joint.frame2]) {
        for (const value of values) {
          const bits = bitsOf(value);
          chunks.push(Buffer.from([bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]));
        }
      }
    }
  }
  return Buffer.concat(chunks);
}

function summarize(frames) {
  const sequence = frames.map(canonicalFrame).join("\n");
  return {
    frameSequenceSha256: sha256Hex(Buffer.from(sequence, "utf8")),
    poseBitsSha256: sha256Hex(poseBitsBuffer(frames)),
    jointBitsSha256: sha256Hex(jointBitsBuffer(frames)),
  };
}

async function runWasmScene(spec) {
  const gravity = { x: spec.gravity[0], y: spec.gravity[1], z: spec.gravity[2] };
  const world = new RAPIER.World(gravity);
  // 显式 f32:与 Rust `spec.timestep.dt as f32`(IEEE 最近偶舍入)逐位一致。
  world.timestep = Math.fround(spec.timestep.dt);
  world.numSolverIterations = 8;

  const groundBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(...spec.ground.translation)
      .setCanSleep(spec.ground.canSleep),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(...spec.ground.halfExtents)
      .setFriction(spec.ground.friction)
      .setRestitution(spec.ground.restitution),
    groundBody,
  );

  const bodies = [];
  const bodyById = new Map([["ground", groundBody]]);
  for (const bodySpec of spec.bodies) {
    const builder =
      bodySpec.bodyType === "dynamic" ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed();
    const body = world.createRigidBody(
      builder
        .setTranslation(...bodySpec.translation)
        .setLinvel(...bodySpec.linvel)
        .setCanSleep(bodySpec.canSleep),
    );
    world.createCollider(
      RAPIER.ColliderDesc.ball(bodySpec.shape.radius)
        .setFriction(spec.ground.friction)
        .setRestitution(spec.ground.restitution),
      body,
    );
    bodies.push([bodySpec.id, body]);
    bodyById.set(bodySpec.id, body);
  }

  const joints = [];
  for (const jointSpec of spec.joints ?? []) {
    if (jointSpec.kind !== "revolute") throw new Error(`unsupported joint kind: ${jointSpec.kind}`);
    const vector = ([x, y, z]) => ({ x, y, z });
    const data = RAPIER.JointData.revolute(vector(jointSpec.anchor1), vector(jointSpec.anchor2), vector(jointSpec.axis));
    const joint = world.createImpulseJoint(
      data,
      bodyById.get(jointSpec.body1),
      bodyById.get(jointSpec.body2),
      true,
    );
    const finiteF32 = (value) => typeof value === "number" && Number.isFinite(Math.fround(value));
    if (jointSpec.limits !== undefined) {
      const limits = jointSpec.limits;
      if (!Array.isArray(limits) || limits.length !== 2 || !limits.every(finiteF32) || limits[0] > limits[1]) {
        throw new Error(`joint ${jointSpec.id}: invalid limits`);
      }
      joint.setLimits(...limits.map(Math.fround));
    }
    if (jointSpec.motor !== undefined) {
      const motor = jointSpec.motor;
      const fields = ["targetPosition", "targetVelocity", "stiffness", "damping", "model"];
      if (!motor || Object.keys(motor).some((key) => !fields.includes(key)) ||
          !fields.slice(0, 4).every((key) => finiteF32(motor[key])) || motor.stiffness < 0 || motor.damping < 0 ||
          !["acceleration", "force"].includes(motor.model)) throw new Error(`joint ${jointSpec.id}: invalid motor`);
      joint.configureMotorModel(motor.model === "acceleration" ? RAPIER.MotorModel.AccelerationBased : RAPIER.MotorModel.ForceBased);
      joint.configureMotor(...fields.slice(0, 4).map((key) => Math.fround(motor[key])));
    }
    joints.push({ id: jointSpec.id, kind: jointSpec.kind, joint, body1: jointSpec.body1, body2: jointSpec.body2 });
  }

  const record = (step) => ({
    step,
    bodies: bodies.map(([id, body]) => {
      const translation = body.translation();
      const rotation = body.rotation();
      return [
        id,
        [translation.x, translation.y, translation.z, rotation.x, rotation.y, rotation.z, rotation.w],
      ];
    }),
    joints: joints.map(({ id, kind, joint, body1, body2 }) => {
      const anchor1 = joint.anchor1();
      const anchor2 = joint.anchor2();
      const frame1 = joint.frameX1();
      const frame2 = joint.frameX2();
      return {
        id,
        kind,
        body1,
        body2,
        anchor1: [anchor1.x, anchor1.y, anchor1.z],
        anchor2: [anchor2.x, anchor2.y, anchor2.z],
        frame1: [frame1.x, frame1.y, frame1.z, frame1.w],
        frame2: [frame2.x, frame2.y, frame2.z, frame2.w],
      };
    }),
  });

  const frames = [record(0)];
  for (let step = 1; step <= spec.timestep.steps; step += 1) {
    world.step();
    frames.push(record(step));
  }
  world.free();
  return frames;
}

// 从 native-result.json 的 framesRaw(f32 精确十进制)重建位摘要,
// 校验 JSON 往返没有丢失任何一位。
function summarizeNativeRaw(nativeResult) {
  const frames = nativeResult.framesRaw.map((frame) => ({
    step: frame.step,
    bodies: frame.bodies.map(([id, pose]) => [
      id,
      pose.map((value) => {
        if (Math.fround(value) !== value) throw new Error(`native framesRaw non-f32-exact value in ${id}`);
        return value;
      }),
    ]),
  }));
  return {
    poseBitsSha256: sha256Hex(poseBitsBuffer(frames)),
    jointBitsSha256: sha256Hex(jointBitsBuffer(nativeResult.framesRaw)),
  };
}

function locateBitDivergence(nativeFrames, wasmFrames) {
  for (let index = 0; index < Math.max(nativeFrames.length, wasmFrames.length); index += 1) {
    const nativeFrame = nativeFrames[index];
    const wasmFrame = wasmFrames[index];
    if (!nativeFrame || !wasmFrame) return { step: index, reason: "frame count mismatch" };
    const nativeBodies = new Map(nativeFrame.bodies);
    for (const [id, wasmPose] of wasmFrame.bodies) {
      const nativePose = nativeBodies.get(id);
      if (!nativePose) return { step: nativeFrame.step, body: id, reason: "body missing on native side" };
      for (let component = 0; component < 7; component += 1) {
        if (Math.fround(nativePose[component]) !== Math.fround(wasmPose[component])) {
          return {
            step: nativeFrame.step,
            body: id,
            component: ["tx", "ty", "tz", "qx", "qy", "qz", "qw"][component],
            native: nativePose[component],
            wasm: wasmPose[component],
            nativeBits: `0x${bitsOf(nativePose[component]).toString(16).padStart(8, "0")}`,
            wasmBits: `0x${bitsOf(wasmPose[component]).toString(16).padStart(8, "0")}`,
          };
        }
      }
    }
    const nativeJoints = new Map((nativeFrame.joints ?? []).map((joint) => [joint.id, joint]));
    for (const wasmJoint of wasmFrame.joints ?? []) {
      const nativeJoint = nativeJoints.get(wasmJoint.id);
      if (!nativeJoint) return { step: nativeFrame.step, joint: wasmJoint.id, reason: "joint missing on native side" };
      for (const field of ["kind", "body1", "body2"]) {
        if (nativeJoint[field] !== wasmJoint[field]) return { step: nativeFrame.step, joint: wasmJoint.id, field, reason: "joint identity mismatch" };
      }
      for (const field of ["anchor1", "anchor2", "frame1", "frame2"]) {
        for (let component = 0; component < nativeJoint[field].length; component += 1) {
          if (Math.fround(nativeJoint[field][component]) !== Math.fround(wasmJoint[field][component])) {
            return { step: nativeFrame.step, joint: wasmJoint.id, field, component, reason: "joint frame mismatch" };
          }
        }
      }
    }
  }
  return null;
}

const options = parseArgs(process.argv.slice(2));
const specPath = resolve(options.spec);
const nativePath = resolve(options.native);
const nativeFramesPath = resolve(options.nativeFrames);
const outDir = resolve(options.out);

const specBytes = readFileSync(specPath);
const spec = JSON.parse(specBytes.toString("utf8"));
const nativeResult = JSON.parse(readFileSync(nativePath, "utf8"));
const nativeCanonical = readFileSync(nativeFramesPath, "utf8").trim().split("\n");
if (nativeResult.spec.sha256 !== sha256Hex(specBytes)) throw new Error("native result was produced from a different scene spec");

console.log("[r10] init wasm kernel ...");
await RAPIER.init();

const wasmFramesRun1 = await runWasmScene(spec);
const wasmFramesRun2 = await runWasmScene(spec);
const wasmSummary = summarize(wasmFramesRun1);
const controlChecks = {};
for (const field of ["motor", "limits"]) {
  if (!(spec.joints ?? []).some((joint) => joint[field] !== undefined)) continue;
  const disabled = structuredClone(spec);
  for (const joint of disabled.joints) delete joint[field];
  controlChecks[`${field}ChangesMotion`] = summarize(await runWasmScene(disabled)).poseBitsSha256 !== wasmSummary.poseBitsSha256;
}

const wasmRepeatIdentical =
  summarize(wasmFramesRun2).poseBitsSha256 === wasmSummary.poseBitsSha256 &&
  summarize(wasmFramesRun2).frameSequenceSha256 === wasmSummary.frameSequenceSha256;

const nativeSummary = nativeResult.summary;
const nativeRawCheck = summarizeNativeRaw(nativeResult);

// 1) 规范帧串逐帧比对
let firstFrameMismatch = null;
for (let index = 0; index < Math.max(nativeCanonical.length, wasmFramesRun1.length); index += 1) {
  const nativeLine = nativeCanonical[index];
  const wasmLine = wasmFramesRun1[index] ? canonicalFrame(wasmFramesRun1[index]) : null;
  if (nativeLine !== wasmLine) {
    firstFrameMismatch = { step: index, nativeLine, wasmLine };
    break;
  }
}

// 2) 位级摘要与首分歧定位
const divergence = locateBitDivergence(nativeResult.framesRaw, wasmFramesRun1);

const bitwiseIdentical =
  wasmRepeatIdentical && Object.values(controlChecks).every(Boolean) &&
  firstFrameMismatch === null &&
  nativeSummary.poseBitsSha256 === wasmSummary.poseBitsSha256 &&
  nativeSummary.jointBitsSha256 === wasmSummary.jointBitsSha256 &&
  nativeSummary.frameSequenceSha256 === wasmSummary.frameSequenceSha256 &&
  divergence === null;

// 该包 exports 未暴露 ./package.json,直接按路径读取版本。
const compatVersion = JSON.parse(
  readFileSync(new URL("./node_modules/@dimforge/rapier3d-compat/package.json", import.meta.url), "utf8"),
).version;

writeFileSync(
  join(outDir, "frames-wasm.jsonl"),
  wasmFramesRun1.map((frame) => `${canonicalFrame(frame)}\n`).join(""),
);
writeFileSync(
  join(outDir, "wasm-result.json"),
  JSON.stringify(
    {
      engine: {
        name: "@dimforge/rapier3d-compat",
        version: compatVersion,
        runtime: `node ${process.version} (wasm32, IEEE754 严格语义)`,
      },
      timestep: {
        mode: "fixed",
        dtF64: spec.timestep.dt,
        dtF32Bits: `0x${bitsOf(Math.fround(spec.timestep.dt)).toString(16).padStart(8, "0")}`,
        steps: spec.timestep.steps,
        frames: wasmFramesRun1.length,
      },
      summary: wasmSummary,
      wasmRepeatIdentical,
    },
    null,
    2,
  ),
);

const evidence = {
  task: "R10 物理选型验证(Rapier 同源内核,Rust native + wasm 跨端确定性)",
  spec: {
    path: options.spec,
    sha256: sha256Hex(specBytes),
    scene: spec,
  },
  enginePair: {
    rust: {
      crate: "rapier3d",
      version: nativeResult.engine.version,
      features: nativeResult.engine.features,
      lockedParry: "0.30.2 (Cargo.lock)",
    },
    wasm: {
      package: "@dimforge/rapier3d-compat",
      version: compatVersion,
      kernelEvidence: "内嵌 wasm 二进制含 parry3d-0.30.2 符号(README.md 记录核对过程)",
    },
    sameSourceConclusion: "两侧均基于 rapier 0.35 内核(parry3d 0.30.2)——同源成立",
  },
  timestep: {
    mode: "fixed",
    dtF64: spec.timestep.dt,
    dtF32Bits: nativeResult.timestep.dtF32Bits,
    steps: spec.timestep.steps,
    framesPerRun: nativeResult.timestep.frames,
  },
  contract: {
    frameFormat: "physics-frame-v1",
    disciplineSource: "dynamic-frame-v1 (packages/deep-engine-native/src/runtime_package/dynamic_scene.rs)",
    componentOrder: ["tx", "ty", "tz", "qx", "qy", "qz", "qw"],
    hashes: {
      frameSequenceSha256: "规范帧序列(每步一行,'\\n' 连接)的 SHA-256",
      poseBitsSha256: "f32 小端位序(step 升序→body 字典序→分量序)的 SHA-256",
    },
    negativeZeroPolicy:
      "仅精确 ±0 归一;极小负数定点格式化为 -0.000000,Rust/TS 输出逐字节一致(与 dynamic-frame-v1 同语义)",
  },
  results: {
    controlChecks,
    native: {
      frameSequenceSha256: nativeSummary.frameSequenceSha256,
      poseBitsSha256: nativeSummary.poseBitsSha256,
      jointBitsSha256: nativeSummary.jointBitsSha256,
      framesRawRoundTripCheck: nativeRawCheck.poseBitsSha256 === nativeSummary.poseBitsSha256,
    },
    wasm: {
      frameSequenceSha256: wasmSummary.frameSequenceSha256,
      poseBitsSha256: wasmSummary.poseBitsSha256,
      jointBitsSha256: wasmSummary.jointBitsSha256,
      repeatRunBitwiseIdentical: wasmRepeatIdentical,
    },
    canonicalFramesIdentical: firstFrameMismatch === null,
    firstCanonicalFrameMismatch: firstFrameMismatch,
    bitwiseIdentical,
    firstBitDivergence: divergence,
  },
  tests: options.testsJson ? JSON.parse(readFileSync(resolve(options.testsJson), "utf8")) : null,
  honestNotes: [
    "判定基准是位级:poseBitsSha256 双端相等 + 规范帧串逐帧相等 + 首分歧定位器为 null,三者同时成立才记 bitwiseIdentical=true。",
    "wasm 侧为 @dimforge/rapier3d-compat 官方预编译内核;其构建特性矩阵未随包声明,若未来版本引入平台相关数学,跨端逐位可能被打破——本验证以实测哈希为准,不靠声明。",
    `当前场景 ${spec.id}: ${spec.bodies.length} 个刚体、${(spec.joints ?? []).length} 个 ImpulseJoint；控制项 ${Object.keys(controlChecks).join(",") || "无"}。不覆盖 MultibodyJoint、CCD 或产品宿主。`,
    `fixed timestep 由宿主精确驱动 step() 共 ${spec.timestep.steps} 次,不使用 Variable 步进;dt 两端显式转 f32。`,
    "evidence.json 之外的 frames-*.jsonl / *-result.json 为逐帧原始证据,可独立复算哈希。",
  ],
};

writeFileSync(join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(`[r10] wasm repeat run bitwise identical = ${wasmRepeatIdentical}`);
console.log(`[r10] bitwiseIdentical=${bitwiseIdentical}`);
console.log(`[r10] native poseBits=${nativeSummary.poseBitsSha256}`);
console.log(`[r10] wasm   poseBits=${wasmSummary.poseBitsSha256}`);
console.log(`[r10] evidence -> ${join(outDir, "evidence.json")}`);
process.exitCode = bitwiseIdentical ? 0 : 1;
