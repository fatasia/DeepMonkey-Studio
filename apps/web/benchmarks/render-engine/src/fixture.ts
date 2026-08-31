export const FIXTURE_COLORS = ["#d6a94c", "#54a994", "#557f9f", "#c86f63", "#8170aa", "#849059"] as const;
export const FIXTURE_KINDS = ["box", "sphere", "cylinder", "cone", "torus", "capsule"] as const;
export type FixtureKind = typeof FIXTURE_KINDS[number];

export interface FixtureObject {
  index: number;
  kind: FixtureKind;
  color: string;
  position: [number, number, number];
  rotationY: number;
  scale: [number, number, number];
}

export function fixtureObjects(count: number, cycle = 0): FixtureObject[] {
  const columns = Math.ceil(Math.sqrt(count * 1.2));
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => ({
    index,
    kind: FIXTURE_KINDS[index % FIXTURE_KINDS.length]!,
    color: FIXTURE_COLORS[(index + cycle) % FIXTURE_COLORS.length]!,
    position: [(index % columns - (columns - 1) / 2) * 1.8, 0, (Math.floor(index / columns) - (rows - 1) / 2) * 1.8],
    rotationY: index * 0.17 + cycle * 0.03,
    scale: [0.55, 0.55 + index % 4 * 0.08, 0.55],
  }));
}

export function fixtureCameraDistance(count: number): number {
  return Math.max(19, Math.ceil(Math.sqrt(count * 1.2)) * 1.55);
}
