export interface XRThumbstickState {
  x: number;
  y: number;
  exitPressed: boolean;
}

export function readXRThumbstick(
  axes: readonly number[],
  buttons: readonly { pressed: boolean }[]
): XRThumbstickState {
  const x = axes.length >= 4 ? axes[axes.length - 2] ?? 0 : axes[0] ?? 0;
  const y = axes.length >= 4 ? axes[axes.length - 1] ?? 0 : axes[1] ?? 0;
  return { x, y, exitPressed: Boolean(buttons[5]?.pressed) };
}
