import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// This is an attribution calculation, not GPU evidence. The GPU oracle uses
// independent ordinary parent frames so its DFG/specular contribution is measured.
const { furnace } = JSON.parse(readFileSync(new URL("../packages/deep-engine/fixtures/i-c23-native-layered-block-v1.json", import.meta.url), "utf8"));
const E = 0.5;
function mixResponses(base, layers) {
  return layers.reduce((underlying, layer) => underlying.map((value, channel) => {
    const weight = layer.coverage * (layer.overlay ? Math.min(1, Math.max(0, layer.rgb[channel])) : 1);
    return value * (1 - weight) + layer.rgb[channel] * weight;
  }), base);
}
const oldPrediction = furnace.blended.map(value => value * E);
const diffuseParents = furnace.layers.map(layer => ({ ...layer, rgb: layer.rgb.map(value => value * E) }));
const responsePrediction = mixResponses(furnace.base.map(value => value * E), diffuseParents);
assert.deepEqual(responsePrediction.map(value => Number(value.toFixed(6))), [.384375, .43125, .286875]);
const relativePercent = responsePrediction.map((value, channel) => 100 * (value / oldPrediction[channel] - 1));
assert(relativePercent[1] > 4.5 && relativePercent[1] < 4.6);
assert(relativePercent[2] > 4.7 && relativePercent[2] < 4.8);
// Replacing at fixed coverage commutes with E; overlay demonstrably does not.
const replaceOnly = furnace.layers.filter(layer => !layer.overlay);
assert.deepEqual(
  mixResponses(furnace.base, replaceOnly).map(value => Number((value * E).toFixed(9))),
  mixResponses(furnace.base.map(value => value * E), replaceOnly.map(layer => ({ ...layer, rgb: layer.rgb.map(value => value * E) }))).map(value => Number(value.toFixed(9))),
);
assert.notDeepEqual(oldPrediction, responsePrediction);
const responseAtSpecularFraction = s => {
  const parent = rgb => rgb.map(value => E * ((1 - s) * value + s));
  return mixResponses(parent(furnace.base), furnace.layers.map(layer => ({ ...layer, rgb: parent(layer.rgb) })));
};
for (const s of [0, .01, .02, .04, 1]) {
  assert(responseAtSpecularFraction(s).every(value => Number.isFinite(value) && value <= E));
}
console.log(JSON.stringify({ scope: "cpu-attribution-only", environmentRadiance: E, oldPrediction, responsePrediction, relativePercent, withIllustrativeSpecularFraction01: responseAtSpecularFraction(.01) }, null, 2));
