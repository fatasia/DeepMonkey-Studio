import { expect, it, vi } from 'vitest';
import { ViewerEngineSimulation } from '../viewer/viewerEngineSimulation';
import { fullFixture } from '../controllers/sceneRendererRecoveryFullDomainFixture.testUtils';
import { createScenePersistenceController } from '../controllers/scenePersistenceController';
import { restoreRendererRecoveryState } from '../controllers/restoreRendererRecoveryState';

function animationHost() {
  return Object.assign(Object.create(ViewerEngineSimulation.prototype), {
    sceneAnimation: { duration: 30, loop: false, camera: [], models: [] }, sceneAnimationTime: 12.5, sceneAnimationPlaying: false,
    updateCameraPathHelper: vi.fn(), applySceneAnimationFrame: vi.fn(), onAnimationChange: vi.fn(),
  });
}

it('actual ViewerEngine set/get animation retains the authored state machine and autoplay through capture and restore', async () => {
  const f = fullFixture(), host = Object.assign(Object.create(ViewerEngineSimulation.prototype), {
    sceneAnimation: f.engine.getSceneAnimation(), sceneAnimationTime: 12.5, sceneAnimationPlaying: false,
    updateCameraPathHelper: vi.fn(), applySceneAnimationFrame: vi.fn(), onAnimationChange: vi.fn(),
  });
  const policy = { ...host.sceneAnimation, autoplay: false, stateMachine: { enabled: true, initialStateId: 'idle',
    activeStateId: 'work', transitionDuration: .25, states: [
      { id: 'idle', name: '空闲', modelId: 'pump-instance', clipId: 'Idle', loop: true },
      { id: 'work', name: '工作', modelId: 'pump-instance', clipId: 'Work', loop: false }],
    parameters: { advance: true }, transitions: [{ id: 'edge', fromStateId: 'idle', toStateId: 'work', parameter: 'advance', equals: true }] } };
  host.setSceneAnimation(policy);
  Object.assign(f.engine, { getSceneAnimation: () => host.getSceneAnimation(),
    setSceneAnimation: (value: typeof policy) => host.setSceneAnimation(value),
    seekSceneAnimation: (time: number) => host.seekSceneAnimation(time),
    transientChannels: { channel: () => ({ snapshot: () => ({ time: host.sceneAnimationTime, playing: false }) }) } });
  const persistence = createScenePersistenceController(f.context), captured = persistence.makeSnapshot()!;
  expect(captured.animation?.stateMachine).toEqual(policy.stateMachine);
  expect(captured.animation?.autoplay).toBe(false);
  await restoreRendererRecoveryState({ scene: captured, readOnly: false, animationPlayheadSec: 12.5 }, f.context.project!, persistence.applyScene);
  expect(host.getSceneAnimation().stateMachine).toEqual(policy.stateMachine);
  expect(host.getSceneAnimation().autoplay).toBe(false);
});

it.each([undefined, false, true])('actual animation setter preserves autoplay=%s without making playback active', autoplay => {
  const host = animationHost();
  host.setSceneAnimation({ ...host.sceneAnimation, ...(autoplay !== undefined ? { autoplay } : {}) });
  expect(host.getSceneAnimation().autoplay).toBe(autoplay);
  expect(Object.hasOwn(host.getSceneAnimation(), 'autoplay')).toBe(autoplay !== undefined);
  expect(host.sceneAnimationPlaying).toBe(false);
});

it('state-machine metadata is isolated from caller and getter mutation and is removed by a later missing policy', () => {
  const host = animationHost(), machine = { enabled: true, initialStateId: 'idle', activeStateId: 'idle', transitionDuration: .5,
    states: [{ id: 'idle', name: 'Idle', modelId: 'pump-instance', clipId: 'Idle', loop: true }], parameters: { advance: false } };
  host.setSceneAnimation({ ...host.sceneAnimation, stateMachine: machine });
  machine.parameters.advance = true;
  expect(host.getSceneAnimation().stateMachine.parameters.advance).toBe(false);
  const copy = host.getSceneAnimation(); copy.stateMachine.states[0].name = 'edited';
  expect(host.getSceneAnimation().stateMachine.states[0].name).toBe('Idle');
  host.setSceneAnimation({ duration: 2, loop: true, camera: [], models: [] });
  expect(host.getSceneAnimation().stateMachine).toBeUndefined();
});

it('existing timeline sorting, bounds and clamp remain active alongside preserved metadata', () => {
  const host = animationHost();
  host.setSceneAnimation({ duration: 3, loop: false, autoplay: false, playbackSpeed: 99,
    playbackRange: { inPoint: 1, outPoint: 2 }, frameRate: 60, snapToFrames: true,
    camera: [{ id: 'late', time: 2 }, { id: 'early', time: 1 }], models: [] });
  expect(host.getSceneAnimation()).toMatchObject({ duration: 3, playbackSpeed: 4, frameRate: 60, snapToFrames: true,
    autoplay: false, camera: [{ id: 'early' }, { id: 'late' }] });
  expect(host.sceneAnimationTime).toBe(2);
  host.seekSceneAnimation(50); expect(host.sceneAnimationTime).toBe(2);
});
