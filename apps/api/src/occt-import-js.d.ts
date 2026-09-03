declare module "occt-import-js" {
  export interface OcctNode {
    name: string;
    meshes: number[];
    children: OcctNode[];
  }

  export interface OcctMesh {
    name: string;
    color?: number[];
    brep_faces?: Array<{ first: number; last: number; color: number[] | null }>;
    attributes: {
      position: { array: number[] };
      normal?: { array: number[] };
    };
    index: { array: number[] };
  }

  export interface OcctResult {
    success: boolean;
    root: OcctNode;
    meshes: OcctMesh[];
  }

  interface OcctInstance {
    ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
    ReadIgesFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
  }

  export default function createOcct(): Promise<OcctInstance>;
}
