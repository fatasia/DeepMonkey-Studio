import type { BackendCanvasHost, BackendCanvasSurface } from "../src/threeBridge/index.js";

export interface DomCanvasSurface extends BackendCanvasSurface {
  readonly native: HTMLCanvasElement;
}

export function domCanvasSurface(canvas: HTMLCanvasElement): DomCanvasSurface {
  return {
    native: canvas,
    get width() { return canvas.width; }, set width(value) { canvas.width = value; },
    get height() { return canvas.height; }, set height(value) { canvas.height = value; },
    get parentToken() { return canvas.parentElement; },
    getStyle: name => canvas.style.getPropertyValue(name),
    setStyle: (name, value) => canvas.style.setProperty(name, value),
    getAttribute: name => canvas.getAttribute(name),
    setAttribute: (name, value) => canvas.setAttribute(name, value),
    removeAttribute: name => canvas.removeAttribute(name),
    remove: () => canvas.remove(),
  };
}

export function domCanvasHost(host: HTMLElement): BackendCanvasHost {
  return {
    token: host,
    ensureGridLayout: () => { if (!host.style.display) host.style.display = "grid"; },
    createCanvas: () => domCanvasSurface(host.ownerDocument.createElement("canvas")),
    append: surface => host.appendChild((surface as DomCanvasSurface).native),
  };
}
