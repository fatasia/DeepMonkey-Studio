import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ cleanups: [] as Array<() => void>, workers: [] as Array<{ terminate: ReturnType<typeof vi.fn> }> }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }), useState: () => [undefined, vi.fn()],
  useEffect: (effect: () => () => void) => harness.cleanups.push(effect()),
}));
vi.mock("./modelOptimizerWorkerClient", () => ({ ModelOptimizerWorkerClient: class {
  terminate = vi.fn(); constructor() { harness.workers.push(this); }
} }));
import { useOptimizerTask } from "./useOptimizerTask";

beforeEach(() => { harness.cleanups = []; harness.workers = []; vi.useFakeTimers(); });
afterEach(() => { harness.cleanups.forEach(cleanup => cleanup()); vi.useRealTimers(); });
describe("optimizer session worker ownership", () => {
  it("reuses only explicitly retained workers and releases them after one idle minute", async () => {
    const task = useOptimizerTask(), errors = vi.fn();
    await task.run("optimize", async current => { current.worker(); }, errors, false, true);
    await vi.advanceTimersByTimeAsync(59_000);
    await task.run("optimize", async current => { current.worker(); }, errors, false, true);
    expect(harness.workers).toHaveLength(1);
    expect(harness.workers[0]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.workers[0]!.terminate).toHaveBeenCalledOnce();
    await task.run("save", async current => { current.worker(); }, errors, false, true);
    expect(harness.workers).toHaveLength(2);
  });

  it("cancels delayed work without committing and recreates a clean worker on the next edit", async () => {
    const task = useOptimizerTask(), commit = vi.fn(), errors = vi.fn();
    let release!: () => void;
    const pending = task.run("optimize", async current => { current.worker(); await new Promise<void>(resolve => { release = resolve; }); current.assertCurrent(); commit(); }, errors, false, true);
    task.cancel(); release(); await pending;
    expect(commit).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
    expect(harness.workers[0]!.terminate).toHaveBeenCalledOnce();
    await task.run("optimize", async current => { current.worker(); }, errors, false, true);
    expect(harness.workers).toHaveLength(2);
    harness.cleanups[0]!(); expect(harness.workers[1]!.terminate).toHaveBeenCalledOnce();
  });

  it("releases cached documents when switching to a normal import", async () => {
    const task = useOptimizerTask(), errors = vi.fn();
    await task.run("optimize", async current => { current.worker(); }, errors, false, true);
    await task.run("import", async current => { current.worker(); }, errors, true);
    expect(harness.workers).toHaveLength(2);
    harness.workers.forEach(worker => expect(worker.terminate).toHaveBeenCalledOnce());
  });
});
