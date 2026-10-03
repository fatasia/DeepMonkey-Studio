import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './sceneRendererRecoveryDomainFixture.testUtils';
import { restoreRendererRecoveryState } from './restoreRendererRecoveryState';

afterEach(() => vi.unstubAllGlobals());

const restore = (f: ReturnType<typeof fixture>, captured: NonNullable<ReturnType<typeof f.persistence.makeSnapshot>>) =>
  restoreRendererRecoveryState({ scene: captured, readOnly: false, animationPlayheadSec: 12.5 }, f.context.project!, f.persistence.applyScene);

it('P2 camera-pose/default-view: restores the captured live pose instead of the named entry camera', async () => {
  const f = fixture(), captured = f.persistence.makeSnapshot()!;
  expect(captured.camera.position.x).toBe(12);
  await restore(f, captured);
  expect(f.engine.getCameraState()).toEqual(captured.camera);
  expect(f.ui.setCameraViews).toEqual(captured.cameraViews);
  expect(f.ui.setDefaultCameraViewId).toBe(captured.defaultCameraViewId);
});

it('P2 animation-playhead: final stable UI time matches the restored engine channel', async () => {
  const f = fixture(), captured = f.persistence.makeSnapshot()!;
  await restore(f, captured);
  expect(f.animationTime()).toBe(12.5);
  expect(f.ui.setAnimationTime).toBe(12.5);
  expect(f.ui.setAnimationPlaying).toBe(false);
});

it('P2 scene-identity/readiness: missing live model cannot resolve as a recovered scene', async () => {
  const f = fixture(), captured = f.persistence.makeSnapshot()!;
  captured.models.push({ modelId: 'missing', name: '设备', visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
  f.context.project!.models.push({ id: 'missing' } as never);
  vi.mocked(f.context.loadModel).mockRejectedValue(new Error('model download failed'));
  // This is the exact completion mode currently used by the P2 recovery consumer.
  await expect(restore(f, captured))
    .rejects.toThrow('model download failed');
  expect(f.readiness.ready(captured.id, false, false)).toBe(false);
  expect(f.ui.setActiveScene).toBeUndefined();
});

it('ordinary route restore retains the authored default-view entry and zero-replay policy', async () => {
  const f = fixture(), captured = f.persistence.makeSnapshot()!;
  await f.persistence.applyScene(captured, false, f.context.project, false, false, false, true);
  expect(f.engine.getCameraState()).toEqual(captured.cameraViews![0]!.camera);
  expect(f.animationTime()).toBe(0); expect(f.ui.setAnimationTime).toBe(0);
});

it('renderer recovery uses the actual engine-clamped time for the final UI value', async () => {
  const f = fixture(), captured = f.persistence.makeSnapshot()!;
  const seek = f.engine.seekSceneAnimation.getMockImplementation()!;
  f.engine.seekSceneAnimation.mockImplementation(time => seek(Math.min(time, 5)));
  await restore(f, captured);
  expect(f.animationTime()).toBe(5); expect(f.ui.setAnimationTime).toBe(5);
});

it('P2 environment: actual capture/apply keeps the author chain-tail carrier', async () => {
  const f = fixture(), captured = f.persistence.makeSnapshot()!;
  expect(captured.environment?.environmentSpecularMips).toBe(4);
  await f.persistence.applyScene(captured, false, f.context.project, false, false, false, true);
  expect(f.mips()).toBe(4);
  expect(f.ui.setSceneEnvironment).toEqual(captured.environment);
});

it('P2 directory: actual capture/apply retains authored group order and root row order', async () => {
  const f = fixture(), captured = f.persistence.makeSnapshot()!;
  await f.persistence.applyScene(captured, false, f.context.project, false, false, false, true);
  expect(f.ui.setSelectionSets).toEqual(captured.selectionSets);
  expect(f.ui.setRootLayerOrder).toEqual(captured.rootLayerOrder);
  expect(f.ui.setRootLayerOrder).not.toBe(captured.rootLayerOrder);
});

it.each([false, true])('strict read-only recovery waits for all models, second model failure=%s', async (failSecond) => {
  vi.stubGlobal('window', { setTimeout: vi.fn() });
  const f = fixture(), captured = f.persistence.makeSnapshot()!;
  const loaded: never[] = [];
  vi.spyOn(f.engine, 'listModels').mockImplementation(() => loaded);
  for (const id of ['first', 'second']) {
    captured.models.push({ modelId: id, name: id, visible: true, opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
    f.context.project!.models.push({ id } as never);
  }
  vi.mocked(f.context.loadModel).mockImplementation(async record => {
    if (record.id === 'second' && failSecond) throw new Error('second model failed');
    loaded.push({ id: record.id, kind: 'model' } as never);
    return undefined;
  });
  const restored = restoreRendererRecoveryState({ scene: captured, readOnly: true }, f.context.project!, f.persistence.applyScene);
  if (failSecond) {
    await expect(restored).rejects.toThrow('second model failed');
    expect(f.ui.setActiveScene).toBeUndefined();
  } else {
    await restored;
    expect(f.ui.setActiveScene).toBe(captured);
  }
  expect(f.context.loadModel).toHaveBeenCalledTimes(2);
  expect(f.readiness.ready(captured.id, false, false)).toBe(!failSecond);
  expect(f.engine.setReadOnly).toHaveBeenCalledWith(true);
});
