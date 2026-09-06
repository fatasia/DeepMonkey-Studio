/** Read-only DOM probe; handles transparent ancestors without reading application/session state. */
export function collectTextContrast(root, selector) {
  // Chrome may serialize transitions as oklab(). Let its color engine resolve
  // CSS colors into display sRGB instead of interpreting their channels as RGB.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!context) throw new Error("Text contrast probe requires Canvas2D color parsing");
  const colors = new Map();
  const rgba = value => {
    if (colors.has(value)) return colors.get(value);
    if (!CSS.supports("color", value)) throw new Error(`Unsupported computed CSS color: ${value}`);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const channels = [...context.getImageData(0, 0, 1, 1).data];
    colors.set(value, channels);
    return channels;
  };
  const luminance = channels => channels.map(n => {
    const c = n / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  return [...root.querySelectorAll(selector)].filter(node => node.checkVisibility()).map(node => {
    let background = [255, 255, 255];
    const ancestors = [];
    for (let parent = node; parent; parent = parent.parentElement) ancestors.unshift(parent);
    for (const parent of ancestors) {
      const color = getComputedStyle(parent).backgroundColor;
      const channels = rgba(color);
      const a = channels[3] / 255;
      background = channels.slice(0, 3).map((c, i) => c * a + background[i] * (1 - a));
    }
    const style = getComputedStyle(node);
    const color = rgba(style.color);
    const foreground = luminance(color.slice(0, 3).map((c, i) => c * color[3] / 255 + background[i] * (1 - color[3] / 255)));
    const behind = luminance(background);
    return { text: node.textContent?.trim().slice(0, 70), color: style.color,
      contrast: (Math.max(foreground, behind) + .05) / (Math.min(foreground, behind) + .05), fontSize: parseFloat(style.fontSize) };
  });
}
