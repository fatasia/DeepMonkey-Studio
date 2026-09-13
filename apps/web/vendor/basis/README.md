# Offline Basis Universal encoder

The unmodified single-thread WASM and JavaScript are vendored from `webgl/encoder/build/` at the commit in `provenance.json`; LICENSE is copied from that repository root. The build verifies SHA-256 before copying them to `/basis/`. It appends only `export default BASIS` to an ESM copy so the optimizer's existing module Worker can import it without eval, a CDN or SharedArrayBuffer.

The Three.js KTX2 transcoder is copied from the installed, lockfile-pinned Three package. Both encoder and decoder are deployed with the application. Updates must deliberately replace the fixed source commit, files and hashes together, and repeat the real textured-GLB verification.
