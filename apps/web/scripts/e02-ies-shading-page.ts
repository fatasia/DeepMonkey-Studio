// E02 IES 着色确定性门禁的 Web 侧宿主(设计 docs/specs/e02-ies-integration-design-2026-09-19.md §3.2/§3.3,
// 纪律同 r3-state-runtime-page):真实 ViewerEngine + 真实 StudioDeepWebGpuBridge——Deep Forward+ 是
// IES WGSL(deepSpotIesFactor)的唯一消费路径,由应用层桥激活,裸 ViewerEngine 不经过它。
// 每个用例:场景级 lightProfiles + spot userData.ies 载体 → 真实投影 projectStudioDeepLights →
// 合同帧 canonicalIesFrame(applied 侧);canonical 侧由同一冻结场景独立折叠。驱动端(scripts/
// gate-e02-ies-shading.mjs)另取截图做像素摘要与对照。IES 表进 GPU 的载体是 group-3 binding 12
// 的 storage buffer(iesShading.packIesShading),消费端吃归一化因子 candela/maxCandela。
import * as THREE from "three";
import { iesTableDigest, parseE02IesScenario, canonicalIesFrame, E02_IES_SCENARIO_SCHEMA,
  type E02IesScenario } from "../src/delivery/e02IesFrame";
import { projectStudioDeepLights } from "../src/viewer/studioDeepEnvironmentLights";
import { StudioDeepWebGpuBridge } from "../src/viewer/StudioDeepWebGpuBridge";
import { ViewerEngine } from "../src/viewer/ViewerEngine";
import { parseIesProfile } from "@bim-studio/deep-engine/lighting";
import { quantizeIesLightProfile } from "@bim-studio/deep-engine/runtime-package";

declare global {
  interface Window {
    result?: unknown;
    failure?: string;
    e02Fixtures?: Record<string, string>;
  }
}

const params = new URLSearchParams(window.location.search);
const backend = params.get("backend") === "webgl" ? "webgl" : "webgpu";
const variant = params.get("variant") ?? "baseline";
const scenarioKey = params.get("scenario") ?? "quad";

interface ScenarioSpec {
  readonly id: string;
  readonly fixture: string;
  readonly profileId: string;
  /** 聚光灯锥半角(rad)与安装高度(m):锥必须罩住 profile 的实测主光束,让 IES 主导光斑形状。 */
  readonly coneHalfAngleRad: number;
  readonly height: number;
}

// 门禁夹具常量(测试夹具,非产品令牌):白光 spot + 中灰粗糙漫反射地面。
const SPOT_INTENSITY = 40;
const GROUND_COLOR = 0x9aa3ab;
const SETTLE_FRAMES = 12;
// 门禁可加高收敛等待(?settle=,下限 12 上限 600):曝光/累积类每帧状态需要帧数收敛,
// 固定帧数等待是确定性前提(时长驱动会引入时序方差)。
const settleFrames = Math.min(Math.max(Number(params.get("settle") ?? SETTLE_FRAMES) || SETTLE_FRAMES, SETTLE_FRAMES), 600);
const SCENARIOS: Record<string, ScenarioSpec> = {
  // 真实样本(BEGA 50899.2K3 替代样本 50975.6K3,旋转对称):真实光度截止塑形光斑。
  bega: { id: "e02-ies-real-bega-20260919", fixture: "bega", profileId: "real.bega-50975-6k3",
    coneHalfAngleRad: 0.96, height: 4 },
  // 合成四瓣(对称系数 4):方位变化敏感,旋转 45° 必须改变采样与渲染。
  quad: { id: "e02-ies-syn-quad-20260919", fixture: "quad", profileId: "syn.quad-0-90",
    coneHalfAngleRad: 0.52, height: 4 },
};

function variantIes(spec: ScenarioSpec): { profileId: string; rotationDeg?: number; scaleFactor?: number } | undefined {
  if (variant === "plain") return undefined;
  const base = { profileId: spec.profileId };
  if (variant === "rot45") return { ...base, rotationDeg: 45 };
  if (variant === "scale05") return { ...base, scaleFactor: 0.5 };
  return base;
}

(async () => {
  try {
    const spec = SCENARIOS[scenarioKey];
    if (!spec) throw new Error(`unknown scenario ${scenarioKey}`);
    const fixtureText = window.e02Fixtures?.[spec.fixture];
    if (!fixtureText) throw new Error(`missing fixture text for scenario ${scenarioKey}`);
    const profile = quantizeIesLightProfile(spec.profileId, parseIesProfile(fixtureText));
    const scenario: E02IesScenario = parseE02IesScenario({
      schema: E02_IES_SCENARIO_SCHEMA, schemaVersion: 1, id: spec.id,
      lightProfiles: [JSON.parse(JSON.stringify(profile))],
      lights: [{ id: "spot-a", profileId: spec.profileId }],
      samples: { thetaDeg: [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 105, 120, 150, 180],
        phiDeg: [0, 22.5, 45, 67.5, 90, 135, 180, 270] },
    });

    const viewport = document.getElementById("viewport")!;
    const engine = await ViewerEngine.create(viewport, backend);
    // Deep 管线要求作者后处理(ACES 显示域合成)激活;AA 走设备 MSAA,关 SMAA/SSAO/Bloom 保持确定性。
    engine.setPostProcessing({ enabled: true, smaa: false, ssao: false, bloom: false });
    for (let waited = 0; !engine.usesAuthorPostProcessing(); waited += 1) {
      if (waited > 300) throw new Error("author post-processing runtime did not become ready");
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    // 几何必须进 Deep 投影根(引擎公开 API);灯光不进投影根(投影器拒绝灯类型),
    // 挂在 scene——CPU 灯光投影按 scene 遍历收集(userData.ies 载体在这里)。
    const root = engine.getDeepProjectionRoot() as THREE.Object3D;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 0.95, metallic: 0 }));
    ground.rotation.x = -Math.PI / 2;
    root.add(ground);
    // 有限距离是 Deep 局部光合同(无限距离拒绝);25m 远大于安装高度,衰减窗不截断光斑。
    // penumbra 必须大于 0(锥合同要求 outer < inner),小半影保持 IES 主导光斑形状。
    const spot = new THREE.SpotLight(0xffffff, SPOT_INTENSITY, 25, spec.coneHalfAngleRad, 0.05, 2);
    spot.position.set(0, spec.height, 0);
    spot.target.position.set(0, 0, 0);
    const ies = variantIes(spec);
    if (ies) spot.userData.ies = ies;
    engine.scene.add(spot, spot.target);
    (engine.scene.userData as Record<string, unknown>).lightProfiles = scenario.lightProfiles;
    engine.camera.position.set(3.6, 2.8, 3.6);
    engine.camera.lookAt(0, 0.5, 0);
    engine.camera.updateMatrixWorld(true);
    engine.setContinuousRender("e02-ies-shading", true);

    // Deep Forward+ 桥:webgpu 准备完成后真实替换画布;webgl 发布 three.js 画布(IES 无消费路径,
    // 状态投影仍经同一条 projectStudioDeepLights,用于记录架构边界)。
    const bridge = new StudioDeepWebGpuBridge(engine, viewport, { onRuntimeFailure: () => undefined });
    const switched = await bridge.switchTo(backend);
    if (switched.status === "failed" || switched.status === "cancelled") {
      throw new Error(`bridge switch to ${backend} failed: ${switched.error ?? switched.status}`);
    }

    let frames = 0;
    const unsubscribe = engine.subscribePresentationFrames(() => {
      frames += 1;
      if (frames < settleFrames) return;
      unsubscribe();
      try {
        // 阴影关闭:消除阴影图噪声,IES 调制是唯一光学变量。
        const projection = projectStudioDeepLights(engine.scene, engine.camera.layers.mask, false);
        const projected = projection.lights.spots?.[0];
        if (!projected) throw new Error("projected scene has no spot light");
        // applied 侧(真实引擎投影的 ies 载体)与 canonical 侧(冻结场景独立折叠)由驱动端
        // 逐字节对比:baseline 必须 frame===canonicalFrame;rot45/scale05 必须不同。
        const frame = projected.ies === undefined ? null
          : canonicalIesFrame(scenario, [{ id: scenario.lights[0]!.id, ies: projected.ies }]);
        const canonicalFrame = canonicalIesFrame(scenario,
          scenario.lights.map(light => ({ id: light.id, ies: {
            profileId: light.profileId,
            ...(light.rotationDeg === undefined ? {} : { rotationDeg: light.rotationDeg }),
            ...(light.scaleFactor === undefined ? {} : { scaleFactor: light.scaleFactor }),
          } })));
        window.result = {
          backend: switched.activeBackend, variant, scenario: scenario.id, frames,
          frame, canonicalFrame, tableDigest: iesTableDigest(scenario.lightProfiles),
          issues: projection.issues,
          projectedIes: projected.ies ?? null,
          lightProfilesCarried: (projection.lights as { lightProfiles?: unknown }).lightProfiles !== undefined,
          projectedSpot: { innerConeCos: projected.innerConeCos, outerConeCos: projected.outerConeCos,
            directionWorld: projected.directionWorld },
        };
      } catch (error) {
        window.failure = String(error);
      }
    });
  } catch (error) {
    window.failure = String(error);
  }
})();
