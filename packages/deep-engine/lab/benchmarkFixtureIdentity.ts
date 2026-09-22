import { frozenFixtureDescription, type BenchmarkSceneFixture } from "./benchmarkScene.js";

/** Hash binary streams separately: JSON-stringifying RGBA arrays can exceed the host string limit. */
export async function benchmarkFixtureIdentity(fixture: BenchmarkSceneFixture): Promise<Readonly<Record<string, unknown>>> {
  const description = frozenFixtureDescription(fixture);
  const packet = fixture.packet;
  const geometries = await Promise.all(packet.geometries.map(async geometry => ({ ...geometry,
    vertices: await binaryIdentity(geometry.vertices), indices: await binaryIdentity(geometry.indices),
    ...(geometry.uv0 ? { uv0: await binaryIdentity(geometry.uv0) } : {}),
    ...(geometry.uv1 ? { uv1: await binaryIdentity(geometry.uv1) } : {}),
    ...(geometry.tangents ? { tangents: await binaryIdentity(geometry.tangents) } : {}),
    ...(geometry.colors ? { colors: await binaryIdentity(geometry.colors) } : {}),
  })));
  const textures = await Promise.all((packet.textures ?? []).map(async texture => ({ ...texture,
    data: await binaryIdentity(texture.data),
    ...(texture.mipmaps ? { mipmaps: await Promise.all(texture.mipmaps.map(async level => ({
      ...level, data: await binaryIdentity(level.data),
    }))) } : {}),
  })));
  return { ...description, packet: { ...packet, geometries, textures,
    instances: packet.instances.map(instance => ({ ...instance, transform: Array.from(instance.transform) })) } };
}

async function binaryIdentity(value: ArrayBufferView<ArrayBufferLike>) {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return { type: value.constructor.name, byteLength: value.byteLength,
    sha256: Array.from(new Uint8Array(digest), item => item.toString(16).padStart(2, "0")).join("") };
}
