import { computeBlockSsim } from "./pixelParity.mjs";

/** Output bytes are compared as RGB plus alpha, without exposure fitting or resampling. */
export function compareDisplayFrames(a, b, fixture) {
  const { width, height, thresholds } = fixture;
  const count = width * height;
  if (a.length !== count * 4 || b.length !== count * 4) throw Error("Display frame dimensions differ");
  const lumaA = new Float64Array(count), lumaB = new Float64Array(count);
  let maxByteError = 0, sumSquaredError = 0, nonBlackPixels = 0;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 4; c++) {
      const av = a[i*4+c], bv = b[i*4+c];
      if (!Number.isInteger(av) || av < 0 || av > 255 || !Number.isInteger(bv) || bv < 0 || bv > 255) throw Error("Invalid output byte");
      const delta = Math.abs(av-bv); maxByteError = Math.max(maxByteError, delta); sumSquaredError += delta**2;
    }
    lumaA[i] = a[i*4]*.2126 + a[i*4+1]*.7152 + a[i*4+2]*.0722;
    lumaB[i] = b[i*4]*.2126 + b[i*4+1]*.7152 + b[i*4+2]*.0722;
    if (lumaA[i] > 0 && lumaB[i] > 0) nonBlackPixels++;
  }
  const ssim = computeBlockSsim(lumaA,lumaB,width,height,8,8);
  const mse = sumSquaredError / (count*4);
  return { passed: maxByteError <= thresholds.outputMaxByteError && ssim.min >= thresholds.outputMinSsim
    && nonBlackPixels > count/2, maxByteError, ssim, psnr: mse === 0 ? "infinity" : 10*Math.log10(255**2/mse), nonBlackPixels };
}

export function compareDisplayLibraries(a,b,fixture) {
  if (a.length !== fixture.width*fixture.height*4 || a.length !== b.length) throw Error("Library frame dimensions differ");
  let maxFloatError = 0, nonBlackPixels = 0;
  for (let i=0;i<a.length;i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw Error("Non-finite library output");
    maxFloatError = Math.max(maxFloatError, Math.abs(a[i]-b[i]));
    if (i % 4 === 0 && a.slice(i,i+3).some(v=>v>0) && b.slice(i,i+3).some(v=>v>0)) nonBlackPixels++;
  }
  return { passed: maxFloatError <= fixture.thresholds.libraryMaxFloatError && nonBlackPixels > fixture.width*fixture.height/2,
    maxFloatError, nonBlackPixels };
}
