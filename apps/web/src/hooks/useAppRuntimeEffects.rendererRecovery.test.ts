import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixture } from '../controllers/sceneRendererRecoveryDomainFixture.testUtils';
import { useAppRuntimeEffects } from './useAppRuntimeEffects';
const harness = vi.hoisted(() => ({ effect: undefined as (() => void) | undefined }));
vi.mock('react', () => ({
  startTransition: (run: () => void) => run(), useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => void, deps: unknown[]) => {
    if (deps.length === 1 && typeof (deps[0] as { getRendererBackend?: unknown } | undefined)?.getRendererBackend === 'function') harness.effect = effect;
  },
}));
vi.mock('./useAppInteractionEffects', () => ({ useAppInteractionEffects: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { harness.effect = undefined; vi.stubGlobal('window', { localStorage: { setItem: vi.fn() } }); });
it('the actual recovery effect reports model-load failure and retains the captured snapshot for retry', async () => {
  const f = fixture(), captured = f.persistence.makeSnapshot()!;
  captured.models.push({ modelId: 'missing', name: '设备', visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
  f.context.project!.models.push({ id: 'missing' } as never);
  vi.mocked(f.context.loadModel).mockRejectedValue(new Error('model download failed'));
  const pending = { scene: captured, readOnly: false, animationPlayheadSec: 12.5 };
  const state = { engine: f.engine, project: f.context.project, route: { view: 'studio' }, applicationState: { variables: {} },
    rendererSnapshotRef: { current: pending }, applyScene: f.persistence.applyScene,
    rendererPreferenceCommitRef: { current: 'webgl' }, rendererBackend: 'webgl', rendererActiveBackend: 'webgl',
    setMessage: vi.fn(), setRendererActiveBackend: vi.fn(), setRendererSwitchPhase: vi.fn(),
    setRendererSwitchMessage: vi.fn(), setRendererSwitching: vi.fn(), showError: vi.fn(),
  };
  useAppRuntimeEffects(state as unknown as Parameters<typeof useAppRuntimeEffects>[0]);
  expect(harness.effect).toBeDefined(); harness.effect!();
  await vi.waitFor(() => expect(state.setRendererSwitching).toHaveBeenCalledWith(false));
  expect(state.setRendererSwitchPhase).toHaveBeenLastCalledWith('failed');
  expect(state.setRendererActiveBackend).not.toHaveBeenCalled();
  expect(state.setMessage).not.toHaveBeenCalled();
  expect(state.rendererSnapshotRef.current).toBe(pending);
  expect(state.showError).toHaveBeenCalledOnce();
  vi.mocked(f.context.loadModel).mockResolvedValue(undefined);
  vi.spyOn(f.engine, 'listModels').mockReturnValue([{ id: 'missing', kind: 'model' } as never]);
  harness.effect!();
  await vi.waitFor(() => expect(state.setRendererSwitchPhase).toHaveBeenLastCalledWith('idle'));
  expect(state.rendererSnapshotRef.current).toBeUndefined();
  expect(state.setRendererActiveBackend).toHaveBeenCalledWith('webgl');
  expect(f.readiness.ready(captured.id, false, false)).toBe(true);
});

it('a failed old restore does not replace a newer pending snapshot', async () => {
  const f = fixture(), captured = f.persistence.makeSnapshot()!;
  const pending = { scene: captured, readOnly: false }, newer = { ...pending, scene: { ...captured, name: 'newer' } };
  const ref = { current: pending as typeof pending | undefined };
  const state = { engine: f.engine, project: f.context.project, route: { view: 'studio' }, applicationState: { variables: {} },
    rendererSnapshotRef: ref, applyScene: vi.fn(async () => { ref.current = newer; throw new Error('old failed'); }),
    setMessage: vi.fn(), setRendererActiveBackend: vi.fn(), setRendererSwitchPhase: vi.fn(),
    setRendererSwitchMessage: vi.fn(), setRendererSwitching: vi.fn(), showError: vi.fn(),
  };
  useAppRuntimeEffects(state as unknown as Parameters<typeof useAppRuntimeEffects>[0]);
  harness.effect!();
  await vi.waitFor(() => expect(state.setRendererSwitching).toHaveBeenCalledWith(false));
  expect(ref.current).toBe(newer);
  expect(state.setRendererSwitchPhase).toHaveBeenLastCalledWith('failed');
});
