import { describe, expect, it, vi } from "vitest";
import { BackendSwitchCoordinator } from "../backendSwitch.js";
import { BackendCanvasDeck, bindBackendCanvas } from "./BackendCanvasDeck.js";

function canvas() {
  const attributes = new Map<string, string>(), styles = new Map<string, string>();
  let owner: { children: ReturnType<typeof canvas>[] } | undefined;
  return {
    native: {}, width: 640, height: 360, parentToken: undefined as unknown,
    getStyle(name: string) { return styles.get(name) ?? ""; },
    setStyle(name: string, value: string) { styles.set(name, value); },
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    getAttribute(name: string) { return attributes.get(name) ?? null; },
    removeAttribute(name: string) { attributes.delete(name); },
    remove() {
      if (owner) owner.children.splice(owner.children.indexOf(this), 1);
      owner = undefined; this.parentToken = undefined;
    },
    attach(parent: { children: ReturnType<typeof canvas>[] }, token: unknown) {
      owner = parent; this.parentToken = token;
    },
  };
}

function host() {
  const result = {
    token: {}, grid: false, children: [] as ReturnType<typeof canvas>[],
    ensureGridLayout() { this.grid = true; },
    createCanvas: () => canvas(),
    append(item: ReturnType<typeof canvas>) {
      if (!this.children.includes(item)) this.children.push(item);
      item.attach(this, this.token);
    },
  };
  return result;
}

function fixture() {
  const root = host(), initialCanvas = canvas();
  const deck = new BackendCanvasDeck(root, "three", initialCanvas);
  return { root, initialCanvas, deck };
}

describe("BackendCanvasDeck", () => {
  it("stages a separate same-sized canvas without hiding the active renderer", () => {
    const { root, initialCanvas, deck } = fixture(), candidate = deck.reserve("deep-webgpu");
    expect(root.children).toHaveLength(2);
    expect(candidate.canvas).not.toBe(initialCanvas);
    expect(candidate.canvas).toMatchObject({ width: 640, height: 360 });
    expect(initialCanvas.getStyle("visibility")).toBe("visible");
    expect(candidate.canvas.getStyle("visibility")).toBe("hidden");
    expect(candidate.canvas.getAttribute("aria-hidden")).toBe("true");
  });

  it("publishes an already-rendered candidate and retires the old canvas", async () => {
    const { root, initialCanvas, deck } = fixture();
    const oldRenderer = { id: "three", dispose: vi.fn() };
    const old = bindBackendCanvas(oldRenderer, deck.initial);
    const coordinator = new BackendSwitchCoordinator(old, {
      state: { revision: 1 },
      prepare: async id => bindBackendCanvas({ id, dispose: vi.fn() }, deck.reserve(id)),
      atFrameBoundary: async publish => publish(),
      publishSurface: (next, previous) => deck.publish(next.surface, previous.surface),
    });
    expect(await coordinator.switchTo("deep-webgpu")).toMatchObject({ status: "switched" });
    expect(root.children).toHaveLength(1);
    expect(initialCanvas.parentToken).toBeUndefined();
    expect(coordinator.active.surface.canvas.getStyle("visibility")).toBe("visible");
    expect(oldRenderer.dispose).toHaveBeenCalledOnce();
  });

  it("removes a rejected candidate while the current surface stays live", async () => {
    const { root, deck } = fixture();
    const current = bindBackendCanvas({ id: "three", dispose: vi.fn() }, deck.initial);
    const coordinator = new BackendSwitchCoordinator(current, {
      state: {},
      prepare: async id => bindBackendCanvas({ id, dispose: vi.fn() }, deck.reserve(id)),
      atFrameBoundary: async publish => publish(),
      publishSurface: () => { throw new Error("compositor refused handoff"); },
    });
    expect(await coordinator.switchTo("deep-webgpu")).toMatchObject({ status: "failed", activeId: "three" });
    expect(root.children).toHaveLength(1);
    expect(deck.active).toBe(deck.initial);
    expect(deck.initial.canvas.getStyle("visibility")).toBe("visible");
  });

  it("keeps one surface across twenty WebGL/WebGPU round trips", async () => {
    const { root, deck } = fixture();
    const created: Array<{ id: string; dispose: ReturnType<typeof vi.fn> }> = [];
    const make = (id: string, surface = deck.reserve(id)) => {
      const backend = { id, dispose: vi.fn() }; created.push(backend);
      return bindBackendCanvas(backend, surface);
    };
    const initial = { id: "three", dispose: vi.fn() }; created.push(initial);
    const coordinator = new BackendSwitchCoordinator(bindBackendCanvas(initial, deck.initial), {
      state: {}, prepare: async id => make(id), atFrameBoundary: async publish => publish(),
      publishSurface: (next, previous) => deck.publish(next.surface, previous.surface),
    });
    for (let index = 0; index < 20; index++) {
      const id = index % 2 === 0 ? "deep-webgpu" : "three";
      expect((await coordinator.switchTo(id)).status).toBe("switched");
      expect(root.children).toHaveLength(1);
      expect(deck.surfaceCount).toBe(1);
    }
    expect(created.slice(0, -1).every(item => item.dispose.mock.calls.length === 1)).toBe(true);
  });
});
