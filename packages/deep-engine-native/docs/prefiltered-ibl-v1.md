# Prefiltered IBL Runtime payload v1

Runtime Packages can embed prepared cube maps and a BRDF LUT as an `ibl-environment` resource. The original builtin reference wire remains unchanged. This is an upload profile for already prepared data, not an HDR decoder or prefilterer.

The payload uses `schema: "deep-engine.ibl-prefiltered"`, `schemaVersion: 1`, the indexed `id` and positive uint32 `revision`, `kind: "prefiltered-hdri"`, `format: "rgba16float"`, `encoding: "base64-le"`, and `faceOrder: "px-nx-py-ny-pz-nz"`. Unknown fields are rejected at every level.

- `source` contains `{ contentHash: { algorithm: "sha256", value: "<lowercase 64 hex>" }, license: "<1..256 UTF-16 units>" }`. This is a source declaration; it does not prove the original HDR bytes. GPU identity uses the resource index's verified payload hash, not this source hash.
- `specular.mips` contains `{ size, dataBase64 }` from a power-of-two size through 1, exactly once per level. `diffuse.mips` contains exactly one such plane.
- `brdfLut` contains `{ width, height, dataBase64 }`, square and power-of-two. All dimensions are 1..2048. Each cube plane has `size² × 6 × 8` bytes; the LUT has `width × height × 8` bytes.
- Base64 is canonical RFC 4648 without whitespace. Bytes are little-endian half floats; all four channels must be finite and nonnegative, allowing negative zero. Shapes and the aggregate decoded 64 MiB budget pass before any base64 scan or decoded buffer allocation.

Native uploads through the existing `GpuIblEnvironment` path. Whole-package drop stages the new IBL and both standard-PBR and ShaderMaterial frame bindings alongside the scene. A synchronous offscreen GPU verification is guarded by resource restoration; only successful cache publication installs the environment. No preview is presented. LKG is saved after the following successful present. One environment is limited to 64 MiB GPU texels; active plus candidate to 128 MiB. These are explicit IBL budgets, separate from the existing scene-cache budget.

`tests/runtime_package_prefiltered_ibl.rs` consumes the shared `runtime-package-prefiltered-ibl-v1.json`. The ignored Windows `package_drop_probe` test exercises the actual drop event chain and same-device HDR comparisons, including same-id/revision payload replacement and failed-candidate rollback. ShaderMaterial comparison removes all unbound instances and asserts zero shader isolation/fallback. The current frozen portable candidate predates this extension; run current source to test it.
