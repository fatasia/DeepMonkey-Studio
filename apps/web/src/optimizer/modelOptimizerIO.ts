import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";

let ioPromise: Promise<WebIO> | undefined;

export async function optimizerIO(): Promise<WebIO> {
  ioPromise ??= Promise.all([
    loadWasm("draco_encoder.wasm"), loadWasm("draco_decoder_gltf.wasm"), MeshoptDecoder.ready,
  ]).then(async ([encoderWasm, decoderWasm]) => {
    const [encoder, decoder] = await Promise.all([
      draco3d.createEncoderModule({ wasmBinary: encoderWasm }),
      draco3d.createDecoderModule({ wasmBinary: decoderWasm }),
    ]);
    return new WebIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ "draco3d.encoder": encoder, "draco3d.decoder": decoder, "meshopt.decoder": MeshoptDecoder });
  }).catch(error => { ioPromise = undefined; throw error; });
  return ioPromise;
}

async function loadWasm(name: string): Promise<Uint8Array> {
  const response = await fetch(`${import.meta.env.BASE_URL}draco/${name}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Draco 资源加载失败：${name} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
