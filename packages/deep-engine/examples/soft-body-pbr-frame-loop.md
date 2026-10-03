# Soft-body frames

Use the existing fixed-step physics session to publish cloth or soft-body vertices into a PBR packet.

```ts
import { renderSoftBodyPbrFrame } from "./soft-body-pbr-frame-loop.js";

const state = { packet };
const bindings = [{ bodyId: "cloth", instanceId: "cloth", vertexParticles }];

// Advance the host's existing 60 Hz clock before drawing.
session.step();
renderSoftBodyPbrFrame(renderer, session, state, bindings, view);
```

`vertexParticles` maps each render vertex to a solver particle. Duplicate indices support mesh seams. Keep `state.packet` as the packet owner; the helper advances geometry revisions after publication succeeds.

The first profile requires a translation-only instance with an exclusive geometry, without LOD, skin/morph deformation, tangents or normal textures. Select fixed sphere or cuboid contacts with `createSoftBodyRuntimeSession(physics, { collisionBodyIds })`. The host owns its clock, RAF and renderer disposal.

The default path rebuilds the changed mesh and resets motion history. It is verified on a small cloth fixture; large meshes, continuous-frame performance and Native soft bodies remain pending. [Verification and supported scope](../../../docs/specs/f6-continuation-audit-20261001.md).

For one geometry and one instance, opt in before the first packet upload:

```ts
import { PbrRenderer } from "@bim-studio/deep-engine/webgpu";

const renderer = await PbrRenderer.create(canvas, navigator.gpu, signal, {
  vertexStreamingGeometry: "cloth", // GeometryResource.id, not the body or instance ID.
  features: { temporalAa: false },
});
await renderer.setPacketValidated(packet);
const state = { packet };
// Use the same fixed-step loop and bindings shown above.
```

The renderer keeps two vertex buffers and reuses indices and instance buffers. Keep material, transform, topology, UVs and colors fixed; use an untextured packet with no extra geometry, LOD, pose, tangents or deformation. Publish before encoding frame commands. An empty packet clears the resources and admits a new baseline.

The opt-in path has 14 passing CPU regressions and passes the complete SDK typecheck and build. Two fresh GPU runs passed 8 frames and 72 checks: solver/vertex data and full HDR/present bytes match the replacement path. Across 240 updates, vertex/index buffer allocations fall from 241/241 to 2/1; update-time index writes are zero and disposal releases all SDK resources. PNG captures match across both capture batches; the fixture conservatively waits two animation frames before capturing. Continuous FPS and previous-vertex TAA motion history are not verified.
