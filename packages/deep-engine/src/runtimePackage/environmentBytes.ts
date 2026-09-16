import { requireValue } from "./primitives.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Validate canonical bytes without allocating a decoded plane. The callback is optional for uploads. */
export function visitIblBytes(text: string, bytes: number, path: string, emit?: (byte: number, index: number) => void): void {
  requireValue(text.length === Math.ceil(bytes / 3) * 4, path, "IBL byte length differs from dimensions.");
  let index = 0, low = 0;
  const append = (value: number): void => {
    if (index % 2 === 0) low = value;
    else {
      const half = low | (value << 8);
      requireValue((half & 0x7c00) !== 0x7c00 && (!(half & 0x8000) || (half & 0x7fff) === 0),
        path, "IBL half texels must be finite and non-negative.");
    }
    emit?.(value, index); index++;
  };
  for (let offset = 0; offset < text.length; offset += 4) {
    const remaining = bytes - index;
    const a = alphabet.indexOf(text[offset]!), b = alphabet.indexOf(text[offset + 1]!);
    const c = remaining > 1 ? alphabet.indexOf(text[offset + 2]!) : 0;
    const d = remaining > 2 ? alphabet.indexOf(text[offset + 3]!) : 0;
    requireValue(a >= 0 && b >= 0 && c >= 0 && d >= 0, path, "Invalid IBL base64 alphabet.");
    requireValue((remaining > 1 || (text[offset + 2] === "=" && (b & 15) === 0))
      && (remaining > 2 || text[offset + 3] === "=") && (remaining !== 2 || (c & 3) === 0),
    path, "Invalid IBL base64 padding.");
    append((a << 2) | (b >> 4));
    if (remaining > 1) append(((b & 15) << 4) | (c >> 2));
    if (remaining > 2) append(((c & 3) << 6) | d);
  }
}
