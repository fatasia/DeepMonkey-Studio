import { parseDeepRuntimePackage } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { createNativeWindowVerifier } from "./lib/nativeWindowVerifier.mjs";
export const verifySceneNativeWindow = createNativeWindowVerifier(parseDeepRuntimePackage);
