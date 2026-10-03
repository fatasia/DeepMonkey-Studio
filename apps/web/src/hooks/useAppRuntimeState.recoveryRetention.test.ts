import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fullFixture } from '../controllers/sceneRendererRecoveryFullDomainFixture.testUtils';
import { useSceneHistoryState } from '../hooks/useSceneHistoryState';
import { restoreRendererRecoveryState } from '../controllers/restoreRendererRecoveryState';
import { useAppState } from '../hooks/useAppState';
const harness = vi.hoisted(() => ({ cursor: 0, effectCursor: 0, refs: [] as Array<{ current: unknown }>, deps: [] as unknown[][] }));
vi.mock('react', () => ({
  useState: (value: unknown) => [value, vi.fn()],
  useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useRef: (value: unknown) => { const index = harness.cursor++; return harness.refs[index] ??= { current: value }; },
  useEffect: (run: () => void, deps: unknown[]) => { const index = harness.effectCursor++, prior = harness.deps[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior[i]))) { harness.deps[index] = deps; run(); } },
}));
vi.mock('react-dom', () => ({ flushSync: (run: () => void) => run() }));

beforeEach(() => { harness.cursor = 0; harness.effectCursor = 0; harness.refs = []; harness.deps = [];
  const localStorage = { getItem: () => null, setItem: vi.fn() };
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('window', { location: { pathname: '/manager', search: '' }, localStorage });
});
afterEach(() => vi.unstubAllGlobals());

it('the actual history hook retains undo/redo across same-scene recovery and resets on a different scene id', async () => {
  const f = fullFixture(), captured = f.persistence.makeSnapshot()!;
  function render(activeScene = captured) {
    harness.cursor = 0; harness.effectCursor = 0;
    return useSceneHistoryState({ activeScene, routeView: 'studio', sceneBehaviorActive: false, animationPlaying: false });
  }
  const first = render(), history = first.sceneHistoryRef.current;
  history.record({ ...captured, name: 'edited' }, 'rename');
  expect(history.getState().canUndo).toBe(true);
  await restoreRendererRecoveryState({ scene: captured, readOnly: false }, f.context.project!, f.persistence.applyScene);
  const second = render(f.ui.setActiveScene as typeof captured);
  expect(second.sceneHistoryRef.current).toBe(history); expect(history.getState().undoLabel).toBe('rename');
  expect(history.undo()?.name).toBe(captured.name); expect(history.redo()?.name).toBe('edited');
  render({ ...captured, id: 'different' }); expect(history.getState().canUndo).toBe(false);
});

it('the actual App state hook keeps its unapplied behavior draft ref during viewer recovery rerender', () => {
  const first = useAppState();
  const draft = { id: 'draft', name: '作者未应用', code: 'UNSAVED', language: 'javascript' } as never;
  first.pendingBehaviorDraftRef.current = draft;
  first.rendererSnapshotRef.current = { scene: fullFixture().persistence.makeSnapshot()!, readOnly: false };
  harness.cursor = 0; harness.effectCursor = 0;
  const rerendered = useAppState();
  expect(rerendered.pendingBehaviorDraftRef).toBe(first.pendingBehaviorDraftRef);
  expect(rerendered.pendingBehaviorDraftRef.current).toBe(draft);
  expect(rerendered.rendererSnapshotRef).toBe(first.rendererSnapshotRef);
});
