import { DeepCameraController } from "./deepCameraController";

/**
 * Deep 演示后端的输入会话:把 DOM 指针/滚轮事件映射为引擎中立相机控制器的
 * 手势。与 OrbitControls 的交互约定对齐——左键轨道、右键或 Shift+左键平移、
 * 滚轮推拉;触屏单指轨道、双指捏合推拉。事件监听只挂在传入的画布上,
 * 不触碰任何 Three 对象;激活/停用由调用方在引擎切换时驱动。
 */
export class DeepCameraInputSession {
  private readonly canvas: HTMLCanvasElement;
  private readonly controller: DeepCameraController;
  private readonly onFrame: () => void;
  private active = false;
  private pointerId: number | undefined;
  private lastX = 0;
  private lastY = 0;
  private button = 0;
  private shift = false;
  private pinchDistance: number | undefined;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private readonly listeners: Array<[EventTarget, string, EventListener]> = [];

  constructor(canvas: HTMLCanvasElement, controller: DeepCameraController, onFrame: () => void) {
    this.canvas = canvas;
    this.controller = controller;
    this.onFrame = onFrame;
  }

  /** 绑定事件;重复调用无效。返回画布以便调用方同时设置 pointerEvents。 */
  attach(): HTMLCanvasElement {
    if (this.active) return this.canvas;
    this.active = true;
    const bind = (type: string, handler: EventListener) => {
      this.canvas.addEventListener(type, handler);
      this.listeners.push([this.canvas, type, handler]);
    };
    bind("pointerdown", event => this.onPointerDown(event as PointerEvent));
    bind("pointermove", event => this.onPointerMove(event as PointerEvent));
    bind("pointerup", event => this.onPointerUp(event as PointerEvent));
    bind("pointercancel", event => this.onPointerUp(event as PointerEvent));
    bind("wheel", event => this.onWheel(event as WheelEvent));
    bind("contextmenu", event => event.preventDefault());
    bind("keydown", event => { this.shift = (event as KeyboardEvent).shiftKey; });
    bind("keyup", event => { this.shift = (event as KeyboardEvent).shiftKey; });
    return this.canvas;
  }

  detach(): void {
    if (!this.active) return;
    this.active = false;
    this.pointers.clear();
    this.pointerId = undefined;
    this.pinchDistance = undefined;
    for (const [target, type, handler] of this.listeners.splice(0)) {
      target.removeEventListener(type, handler);
    }
  }

  get isActive(): boolean { return this.active; }

  private onPointerDown(event: PointerEvent): void {
    this.shift = event.shiftKey;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointerId !== undefined) return; // 已有主指针:双指捏合只更新集合。
    this.pointerId = event.pointerId;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.button = event.button;
    this.canvas.setPointerCapture(event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    this.shift = event.shiftKey;
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (this.pointers.size === 2) {
      this.applyPinch();
      return;
    }
    if (event.pointerId !== this.pointerId || !this.active) return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (dx === 0 && dy === 0) return;
    const panning = this.button === 2 || this.shift;
    if (panning) this.controller.pan(dx, dy, this.canvas.clientHeight);
    else this.controller.orbit(dx, dy, this.canvas.clientHeight);
    this.onFrame();
  }

  private onPointerUp(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (event.pointerId === this.pointerId) {
      this.pointerId = undefined;
      this.pinchDistance = undefined;
    }
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  }

  private onWheel(event: WheelEvent): void {
    if (!this.active) return;
    event.preventDefault();
    // 每 100 像素滚距折一格,与 OrbitControls 的 dolly 步进量级一致。
    this.controller.zoom(-(event.deltaY / 100));
    this.onFrame();
  }

  private applyPinch(): void {
    const [first, second] = [...this.pointers.values()];
    if (!first || !second) return;
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    if (this.pinchDistance !== undefined && distance > 0) {
      // 捏合距离每变化 8 像素折一格推拉。
      this.controller.zoom((distance - this.pinchDistance) / 8);
      this.onFrame();
    }
    this.pinchDistance = distance;
  }
}
