# Native Asset Directory Profile v1

This Windows profile reads the existing Deep Asset Package v1 envelope and executes its entry scene through the Runtime Package Player. It does not change the TypeScript manifest schema.

- `manifest.json` contains the full `{schemaVersion, manifest, blobs}` envelope.
- Each declared blob is stored at `blobs/<lowercase-sha256>` with no extension. Logical paths never locate files.
- The entry resource is `kind: scene`; its blob media type is `application/vnd.deep.runtime-package+json`. Its bytes must independently pass the Runtime Package contract.
- All declared blobs are read and SHA-256/byte-length checked before execution, with a 256 MiB aggregate chunk budget. Manifest parsing is bounded; duplicate JSON keys, invalid DAGs, duplicate paths and untrusted filesystem indirection are rejected.
- Metadata/license evidence below is required for the entry scene. This is evidence binding, not automatic legal clearance or a replacement for formal provenance/migration work.

## License evidence

A `metadata` resource with media type `application/vnd.deep.asset-license+json` contains exactly:

```json
{
  "schemaVersion": 1,
  "packageId": "matching-manifest-package-id",
  "sourceHash": "matching-manifest-source-sha256",
  "resourceIds": ["scene/main"],
  "licenseId": "LicenseRef-Deep-Monkey-Community-1.0",
  "licenseTextHash": "sha256-of-declared-license-text-blob"
}
```

`resourceIds` is sorted/unique and references declared resources. At least one evidence record covers `entryScene`. The record must depend on the resource containing the referenced nonempty UTF-8 license text. The evidence object is capped at 64 KiB and license text at 1 MiB. Unknown fields are rejected.

The shared fixture is first-party `runtime-package-v1.json`, governed by the repository LICENSE. Its source bytes and the real LICENSE text are separate content-addressed blobs; the third blob binds their hashes. The scene depends on the license evidence, which depends on the license text. No external model or third-party license is invented.

## Run and verify

```powershell
cargo run --locked -- --asset-package tests/fixtures/asset-directory-v1/manifest.json
cargo test --locked --test asset_package_directory -- --include-ignored
node scripts/verify-asset-package-golden.mjs
```

The JS check consumes the same on-disk fixture with the built TypeScript validator; build `@bim-studio/deep-engine` first. `build-asset-package-fixture.mjs` reproducibly regenerates the fixture from the repository Runtime Package and LICENSE.

## Recovery

Normal `--asset-package` opens the source first. After a verified GPU submission and first present, it writes the exact validated manifest and all chunks into a source-path-scoped directory under `%LOCALAPPDATA%/DeepEngineNative/asset-recovery`. A file lock serializes writers. Snapshot files are synced and revalidated through the complete directory loader before the active index is atomically replaced. Headless preflight never publishes a recovery record.

If the original manifest or any chunk is broken, a later process may recover only the active snapshot associated with that same absolute source path. It rechecks manifest identity, every chunk and license evidence. Diagnostics and the window title identify recovery. Cache write failure leaves the displayed source scene usable and the old index intact. Failed candidates are removed using only their known generated files; there is no recursive deletion. Active and previous snapshots are retained; old verified generated directories are retired after successful publication. Unknown files and source files are not removed; deferred retirement is reported.

## Drag and drop (source after the candidate build)

The ordinary Viewer accepts one Asset Directory folder or its `manifest.json`, as well as ordinary Runtime Package JSON. A valid Runtime Package named `manifest.json` remains accepted. One drag containing multiple paths is rejected; hover cancellation does not start a read. The existing latest-request mailbox coalesces background work and discards stale results. All directory bytes, dependencies and license evidence use the same loader as the CLI.

The existing device stages scene, Deep2D and IBL candidates, validates a full GPU frame into a temporary offscreen target, restores active resources through a drop guard, then commits through the existing scene-cache publication path. It does not create a second surface/device for the same window. Failed validation or commit retains active CPU content and requests its redraw; no candidate preview is presented or recorded as LKG. The new source checkpoint is written only after an actual successful present. Builtin and [prefiltered IBL payloads](prefiltered-ibl-v1.md) can switch on the same device; changed payload hashes refresh bindings even with unchanged environment id and revision. Live RenderPacket updates still require an unchanged environment; this extension covers whole-package drag and drop.

`app::package_drop_probe_tests::asset_directory_drop_events_publish_only_validated_frames` runs real offscreen winit events and RTX 4060 GPU work with isolated LOCALAPPDATA. It covers multi-path/cancellation/missing source retention, unsupported IBL identity and zero-sized rejection, folder/manifest/Runtime switching, and checkpoints after present. Existing queue tests cover burst coalescing, stale failures, retries and closing with reads pending.

The `windows-portable-author-lod-recovery` candidate includes the directory profile and complete LKG but predates this drag/drop adapter. Its immutable ZIP remains unchanged; rebuild is required to ship these source changes.

## Remaining boundaries

This profile executes a self-contained Runtime Package scene; it does not bind separate mesh/texture blobs into the renderer. Chunk verification, license consumption and dependency ordering are real, but separate geometry/texture streaming, reimport publication, version migration and formal provenance remain unfinished. Unsupported scene encodings fail explicitly. GPU initialization-failure fallback is not covered. Non-Windows NFC validation currently accepts ASCII only; this profile targets Windows.
