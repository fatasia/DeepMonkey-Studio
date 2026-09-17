# Scene API → SceneChangeset mutation gateway

Status: implemented foundation slice, 2026-09-17.

## Decision

`SceneTransformGraph` remains the only authority for transform and visibility. `SceneMutationGateway` is a narrow compiler and transaction boundary: it parses host commands, compiles the supported subset to one `SceneChangeset`, then delegates CAS and atomic application to the existing changeset implementation.

This is an adoption of the useful declarative-renderer pattern, not an R3F/TresJS compatibility layer. Deep Engine does not import React, Vue, Three.js, R3F, TresJS, or `@bim-studio/scene-sdk` here.

## Supported v1 mapping

| Scene API command | Target | SceneChangeset command | Notes |
| --- | --- | --- | --- |
| `object.set-transform` | object | `transform` | Partial TRS patches preserve unspecified TRS fields. Euler input is XYZ radians and is compiled to a quaternion. Matrix-authored nodes reject partial TRS editing. |
| `object.set-visibility` | object | `hidden` | `hidden = !visible`; visibility participates in graph flush and revision advancement. |

Scene, mesh, material, selection, camera, animation, data, component and Unity commands are explicitly unsupported by this v1 gateway. Nothing falls through to raw renderer mutation.

## Host boundary

The constructor requires a framework-neutral parser port:

```ts
const gateway = new SceneMutationGateway(graph, {
  sceneId,
  parser: { parse: parseSceneCommand },
})
```

The Web host may inject `@bim-studio/scene-sdk`'s `parseSceneCommand` for untrusted JSON. Deep Engine receives only the parser result as pure data and repeats the structural checks needed by this mapping. This keeps validation ownership at the ingress without adding a package dependency or a second command model.

## Transaction and performance contract

- `prepare()` is side-effect free. It snapshots graph revision and per-node revision into a pure `SceneChangeset`.
- `commit()` uses the existing whole-changeset CAS. A stale graph revision or node revision rejects the complete batch.
- Repeated transform patches for one node are folded into one final command. Final no-ops and empty transform patches are removed.
- A v1 changeset permits only one mutation kind per node. A batch containing both transform and visibility for the same node rejects explicitly instead of splitting into non-atomic writes.
- Renderer adapters consume the resulting graph flush. They never become owners of Scene API state.

## Boundaries with existing systems

- `@bim-studio/scene-sdk`: owns the public protocol and untrusted-input validation. The gateway owns only compilation into Deep Engine authority.
- `ThreeProjectionBridge`: remains a projection/compatibility reader for authoring scenes and RenderPacket generation. It must not apply Scene API mutations or retain a parallel authoritative transform store.
- Native/WebGPU adapters: consume graph revisions and flushes. They do not need Scene SDK, Three.js, React, or Vue.
- High-frequency animation: stays on compiled behavior/frame-buffer paths. It must not create JSON Scene API commands every frame.

## Verified evidence

- `SceneMutationGateway.test.ts`: mapping, Euler conversion, stale preparation, explicit unsupported cases, matrix rejection, batch coalescing/no-op removal and same-node conflict rollback.
- `SceneChangeset.test.ts` and `SceneTransformGraph.test.ts`: existing authority, transaction and graph regressions.
- Scene suite result: 47 tests passed; package TypeScript checks passed.

## Remaining integration

The Web `ViewerSceneCommandPort` still writes directly to `ViewerEngine`. A later Web-owned slice should inject the Scene SDK parser, route the supported commands through this gateway, and make both the Three author view and Deep renderer consume the same graph flush. Unsupported commands must continue through their existing explicit host ports until equivalent authority domains exist.
