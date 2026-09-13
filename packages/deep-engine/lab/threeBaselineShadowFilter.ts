import { add, Fn, reference, renderGroup, texture, vec2 } from "three/tsl";

interface ShadowFilterInput {
  readonly [key: string]: any;
  readonly depthTexture: { readonly isArrayTexture?: boolean };
  readonly shadowCoord: any;
  readonly shadow: object;
  readonly depthLayer: any;
}

/** Matches Deep's nine equally weighted, one-texel comparison samples. */
export const deepBaselineShadowFilter = Fn<ShadowFilterInput, any>(({
  depthTexture, shadowCoord, shadow, depthLayer,
}) => {
  const mapSize = (reference("mapSize", "vec2", shadow) as any).setGroup(renderGroup);
  const texel = vec2(1).div(mapSize);
  const compare = (x: number, y: number) => {
    let sample = texture(depthTexture as never, shadowCoord.xy.add(texel.mul(vec2(x, y))));
    if (depthTexture.isArrayTexture) sample = sample.depth(depthLayer);
    return sample.compare(shadowCoord.z);
  };
  return add(compare(-1, -1), compare(0, -1), compare(1, -1),
    compare(-1, 0), compare(0, 0), compare(1, 0),
    compare(-1, 1), compare(0, 1), compare(1, 1)).mul(1 / 9);
});
