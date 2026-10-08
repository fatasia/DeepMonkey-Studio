import type { DeviceSession } from "./deviceSession.js";
import { EDITOR_OVERLAY_MAX_VERTICES, snapshotEditorOverlay, type EditorOverlaySnapshot } from "./editorOverlayTypes.js";

/** Compare against our validated copy so mutable caller arrays never bypass revision checks. */
function sameOwnedVertices(input: EditorOverlaySnapshot, owned: EditorOverlaySnapshot): boolean {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !(input.vertices instanceof Float32Array)
    || !(input.vertices.buffer instanceof ArrayBuffer) || input.vertices.length !== owned.vertices.length
    || input.vertices.length > EDITOR_OVERLAY_MAX_VERTICES * 8) return false;
  for (let index = 0; index < input.vertices.length; index++) if (input.vertices[index] !== owned.vertices[index]) return false;
  return true;
}

export function editorOverlayShader(format: GPUTextureFormat): string {
  return `struct Vertex { @builtin(position) position: vec4f, @location(0) color: vec4f };
@vertex fn vs(@location(0) position: vec4f, @location(1) color: vec4f) -> Vertex {
  var out: Vertex; out.position = position; out.color = color; return out;
}
@fragment fn fs(in: Vertex) -> @location(0) vec4f {
  var color = in.color.rgb;
  ${format.endsWith("-srgb") ? "color = select(pow((color + 0.055) / 1.055, vec3f(2.4)), color / 12.92, color <= vec3f(0.04045));" : ""}
  return vec4f(color * in.color.a, in.color.a);
}`;
}

/** Owns only transient editor draw data; author input and selection remain outside the renderer. */
export class EditorOverlayPass {
  private readonly pipeline: GPURenderPipeline;
  private buffer: GPUBuffer | undefined;
  private capacity = 0;
  private current: EditorOverlaySnapshot | undefined;
  private disposed = false;
  constructor(private readonly session: DeviceSession) {
    const module = session.device.createShaderModule({ label: "Deep editor overlay", code: editorOverlayShader(session.format) });
    this.pipeline = session.device.createRenderPipeline({ label: "Deep editor overlay", layout: "auto",
      vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 32, attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x4" }, { shaderLocation: 1, offset: 16, format: "float32x4" }] }] },
      fragment: { module, entryPoint: "fs", targets: [{ format: session.format, blend: {
        color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }] },
      primitive: { topology: "triangle-list", cullMode: "none" } });
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, snapshot?: EditorOverlaySnapshot, queries?: GPUQuerySet): number {
    if (this.disposed) throw new Error("Editor overlay is disposed.");
    if (!snapshot) { this.current = undefined; return 0; }
    const previous = this.current;
    const same = previous !== undefined && sameOwnedVertices(snapshot, previous);
    const next = same ? { revision: snapshot.revision, vertices: previous!.vertices } : snapshotEditorOverlay(snapshot);
    if (previous && next.revision < previous.revision) throw new Error("Editor overlay revision went backwards.");
    if (previous && next.revision === previous.revision && !same) throw new Error("Editor overlay changed without a revision.");
    if (!next.vertices.length) { this.current = next; return 0; }
    if (!same) {
      const old = this.buffer;
      const grows = !old || next.vertices.byteLength > this.capacity;
      const capacity = grows ? next.vertices.byteLength : this.capacity;
      const buffer = grows ? this.session.own(this.session.device.createBuffer({ label: "Deep editor overlay vertices",
        size: capacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })) : old!;
      try { this.session.device.queue.writeBuffer(buffer, 0, next.vertices); }
      catch (error) { if (grows) this.session.release(buffer); else this.current = undefined; throw error; }
      this.buffer = buffer; this.capacity = capacity; this.current = next;
      if (grows && old) this.session.release(old);
    } else this.current = next;
    const pass = encoder.beginRenderPass({ label: "Deep editor overlay",
      ...(queries ? { timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 } } : {}), colorAttachments: [
      { view: target, loadOp: "load", storeOp: "store" }] });
    try { pass.setPipeline(this.pipeline); pass.setVertexBuffer(0, this.buffer!); pass.draw(next.vertices.length / 8); }
    finally { pass.end(); }
    return next.vertices.length / 24;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.current = undefined;
    if (this.buffer) this.session.release(this.buffer);
    this.buffer = undefined;
  }
}
