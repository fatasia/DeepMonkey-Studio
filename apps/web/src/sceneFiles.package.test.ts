import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord, SceneSnapshot } from "@bim-studio/contracts";
import pureScene from "../../../test-fixtures/scene-v1-pure-3d.json";
import { exportScenePackage, readSceneFile } from "./sceneFiles";

const io = vi.hoisted(() => ({ download: vi.fn(), load: vi.fn() }));
vi.mock("./browserDownload.js", () => ({ downloadBlob: io.download }));
vi.mock("./viewer/viewerAssetTransport.js", () => ({ loadViewerAssetBuffer: io.load }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("packages one shared robot resource and keeps both instance poses and the selected URDF entry", async () => {
  vi.stubGlobal("window", { location: { origin: "http://localhost" } });
  const source = await new JSZip().file("first.urdf", "first").file("robot/active.urdf", "chosen").generateAsync({ type: "arraybuffer" });
  io.load.mockResolvedValue(source);
  const transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  const scene = { ...pureScene, models: [0.1, 0.9].map((value, index) => ({ modelId: `instance-${index}`, assetModelId: "robot-asset", name: "Robot", visible: true, opacity: 1, transform, robotPose: { hinge: value } })) } as SceneSnapshot;
  const model = { id: "robot-asset", name: "Robot.zip", format: "zip", status: "ready", manifest: { geometryUrl: "/assets/robot.zip", robot: { entryPath: "robot/active.urdf" } } } as ModelRecord;
  await exportScenePackage(scene, [model]);
  expect(io.load).toHaveBeenCalledOnce();
  const [blob, filename] = io.download.mock.calls[0]!;
  const restored = await readSceneFile(new File([blob], filename));
  expect(restored.assets).toHaveLength(1);
  expect(restored.assets[0]).toMatchObject({ originalModelId: "robot-asset", robotEntryPath: "robot/active.urdf" });
  expect(await restored.assets[0]!.file.arrayBuffer()).toEqual(source);
  expect(restored.scene.models).toEqual(scene.models);
});
