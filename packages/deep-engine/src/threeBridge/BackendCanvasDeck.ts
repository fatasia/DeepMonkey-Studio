import type { SwitchableBackend } from "../backendSwitch.js";

/** 浏览器 canvas 或原生 swap-chain surface 的最小平台端口。 */
export interface BackendCanvasSurface {
  readonly native: unknown;
  width: number;
  height: number;
  readonly parentToken: unknown;
  getStyle(name: string): string;
  setStyle(name: string, value: string): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
}

export interface BackendCanvasHost {
  readonly token: unknown;
  ensureGridLayout(): void;
  createCanvas(): BackendCanvasSurface;
  append(surface: BackendCanvasSurface): void;
}

export interface BackendCanvasLease {
  readonly backendId: string;
  readonly canvas: BackendCanvasSurface;
  readonly disposed: boolean;
  dispose(): void;
}

export interface CanvasBoundBackend<TBackend extends SwitchableBackend> extends SwitchableBackend {
  readonly backend: TBackend;
  readonly surface: BackendCanvasLease;
}

const backendIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * 为 WebGL 与 WebGPU 保留独立表面。候选在隐藏表面完成首帧，帧边界只切换
 * 两个已绘制表面的可见性，因此不需要在同一 canvas 上争用不兼容 context。
 */
export class BackendCanvasDeck {
  private readonly owned = new Set<CanvasLease>();
  private activeLease: CanvasLease | undefined;
  private closed = false;
  readonly initial: BackendCanvasLease;

  constructor(private readonly host: BackendCanvasHost, initialBackendId: string,
    initialCanvas: BackendCanvasSurface) {
    validateBackendId(initialBackendId);
    if (initialCanvas.parentToken !== host.token) host.append(initialCanvas);
    host.ensureGridLayout();
    const initial = new CanvasLease(this, initialBackendId, initialCanvas);
    this.owned.add(initial);
    this.activeLease = initial;
    this.initial = initial;
    setVisible(initialCanvas, true);
  }

  get active(): BackendCanvasLease | undefined { return this.activeLease; }
  get surfaceCount(): number { return this.owned.size; }

  reserve(backendId: string): BackendCanvasLease {
    this.assertOpen();
    validateBackendId(backendId);
    const canvas = this.host.createCanvas(), reference = this.activeLease?.canvas;
    if (reference) { canvas.width = reference.width; canvas.height = reference.height; }
    canvas.setAttribute("data-renderer-backend", backendId);
    setVisible(canvas, false);
    this.host.append(canvas);
    const lease = new CanvasLease(this, backendId, canvas);
    this.owned.add(lease);
    return lease;
  }

  publish(candidate: BackendCanvasLease, previous: BackendCanvasLease): void {
    this.assertOpen();
    const next = this.requireOwned(candidate), old = this.requireOwned(previous);
    if (old !== this.activeLease) throw new Error("Previous renderer surface is no longer active.");
    if (next === old) throw new Error("Candidate renderer surface must differ from the active surface.");
    const beforeNext = snapshot(next.canvas), beforeOld = snapshot(old.canvas);
    try {
      setVisible(next.canvas, true);
      setVisible(old.canvas, false);
      this.activeLease = next;
    } catch (error) {
      restore(next.canvas, beforeNext); restore(old.canvas, beforeOld);
      this.activeLease = old;
      throw error;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const lease of [...this.owned]) lease.dispose();
    this.activeLease = undefined;
  }

  release(lease: CanvasLease): void {
    if (!this.owned.delete(lease)) return;
    if (this.activeLease === lease) this.activeLease = undefined;
    lease.canvas.remove();
  }

  private requireOwned(lease: BackendCanvasLease): CanvasLease {
    if (!(lease instanceof CanvasLease) || lease.owner !== this || lease.disposed || !this.owned.has(lease)) {
      throw new Error("Renderer surface does not belong to this canvas deck.");
    }
    return lease;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Renderer canvas deck is disposed.");
  }
}

class CanvasLease implements BackendCanvasLease {
  private released = false;
  constructor(readonly owner: BackendCanvasDeck, readonly backendId: string,
    readonly canvas: BackendCanvasSurface) {}
  get disposed(): boolean { return this.released; }
  dispose(): void {
    if (this.released) return;
    this.released = true;
    this.owner.release(this);
  }
}

/** Couples renderer resource retirement to its surface without copying author state. */
export function bindBackendCanvas<TBackend extends SwitchableBackend>(backend: TBackend,
  surface: BackendCanvasLease): CanvasBoundBackend<TBackend> {
  if (backend.id !== surface.backendId) throw new Error("Renderer backend and canvas ids do not match.");
  let disposed = false;
  return { id: backend.id, backend, surface, dispose: () => {
    if (disposed) return;
    disposed = true;
    try { backend.dispose(); } finally { surface.dispose(); }
  } };
}

const styleNames = ["visibility", "opacity", "pointer-events", "z-index"] as const;
interface SurfaceSnapshot { readonly styles: readonly string[]; readonly ariaHidden: string | null }

function snapshot(canvas: BackendCanvasSurface): SurfaceSnapshot {
  return { styles: styleNames.map(name => canvas.getStyle(name)),
    ariaHidden: canvas.getAttribute("aria-hidden") };
}
function restore(canvas: BackendCanvasSurface, value: SurfaceSnapshot): void {
  styleNames.forEach((name, index) => canvas.setStyle(name, value.styles[index]!));
  if (value.ariaHidden === null) canvas.removeAttribute("aria-hidden");
  else canvas.setAttribute("aria-hidden", value.ariaHidden);
}
function setVisible(canvas: BackendCanvasSurface, visible: boolean): void {
  canvas.setStyle("grid-area", "1 / 1");
  canvas.setStyle("width", "100%");
  canvas.setStyle("height", "100%");
  canvas.setStyle("visibility", visible ? "visible" : "hidden");
  canvas.setStyle("opacity", visible ? "1" : "0");
  canvas.setStyle("pointer-events", visible ? "auto" : "none");
  canvas.setStyle("z-index", visible ? "1" : "0");
  canvas.setAttribute("aria-hidden", String(!visible));
}
function validateBackendId(id: string): void {
  if (!backendIdPattern.test(id)) throw new Error(`Invalid renderer backend id: ${id}`);
}
