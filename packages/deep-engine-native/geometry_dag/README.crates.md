# deepmonkey-geometry

Offline meshlet-DAG compiler and `.dgc` reader for the DeepMonkey 3D engine. Converts OBJ meshes into hierarchical geometry clusters for streaming and LOD selection.

[DeepMonkey](https://github.com/fatasia/DeepMonkey-Studio) · [Engine documentation](https://github.com/fatasia/DeepMonkey-Studio/tree/main/packages/deep-engine-native/geometry_dag)

## Install and use

Requires Rust 1.93+.

```sh
cargo install deepmonkey-geometry --version 0.1.0 --locked
deepmonkey-geometry build model.obj model.dgc
deepmonkey-geometry info model.dgc
deepmonkey-geometry verify model.dgc
```

`build` partitions a mesh into clusters, constructs the hierarchy and writes the stream. Options include `--levels`, `--max-triangles`, `--max-vertices`, `--no-compress` and `--quiet`. `info` prints summaries; `verify` parses the full stream and checks CRCs, returning exit code 0 on success.

## Rust library

```toml
[dependencies]
geometry_dag = { package = "deepmonkey-geometry", version = "0.1.0" }
```

The library name remains `geometry_dag`. It is also used by `deepmonkey-native`. This package is a geometry tool; start the Studio editor with `npx deepmonkey` instead.

## License

See `LICENSE`, `LICENSE.zh-CN.md` and `THIRD_PARTY_NOTICES.md` included in the crate.
