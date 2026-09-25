export interface AuthorCanvasStyle {
  readonly position: string;
  readonly inset: string;
  readonly width: string;
  readonly height: string;
  readonly opacity: string;
  readonly zIndex: string;
  readonly pointerEvents: string;
}

/** The author canvas retains input; a separately prepared canvas owns Deep presentation. */
export function createDeepCanvas(container: HTMLElement, backend = "deep-webgpu"): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.dataset.rendererBackend = backend;
  Object.assign(canvas.style, {
    position: "absolute", inset: "0", width: "100%", height: "100%",
    visibility: "hidden", opacity: "0", pointerEvents: "none", zIndex: "0",
  });
  canvas.setAttribute("aria-hidden", "true");
  container.append(canvas);
  return canvas;
}

export function prepareAuthorInputCanvas(canvas: HTMLCanvasElement): void {
  Object.assign(canvas.style, {
    position: "absolute", inset: "0", width: "100%", height: "100%",
    opacity: "1", pointerEvents: "auto", zIndex: "1",
  });
}

export function captureAuthorStyle(canvas: HTMLCanvasElement): AuthorCanvasStyle {
  const { style } = canvas;
  return { position: style.position, inset: style.inset, width: style.width, height: style.height,
    opacity: style.opacity, zIndex: style.zIndex, pointerEvents: style.pointerEvents };
}

export function restoreAuthorStyle(canvas: HTMLCanvasElement, value: AuthorCanvasStyle): void {
  Object.assign(canvas.style, value);
}
