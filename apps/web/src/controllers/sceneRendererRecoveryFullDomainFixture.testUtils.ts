import { vi } from 'vitest';
import { fixture } from '../controllers/sceneRendererRecoveryDomainFixture.testUtils';
import { createScenePersistenceController } from '../controllers/scenePersistenceController';
import { normalizeInteractionScripts } from '../interactionState';
import { normalizeSceneDataBindings } from '../sceneDataBindings';
import { normalizeDashboardState } from '../components/dashboardState';
import { normalizeSceneEngineeringAnalysis } from '../viewer/engineeringAnalysisState';
import { DEFAULT_NAVIGATION_SETTINGS } from '../navigationSettings';
import type { SceneMaterialState } from '@bim-studio/contracts';

export function fullFixture() {
  const f = fixture(), context = f.context;
  const readConstraints = f.engine.getCameraConstraints, readLighting = f.engine.getGlobalLighting, readPostFx = f.engine.getPostProcessing;
  f.engine.applyCamera({ ...f.engine.getCameraState(), mode: 'thirdPerson', avatarVisible: true });
  const transform = { position: { x: 1, y: 2, z: 3 }, rotation: { x: .1, y: .2, z: .3 }, scale: { x: 2, y: 3, z: 4 } };
  const material: SceneMaterialState = { color: '#abc123', roughness: .23, metalness: .7, ior: 1.62,
    slotOverrides: { 'gltf:1': { color: '#11aa77', roughness: .3, metalness: .1, ior: 1.3 } } };
  const primitive = { modelId: 'marker', name: '标记', kind: 'box', color: '#11aa77', visible: true, opacity: .8, transform };
  const authored = { id: 'pump-instance', assetModelId: 'pump-asset', kind: 'model', name: '泵', visible: false, opacity: .45 };
  const models = new Map<string, Omit<typeof authored, 'assetModelId'> & { assetModelId?: string }>([
    [authored.id, authored], [primitive.modelId, { id: primitive.modelId, kind: 'primitive', name: primitive.name, visible: true, opacity: .8 }]]);
  const annotations = [{ id: 'note', name: '检修', position: { x: 1, y: 2, z: 3 }, color: '#11aa77', visible: true, locked: true }];
  const engine = Object.assign(f.engine, {
    listModels: () => [...models.values()],
    clearSceneModels: vi.fn(() => { models.clear(); annotations.length = 0; }),
    removeModel: vi.fn((id: string) => models.delete(id)),
    createPrimitive: vi.fn((id: string, name: string) => { models.set(id, { id, name, kind: 'primitive', visible: true, opacity: 1 }); }),
    primitiveState: () => structuredClone(primitive),
    getModelTransform: () => structuredClone(transform),
    getModelMaterialOverride: () => structuredClone(material), getModelColorOverride: () => '#abc123',
    getModelRigState: () => undefined, getIndustrialPrefabState: () => undefined,
    getSpatialAudioState: () => undefined, getRobotPose: () => undefined,
    isModelLocked: () => true, getModelEffects: () => ({ outline: true, glow: false, xray: false, scanline: false,
      heatmap: false, dissolve: .2, edgeLight: false, color: '#abcdef', intensity: 1.2 }),
    getPhysicsBodyState: () => ({ type: 'kinematic', mass: 2, friction: .3, restitution: .1 }),
    isCollisionEnabled: () => true, getExplosionFactor: () => .4, getExplosionMode: () => 'x',
    hasAnimation: () => true, isAnimationEnabled: () => false,
    getModelAnimationPlaybackState: () => ({ autoplay: false, loopMode: 'once' }),
    getLayerStates: () => [{ nodeId: 'shell', visible: false, opacity: .4, color: '#abcdef' }],
    listAnnotations: () => structuredClone(annotations),
    addAnnotation: vi.fn((value: typeof annotations[number]) => annotations.push(structuredClone(value))),
    getCameraConstraints: () => ({ ...readConstraints(), maxDistance: 140, collisionEnabled: true }),
    getNavigationSettings: () => ({ ...DEFAULT_NAVIGATION_SETTINGS, walkSpeed: 4, flySpeed: 12, sprintMultiplier: 3, eyeHeight: 1.8 }),
    getWeather: () => 'rain',
    getGlobalLighting: () => ({ ...readLighting(), lights: [{ id: 'user-point', type: 'point', name: '设备灯', enabled: true, color: '#abcdef', intensity: 7, position: { x: 2, y: 5, z: 1 }, target: { x: 0, y: 0, z: 0 }, castShadow: true }] }),
    getFloorStates: () => [{ modelId: 'pump-instance', level: '二层', visible: false, expansion: 1.4 }],
    getPostProcessing: () => ({ ...readPostFx(), bloomStrength: .75, vignetteDarkness: .3 }),
    getPhysicsState: () => ({ enabled: true, playing: false, gravity: { x: 0, y: -3, z: 0 } }),
    getClippingState: () => ({ enabled: true, axis: 'z', offset: 1.25, inverted: true }),
    getSceneAnimation: () => ({ duration: 30, loop: false, playbackSpeed: .5, pingPong: true,
      playbackRange: { inPoint: 2, outPoint: 20 }, camera: [{ id: 'camera-key', time: 2, camera: { ...f.scene.camera } }], models: [] }),
  });
  context.project!.models.push({ id: 'pump-asset', name: 'pump.glb', format: 'glb', status: 'ready' } as never);
  vi.mocked(context.loadModel).mockImplementation(async (_record, _silent, id) => {
    models.set(id!, { ...authored, id: id! }); return undefined;
  });
  context.sceneName = '  作者现场  ';
  context.cameraViews[0]!.createdAt = '2026-10-01T00:00:00Z';
  context.selected = authored as never; context.selectedLayerId = 'shell';
  context.measurements = [{ id: 'measure', start: { x: 1, y: 0, z: 0 }, end: { x: 4, y: 0, z: 0 }, distance: 3 }];
  context.sceneCoordinates = { unit: 'mm', upAxis: 'z', handedness: 'left', origin: { x: 20, y: 30, z: 40 }, epsg: 'EPSG:4547' };
  context.sceneInteractions = normalizeInteractionScripts([{ id: 'click', name: '点击泵', enabled: true,
    target: { kind: 'object', modelId: authored.id }, trigger: 'click', code: 'ctx.target.object.visible=false' }]);
  context.sceneDataBindings = normalizeSceneDataBindings([{ id: 'binding', name: '透明度', enabled: true,
    pipelineId: 'pump-pipeline', field: 'opacity', target: { modelId: authored.id }, action: 'opacity', refreshSeconds: 5 }]);
  context.sceneAssetBindings = [{ id: 'asset', sceneObjectId: authored.id, objectName: '泵', modelId: authored.id,
    deviceId: 'device-pump', confidence: .95, confirmedAt: '2026-10-01T00:00:00Z' }];
  context.sceneDashboard = normalizeDashboardState({ side: 'left', width: 500, widgets: [{ id: 'kpi', name: '压力', type: 'value', unit: 'MPa' }] });
  context.engineeringAnalysis = normalizeSceneEngineeringAnalysis({ minimumClearance: .8, heightLimit: 6.5,
    qtoMappings: [{ id: 'steel', enabled: true, source: 'material-name', pattern: 'steel', category: '钢结构' }] });
  Object.assign(context.activeScene!, { thumbnail: 'data:image/jpeg;base64,previous', publicationToolbarVisible: false,
    publishedAt: '2026-10-01T01:00:00Z', publicationMode: 'webgl', publicationPerformance: 'standard',
    simulationEntities: [{ id: 'path', kind: 'path', name: '送料', targetModelId: authored.id, points: [[0,0,0],[3,0,0]], speed: 1, loopMode: 'once' }] });
  context.primitiveColors.current.set('marker', primitive.color);
  // The real controller closes over the authored context, just as App rebuilds it per render.
  const persistence = createScenePersistenceController(context);
  return { ...f, engine, persistence, models, material, transform, primitive, authored };
}
