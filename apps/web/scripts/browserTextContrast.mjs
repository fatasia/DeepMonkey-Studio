/** Read-only DOM probe; handles transparent ancestors without reading application/session state. */
export function collectTextContrast(root, selector) {
  const rgb = value => {
    const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
    return value.startsWith("color(srgb") ? numbers.slice(0, 3).map(n => n * 255) : numbers.slice(0, 3);
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
      const channels = rgb(color);
      const alpha = color.match(/(?:,|\/)\s*([\d.]+)\)$/);
      const a = color.startsWith("rgba") || color.includes("/") ? Number(alpha?.[1] ?? 1) : 1;
      if (channels.length === 3) background = channels.map((c, i) => c * a + background[i] * (1 - a));
    }
    const style = getComputedStyle(node);
    const foreground = luminance(rgb(style.color)), behind = luminance(background);
    return { text: node.textContent?.trim().slice(0, 70), color: style.color,
      contrast: (Math.max(foreground, behind) + .05) / (Math.min(foreground, behind) + .05), fontSize: parseFloat(style.fontSize) };
  });
}
