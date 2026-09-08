export const LEGACY_SPEC_GLOSS = "KHR_materials_pbrSpecularGlossiness";

/** Inspect only the JSON chunk; do not touch original GLB bytes or normal material documents. */
export function hasLegacySpecGloss(data: ArrayBuffer | string): boolean {
  let text: string;
  if (typeof data === "string") text = data;
  else {
    const header = new DataView(data);
    if (data.byteLength >= 20 && header.getUint32(0, true) === 0x46546c67) {
      if (header.getUint32(16, true) !== 0x4e4f534a) return false;
      const length = header.getUint32(12, true);
      if (length > data.byteLength - 20) return false;
      text = new TextDecoder().decode(new Uint8Array(data, 20, length));
    } else text = new TextDecoder().decode(data);
  }
  if (!text.includes(LEGACY_SPEC_GLOSS)) return false;
  const json = JSON.parse(text) as { materials?: Array<{ extensions?: Record<string, unknown> }> };
  return Boolean(json.materials?.some(material => material.extensions?.[LEGACY_SPEC_GLOSS]));
}
