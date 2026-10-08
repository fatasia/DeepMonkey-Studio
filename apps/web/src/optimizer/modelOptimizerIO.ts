import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

let ioPromise: Promise<WebIO> | undefined;
let decoderPromise: ReturnType<typeof draco3d.createDecoderModule> | undefined;
let encoderPromise: ReturnType<typeof draco3d.createEncoderModule> | undefined;
const decoderIoPromises = new Map<boolean, Promise<WebIO>>();

export async function optimizerIO(): Promise<WebIO> {
  ioPromise ??= Promise.all([encoderModule(), decoderModule(), meshoptDecoder()]).then(([encoder, decoder, meshopt]) => {
    return new WebIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ "draco3d.encoder": encoder, "draco3d.decoder": decoder, "meshopt.decoder": meshopt });
  }).catch(error => { ioPromise = undefined; throw error; });
  return ioPromise;
}

/** Decompression never creates an encoder or an unrelated Meshopt WASM instance. */
export function modelDecoderIO(needsMeshopt: boolean): Promise<WebIO> {
  let io = decoderIoPromises.get(needsMeshopt);
  if (!io) {
    io = Promise.all([decoderModule(), needsMeshopt ? meshoptDecoder() : undefined]).then(([decoder, meshopt]) =>
      new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": decoder,
        ...(meshopt ? { "meshopt.decoder": meshopt } : {}) }))
      .catch(error => { decoderIoPromises.delete(needsMeshopt); throw error; });
    decoderIoPromises.set(needsMeshopt, io);
  }
  return io;
}

function decoderModule(): ReturnType<typeof draco3d.createDecoderModule> {
  decoderPromise ??= loadWasm("draco_decoder_gltf.wasm").then(wasmBinary => draco3d.createDecoderModule({ wasmBinary }))
    .catch(error => { decoderPromise = undefined; throw error; });
  return decoderPromise;
}

function encoderModule(): ReturnType<typeof draco3d.createEncoderModule> {
  encoderPromise ??= loadWasm("draco_encoder.wasm").then(wasmBinary => draco3d.createEncoderModule({ wasmBinary }))
    .catch(error => { encoderPromise = undefined; throw error; });
  return encoderPromise;
}

async function meshoptDecoder() {
  const { MeshoptDecoder } = await import("meshoptimizer");
  await MeshoptDecoder.ready;
  return MeshoptDecoder;
}

async function loadWasm(name: string): Promise<Uint8Array> {
  const response = await fetch(`${import.meta.env.BASE_URL}draco/${name}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Draco 资源加载失败：${name} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
