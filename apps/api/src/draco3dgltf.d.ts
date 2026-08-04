declare module "draco3dgltf" {
  interface DracoModuleFactory {
    createEncoderModule(): Promise<unknown>;
    createDecoderModule(): Promise<unknown>;
  }

  const draco3d: DracoModuleFactory;
  export default draco3d;
}
