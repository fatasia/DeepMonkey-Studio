import { expect, it, vi } from 'vitest';
import { fullFixture } from '../controllers/sceneRendererRecoveryFullDomainFixture.testUtils';
import { restoreRendererRecoveryState } from '../controllers/restoreRendererRecoveryState';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const recover = (f: ReturnType<typeof fullFixture>, scene = f.persistence.makeSnapshot()!) =>
  restoreRendererRecoveryState({ scene, readOnly: false }, f.context.project!, f.persistence.applyScene);

it('capture stays unavailable until the actual asynchronous controller finishes all models', async () => {
  const f = fullFixture(), captured = f.persistence.makeSnapshot()!, gate = deferred();
  const load = vi.mocked(f.context.loadModel).getMockImplementation()!;
  vi.mocked(f.context.loadModel).mockImplementationOnce(async (...args) => { await gate.promise; return load(...args); });
  const pending = recover(f, captured);
  expect(f.readiness.ready(captured.id, false, false)).toBe(false);
  expect(f.persistence.makeSnapshot()).toBeUndefined();
  gate.resolve(); await pending;
  expect(f.readiness.ready(captured.id, false, false)).toBe(true);
  expect(f.persistence.makeSnapshot()).toBeDefined();
});

it('a superseded model completion cannot publish its old scene or finish the newer generation', async () => {
  const f = fullFixture(), oldScene = f.persistence.makeSnapshot()!, gate = deferred();
  const load = vi.mocked(f.context.loadModel).getMockImplementation()!;
  vi.mocked(f.context.loadModel).mockImplementationOnce(async (...args) => { await gate.promise; return load(...args); });
  const oldRestore = recover(f, oldScene);
  const rejected = expect(oldRestore).rejects.toThrow(/替换|中断/);
  const nextScene = { ...structuredClone(oldScene), id: 'newer-scene', name: '新场景' };
  await recover(f, nextScene);
  gate.resolve(); await rejected;
  expect(f.ui.setActiveScene).toBe(nextScene); expect(f.ui.setSceneName).toBe('新场景');
  expect(f.readiness.ready(nextScene.id, false, false)).toBe(true);
  expect(f.readiness.ready(oldScene.id, false, false)).toBe(false);
  expect(f.persistence.makeSnapshot()).toBeUndefined(); // this old controller still captures its old scene id
});

it('a new engine restore generation rejects an old completion even without a controller version change', async () => {
  const f = fullFixture(), captured = f.persistence.makeSnapshot()!, gate = deferred();
  const load = vi.mocked(f.context.loadModel).getMockImplementation()!;
  vi.mocked(f.context.loadModel).mockImplementationOnce(async (...args) => { await gate.promise; return load(...args); });
  const pending = recover(f, captured), rejected = expect(pending).rejects.toThrow(/尚未完整恢复/);
  const nextGeneration = f.readiness.begin('replacement');
  gate.resolve(); await rejected;
  expect(f.ui.setActiveScene).toBeUndefined(); expect(f.readiness.ready('replacement', false, false)).toBe(false);
  f.readiness.complete(nextGeneration);
  expect(f.readiness.ready('replacement', false, false)).toBe(true);
});

it('a loader resolving without a live model fails closed and leaves capture blocked', async () => {
  const f = fullFixture(), captured = f.persistence.makeSnapshot()!;
  vi.mocked(f.context.loadModel).mockResolvedValue(undefined);
  await expect(recover(f, captured)).rejects.toThrow(/未能载入/);
  expect(f.persistence.makeSnapshot()).toBeUndefined(); expect(f.ui.setActiveScene).toBeUndefined();
});
