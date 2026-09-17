# Deep Engine frame loop contract

Date: 2026-09-17  
Status: foundation implemented; renderer-host wiring remains

## Decision

Deep Engine adopts the useful render-loop ideas demonstrated by R3F and TresJS without importing or
supporting either framework. The contract is framework-neutral and owns no scene, renderer, RAF, DOM,
Vue or React state. A browser RAF, Native message pump or deterministic test clock calls `advance()`.

## Modes

- `always`: the host may continuously request frames.
- `demand`: a clean loop executes nothing; `invalidate(reason)` performs one clean-to-dirty transition
  so the host schedules at most one frame.
- `manual`: the caller advances an injected timestamp explicitly; useful for deterministic replay,
  capture and tests.

Invalidation reasons are de-duplicated, capped at 64 diagnostic entries and individually capped at 128
UTF-16 code units. Invalidations raised during execution belong to the next frame. A frame consumes the
current reason set atomically, so mutation while iterating cannot lose a later wake-up.

## Execution

Stages have a stable ID and finite priority. Lower priorities run first; equal priorities preserve
registration order. Time is host-injected and monotonic. Reentrant `advance()` is rejected without
consuming pending invalidations. A failed stage stops later unsafe stages, releases the running guard and
records a trace; it does not claim a rendered frame.

This loop controls frame admission. Existing render-graph and frame-plan contracts continue to own GPU
dependency ordering; this module does not create a second scene or render graph.

## Diagnostics and performance

The hot idle path in demand mode performs no stage work. Diagnostics expose mode, pending reasons,
attempted/rendered counts and the last trace. They do not invent zero-valued performance samples; A03
telemetry remains the authority for measured CPU/GPU/present channels.

## Remaining integration

- Bind Browser RAF and Native redraw requests to the clean-to-dirty return value.
- Feed committed SceneChangeset, camera, animation, resource readiness and data updates into reason codes.
- Connect frame-plan execution and A03 sampling, then verify static-scene idle behavior and animated
  scheduling with real Browser/Native presents.

No R3F/TresJS scene, component, hook, reconciler or runtime compatibility is planned.
