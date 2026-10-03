import { DEFAULT_DISPLAY_CONTRACT } from "@bim-studio/contracts";
import { encodePbrDisplayColor } from "@bim-studio/deep-engine";

/** Exposure used by the preview and by the PNG export; both must stay identical (WYSIWYG). */
export const PATH_TRACE_DISPLAY_EXPOSURE = 1;
/** Display conversion runs with ray work in the worker; the main thread only paints RGBA. */
export function pathTraceAuthorPreview(image: { readonly width: number; readonly height: number; readonly data: Float32Array }) {
  const data = new Uint8ClampedArray(image.width * image.height * 4);
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    const offset = pixel * 3, rgb = encodePbrDisplayColor([image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!],
      { exposure: PATH_TRACE_DISPLAY_EXPOSURE, toneMapping: DEFAULT_DISPLAY_CONTRACT.toneMapping.operator });
    for (let channel = 0; channel < 3; channel++) data[pixel * 4 + channel] = Math.round(rgb[channel]! * 255);
    data[pixel * 4 + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}
