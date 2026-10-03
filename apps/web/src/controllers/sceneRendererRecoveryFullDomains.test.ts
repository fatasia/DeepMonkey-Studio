import { afterEach, expect, it, vi } from 'vitest';
import { fullFixture } from '../controllers/sceneRendererRecoveryFullDomainFixture.testUtils';
import { restoreRendererRecoveryState } from '../controllers/restoreRendererRecoveryState';
import { migrateSceneSnapshotV1, validateScene } from '@bim-studio/contracts';

afterEach(() => vi.unstubAllGlobals());
const recover = (f: ReturnType<typeof fullFixture>, scene = f.persistence.makeSnapshot()!) =>
  restoreRendererRecoveryState({ scene, readOnly: false, animationPlayheadSec: 12.5 }, f.context.project!, f.persistence.applyScene);

it('13 snapshot domains use the actual capture/controller/readiness path with non-default author inputs', async () => {
  const f = fullFixture(), captured = f.persistence.makeSnapshot()!;
  expect(() => validateScene(migrateSceneSnapshotV1(captured).scenes[0], '$.scene')).not.toThrow();
  expect(captured.models).toHaveLength(1); expect(captured.primitives).toHaveLength(1);
  expect(captured.models[0]).toMatchObject({ modelId: 'pump-instance', assetModelId: 'pump-asset',
    name: '泵', visible: false, opacity: .45, locked: true, transform: f.transform, material: f.material,
    animationPlayback: { autoplay: false, loopMode: 'once' }, layers: [{ nodeId: 'shell', visible: false }] });
  expect(captured.primitives[0]).toMatchObject(f.primitive);
  expect(captured.camera.position.x).toBe(12); expect(captured.environment?.environmentSpecularMips).toBe(4);
  await recover(f, captured);
  expect(f.readiness.ready(captured.id, false, false)).toBe(true);
  expect(f.engine.getCameraState()).toEqual(captured.camera);
  expect(f.ui.setNavigationMode).toBe('thirdPerson'); expect(f.ui.setAvatarVisible).toBe(true);
  expect(f.ui.setCameraViews).toEqual(captured.cameraViews); expect(f.ui.setDefaultCameraViewId).toEqual(captured.defaultCameraViewId);
  expect(f.engine.setCameraConstraints).toHaveBeenCalledWith(captured.cameraConstraints);
  expect(f.engine.setNavigationSettings).toHaveBeenCalledWith(expect.objectContaining(captured.navigationSettings!));
  expect(f.engine.applyModelState).toHaveBeenCalledWith('pump-instance', captured.models[0]);
  expect(f.engine.createPrimitive).toHaveBeenCalledWith('marker', '标记', 'box', '#11aa77');
  expect(f.engine.applyModelState).toHaveBeenCalledWith('marker', captured.primitives[0]);
  expect(f.engine.selectLayer).toHaveBeenCalledWith('pump-instance', 'shell');
  expect(f.engine.addMeasurementVisual).toHaveBeenCalledWith(captured.measurements[0]);
  expect(f.engine.addAnnotation).toHaveBeenCalledWith(captured.annotations![0]);
  expect(f.ui.setMeasurements).toEqual(captured.measurements); expect(f.ui.setAnnotations).toEqual(captured.annotations);
  expect(f.engine.setWeather).toHaveBeenCalledWith('rain');
  expect(f.engine.setGlobalLighting).toHaveBeenCalledWith(expect.objectContaining({ lights: captured.lighting!.lights }));
  expect(f.mips()).toBe(4); expect(f.ui.setSceneEnvironment).toEqual(captured.environment);
  expect(f.engine.applyFloorStates).toHaveBeenCalledWith(captured.floors);
  expect(f.engine.setPostProcessing).toHaveBeenCalledWith(expect.objectContaining(captured.postProcessing!));
  expect(f.engine.setPhysicsState).toHaveBeenCalledWith(expect.objectContaining(captured.physics!));
  expect(f.engine.setClipping).toHaveBeenCalledWith(captured.clipping);
  expect(f.ui.setSceneCoordinates).toEqual(captured.coordinateSystem);
  expect(f.engine.setSceneAnimation).toHaveBeenCalledWith(captured.animation); expect(f.ui.setSceneAnimation).toEqual(captured.animation);
  expect(f.animationTime()).toBe(12.5); expect(f.ui.setAnimationTime).toBe(12.5);
  expect(f.ui.setSceneInteractions).toEqual(captured.interactions); expect(f.engine.setInteractionScripts).toHaveBeenCalledWith(captured.interactions);
  expect(f.ui.setSceneDataBindings).toEqual(captured.dataBindings); expect(f.ui.setSceneAssetBindings).toEqual(captured.assetBindings);
  expect(f.ui.setSelectionSets).toEqual(captured.selectionSets); expect(f.ui.setRootLayerOrder).toEqual(captured.rootLayerOrder);
  expect(f.ui.setSceneDashboard).toEqual(captured.dashboard); expect(f.ui.setEngineeringAnalysis).toEqual(captured.engineeringAnalysis);
  expect(f.ui.setSceneName).toBe('作者现场'); expect((f.ui.setActiveScene as typeof captured).projectId).toBe(f.context.project!.id);
  expect(f.ui.setActiveScene).toMatchObject({ thumbnail: 'data:image/jpeg;base64,previous', publicationToolbarVisible: false,
    publicationMode: 'webgl', publicationPerformance: 'standard', publishedAt: '2026-10-01T01:00:00Z', simulationEntities: captured.simulationEntities });
});

it.each(['model', 'layer', 'annotation'] as const)('selection priority reaches the real %s restore branch', async kind => {
  const f = fullFixture();
  if (kind === 'model') f.context.selectedLayerId = undefined;
  if (kind === 'annotation') f.context.selectedAnnotationId = 'note';
  const captured = f.persistence.makeSnapshot()!; await recover(f, captured);
  if (kind === 'annotation') { expect(f.engine.selectAnnotation).toHaveBeenCalledWith('note'); expect(f.engine.selectLayer).not.toHaveBeenCalled(); }
  else if (kind === 'layer') expect(f.engine.selectLayer).toHaveBeenCalledWith('pump-instance', 'shell');
  else expect(f.engine.select).toHaveBeenCalledWith('pump-instance');
});

it('exempt organization selection and transient binding cache reset rather than claim restoration', async () => {
  const f = fullFixture(); await recover(f);
  expect(f.ui.setSelectedSpace).toBeUndefined(); expect(f.ui.setSceneOrganizationSelection).toEqual(new Set());
  expect(f.ui.setSceneDataBindingRuntime).toEqual({});
});
