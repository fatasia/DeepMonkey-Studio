import { vi } from 'vitest';
import * as THREE from 'three';
import type { SceneSnapshot } from '@bim-studio/contracts';
import { createScenePersistenceController } from './scenePersistenceController';
import type { ScenePersistenceControllerContext } from './scenePersistenceControllerContext';
import { ViewerSnapshotReadiness } from '../viewer/viewerSnapshotReadiness';
import { setStudioDeepEnvironmentMips, readStudioDeepEnvironmentMips } from '../viewer/studioDeepEnvironmentMips';
import { DEFAULT_ANIMATION, DEFAULT_CAMERA_CONSTRAINTS, DEFAULT_CLIPPING, DEFAULT_ENVIRONMENT,
  DEFAULT_LIGHTING, DEFAULT_PHYSICS, DEFAULT_POST_PROCESSING } from '../appDefaults';
import source from '../../../../test-fixtures/scene-v1-pure-3d.json';

export function fixture() {
  const scene = structuredClone(source) as SceneSnapshot;
  const carrier = new THREE.Scene(), readiness = new ViewerSnapshotReadiness();
  readiness.complete(readiness.begin(scene.id));
  let liveCamera = { ...structuredClone(scene.camera), position: { x: 12, y: 7, z: -2 } };
  let environment = { ...DEFAULT_ENVIRONMENT, environmentSpecularMips: 4 };
  setStudioDeepEnvironmentMips(carrier, environment.environmentSpecularMips);
  let animationTime = 12.5;
  const cameraViews = [{ id: 'entry-view', name: '默认视图', camera: structuredClone(scene.camera) }];
  const ui: Record<string, unknown> = {};
  const engine = {
    scene: carrier,
    getAuthorRendererBackend: () => 'webgl',
    getRendererBackend: () => 'webgl',
    isSceneSnapshotReady: (id: string) => readiness.ready(id, false, false),
    hasRestoredSceneSnapshot: (id: string) => readiness.ready(id, false, false),
    beginSceneSnapshotRestore: (id: string) => readiness.begin(id),
    completeSceneSnapshotRestore: (generation: number) => readiness.complete(generation),
    getCameraState: () => structuredClone(liveCamera),
    applyCamera: vi.fn((camera: typeof liveCamera) => { liveCamera = structuredClone(camera); }),
    getSceneEnvironment: () => structuredClone(environment),
    setSceneEnvironment: vi.fn((value: typeof environment) => {
      environment = structuredClone(value); setStudioDeepEnvironmentMips(carrier, value.environmentSpecularMips);
    }),
    getCameraConstraints: () => DEFAULT_CAMERA_CONSTRAINTS,
    getNavigationSettings: () => undefined,
    getClippingState: () => DEFAULT_CLIPPING,
    getWeather: () => 'sunny', getGlobalLighting: () => DEFAULT_LIGHTING,
    getFloorStates: () => [], getPostProcessing: () => DEFAULT_POST_PROCESSING,
    getPhysicsState: () => DEFAULT_PHYSICS, getSceneAnimation: () => DEFAULT_ANIMATION,
    listModels: () => [], listAnnotations: () => [], clearSceneModels: vi.fn(),
    transientChannels: { channel: () => ({ snapshot: () => ({ time: animationTime, playing: false }) }) },
    seekSceneAnimation: vi.fn((time: number) => { animationTime = time; }),
    setReadOnly: vi.fn(), setFastRuntime: vi.fn(), setInteractionScripts: vi.fn(),
    clearMeasurements: vi.fn(), addMeasurementVisual: vi.fn(), addAnnotation: vi.fn(),
    setCameraConstraints: vi.fn(), setNavigationSettings: vi.fn(), setWeather: vi.fn(),
    setGlobalLighting: vi.fn(), applyFloorStates: vi.fn(), setPostProcessing: vi.fn(),
    setPhysicsState: vi.fn(), setSceneAnimation: vi.fn(), setClipping: vi.fn(),
    select: vi.fn(), selectAnnotation: vi.fn(), selectLayer: vi.fn(), requestRender: vi.fn(),
    applyModelState: vi.fn(), rename: vi.fn(),
  };
  const context = {
    engine, project: { id: scene.projectId, models: [] }, activeScene: scene,
    sceneName: scene.name, route: { view: 'studio', projectId: scene.projectId, sceneId: scene.id },
    getActiveScene: () => scene, locale: 'zh-CN', cameraViews, defaultCameraViewId: 'entry-view',
    sceneCoordinates: undefined, measurements: [], sceneDashboard: {}, engineeringAnalysis: undefined,
    sceneDataBindings: [], sceneAssetBindings: [], sceneInteractions: [],
    selectionSets: [{ id: 'selection', name: '作者目录', objectIds: ['model-b', 'model-a'] }],
    rootLayerOrder: [{ kind: 'object', id: 'model-b' }, { kind: 'group', id: 'selection' }],
    selected: undefined, selectedLayerId: undefined, selectedAnnotationId: undefined,
    primitiveColors: { current: new Map() }, configuredDefaultEnvironment: DEFAULT_ENVIRONMENT,
    sceneApplyVersionRef: { current: 1 }, lastAutoSavedSceneRevisionRef: { current: 0 },
    webGpuSceneReplacementCountRef: { current: 0 }, navigate: vi.fn(), showError: vi.fn(),
    loadModel: vi.fn(async () => undefined), isModelLoadSuperseded: () => false,
  } as unknown as ScenePersistenceControllerContext;
  for (const name of [
    'setSceneInteractions', 'setSceneDataBindings', 'setSceneAssetBindings', 'setSceneDataBindingRuntime',
    'setSelected', 'setMeasurements', 'setAnnotations', 'setSelectedAnnotationId', 'setSelectedLightId',
    'setSelectedSpace', 'setSceneOrganizationSelection', 'setSelectionSets', 'setRootLayerOrder',
    'setLastDeletedSelectionSet', 'setCameraConstraints', 'setNavigationSettings', 'setCameraViews',
    'setDefaultCameraViewId', 'setWeather', 'setLighting', 'setSceneEnvironment', 'setSceneCoordinates',
    'setSceneAnimation', 'setPostProcessing', 'setPhysics', 'setSceneDashboard', 'setEngineeringAnalysis',
    'setAnimationTime', 'setAnimationPlaying', 'setClippingState', 'setNavigationMode', 'setAvatarVisible',
    'setViewerLoadState', 'setSceneName', 'setMessage', 'setBusy', 'setActiveScene', 'setRevision',
  ]) (context as unknown as Record<string, unknown>)[name] = vi.fn((value: unknown) => { ui[name] = value; });
  const persistence = createScenePersistenceController(context);
  return { engine, context, persistence, readiness, ui, scene, carrier,
    animationTime: () => animationTime, mips: () => readStudioDeepEnvironmentMips(carrier) };
}
