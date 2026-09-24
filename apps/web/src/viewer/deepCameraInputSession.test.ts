import { describe, expect, it, vi } from "vitest";
import { DeepCameraController } from "./deepCameraController";
import { DeepCameraInputSession } from "./deepCameraInputSession";

// 输入会话合同:手势→控制器调用的映射、双指捏合、detach 后完全解绑。
describe("DeepCameraInputSession", () => {
  function harness() {
    const canvas = { clientHeight: 800, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true) } as unknown as HTMLCanvasElement;
    const controller = new DeepCameraController();
    const orbit = vi.spyOn(controller, "orbit");
    const pan = vi.spyOn(controller, "pan");
    const zoom = vi.spyOn(controller, "zoom");
    const onFrame = vi.fn();
    const session = new DeepCameraInputSession(canvas, controller, onFrame);
    const canvasEvents = new Map<string, EventListener>();
    vi.mocked(canvas.addEventListener).mockImplementation(((type: string, handler: EventListener) => {
      canvasEvents.set(type, handler);
    }) as typeof canvas.addEventListener);
    return { session, canvasEvents, canvas, orbit, pan, zoom, onFrame, controller };
  }

  function pointerEvent(canvasEvents: Map<string, EventListener>, type: string, overrides: Partial<PointerEvent>) {
    const event = { pointerId: 1, clientX: 0, clientY: 0, button: 0, shiftKey: false,
      preventDefault: vi.fn(), ...overrides } as unknown as PointerEvent;
    canvasEvents.get(type)!(event);
  }

  it("maps left-drag to orbit, right-drag to pan and wheel to zoom", () => {
    const harness0 = harness();
    harness0.session.attach();
    pointerEvent(harness0.canvasEvents, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    pointerEvent(harness0.canvasEvents, "pointermove", { pointerId: 1, clientX: 140, clientY: 130 });
    expect(harness0.orbit).toHaveBeenCalledWith(40, 30, 800);
    pointerEvent(harness0.canvasEvents, "pointerup", { pointerId: 1 });
    pointerEvent(harness0.canvasEvents, "pointerdown", { pointerId: 2, clientX: 100, clientY: 100, button: 2 });
    pointerEvent(harness0.canvasEvents, "pointermove", { pointerId: 2, clientX: 90, clientY: 80 });
    expect(harness0.pan).toHaveBeenCalledWith(-10, -20, 800);
    const wheel = { deltaY: 250, preventDefault: vi.fn() } as unknown as WheelEvent;
    harness0.canvasEvents.get("wheel")!(wheel);
    expect(harness0.zoom).toHaveBeenCalledWith(-2.5);
    expect(wheel.preventDefault).toHaveBeenCalled();
    expect(harness0.onFrame).toHaveBeenCalled();
  });

  it("shift-drag pans and two-pointer pinch zooms by distance delta", () => {
    const harness0 = harness();
    harness0.session.attach();
    pointerEvent(harness0.canvasEvents, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100, shiftKey: true });
    pointerEvent(harness0.canvasEvents, "pointermove", { pointerId: 1, clientX: 120, clientY: 100, shiftKey: true });
    expect(harness0.pan).toHaveBeenCalled();
    pointerEvent(harness0.canvasEvents, "pointerup", { pointerId: 1 });
    pointerEvent(harness0.canvasEvents, "pointerdown", { pointerId: 10, clientX: 100, clientY: 100 });
    pointerEvent(harness0.canvasEvents, "pointerdown", { pointerId: 11, clientX: 200, clientY: 100 });
    // 首次捏合移动只建立基线距离;第二次移动才产生缩放增量。
    pointerEvent(harness0.canvasEvents, "pointermove", { pointerId: 11, clientX: 300, clientY: 100 });
    expect(harness0.zoom).not.toHaveBeenCalled();
    pointerEvent(harness0.canvasEvents, "pointermove", { pointerId: 11, clientX: 400, clientY: 100 });
    expect(harness0.zoom).toHaveBeenCalledTimes(1);
    expect(harness0.zoom).toHaveBeenCalledWith(100 / 8);
  });

  it("detaches every listener and ignores late events", () => {
    const harness0 = harness();
    harness0.session.attach();
    const bound = new Map(harness0.canvasEvents);
    harness0.session.detach();
    expect(harness0.canvas.removeEventListener).toHaveBeenCalledTimes(bound.size);
    pointerEvent(harness0.canvasEvents, "pointerdown", { pointerId: 1, clientX: 5, clientY: 5 });
    pointerEvent(harness0.canvasEvents, "pointermove", { pointerId: 1, clientX: 50, clientY: 50 });
    expect(harness0.orbit).not.toHaveBeenCalled();
    expect(harness0.session.isActive).toBe(false);
  });
});
