# Deep Engine priority event queue

Date: 2026-09-17  
Status: framework-neutral foundation implemented

The engine adopts one useful event-system property from modern declarative 3D hosts: discrete input must
not wait behind high-frequency pointer or background work. It does not adopt React event semantics,
Vue events, R3F/TresJS callbacks or a DOM dispatcher.

`PriorityEventQueue` accepts pure data with three explicit priorities:

- `discrete`: click, key and command actions; preserved individually and drained first.
- `continuous`: pointer, camera and scrub streams; the newest pending event for a stable coalesce key
  replaces the older value.
- `background`: diagnostics and non-interactive maintenance; drained last.

The queue is bounded, rejects malformed identity and capacity overflow, and uses a monotonic sequence to
preserve deterministic order within a priority. Coalescing is allowed even while the queue is full because
it does not increase residency. Drain limits provide a per-frame work budget.

The queue never invokes arbitrary callbacks. Hosts translate drained data through the existing
`SceneCommand` or Behavior IR whitelist. Hit testing, bubbling/capture and renderer mutation remain outside
this primitive; this avoids a second event or scene authority.

Remaining integration is to route Browser and Native input producers through typed payloads, bind a drain
budget to `FrameLoop` stages, and expose queue pressure/coalescing in engine diagnostics.
