declare module "draco3dgltf" {
  interface DracoModule {
    createEncoderModule(config?: { wasmBinary?: Uint8Array }): Promise<unknown>;
    createDecoderModule(config?: { wasmBinary?: Uint8Array }): Promise<unknown>;
  }
  const draco3d: DracoModule;
  export default draco3d;
}
