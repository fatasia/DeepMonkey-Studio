"""Stage a standalone 2D crate from the Native engine's authoritative sources."""
import hashlib
import json
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
NATIVE = ROOT / 'packages/deep-engine-native'
SOURCE = ROOT / 'packages/deep2d'
OUTPUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'artifacts/releases/0.2.0/deepmonkey-2d').resolve()
if OUTPUT.exists():
    raise ValueError('Choose a new output directory')
shutil.copytree(SOURCE, OUTPUT)
shared = OUTPUT / 'src/shared'
shared.mkdir()
shutil.copytree(NATIVE / 'src/deep2d', shared / 'deep2d')
# Retain sibling #[path] modules and their unit tests; only declared roots compile.
for file in list((NATIVE / 'src').glob('deep2d_*.rs')) + [NATIVE / 'src/benchmark_observer.rs']:
    shutil.copyfile(file, shared / file.name)
for module in ['shader_package', 'runtime_package']:
    destination = shared / module
    destination.mkdir()
    shutil.copyfile(NATIVE / f'src/{module}/hash.rs', destination / 'hash.rs')
(shared / 'shader_package/mod.rs').write_text('pub mod hash;\n', encoding='utf-8')
(shared / 'runtime_package/mod.rs').write_text('mod hash;\npub fn runtime_content_sha256(value: &serde_json::Value) -> String { hash::hash_canonical(value) }\n', encoding='utf-8')
# The standalone painter accepts host-provided image atlases. Studio's Windows
# media compositor is a host integration, and is excluded on every platform.
gpu = shared / 'deep2d_gpu.rs'
gpu.write_text(gpu.read_text(encoding='utf-8').replace('#[cfg(windows)]', '#[cfg(any())]').replace('#[cfg(not(windows))]', '#[cfg(all())]'), encoding='utf-8')
include = re.compile(r'(include_(?:str|bytes)!\(\s*)"([^"\n]+)"')
provenance = []
for file in list(shared.rglob('*.rs')):
    original = NATIVE / 'src' / file.relative_to(shared)
    if not original.exists():
        continue
    provenance.append({'source': original.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(original.read_bytes()).hexdigest()})
    def rewrite(match):
        resource = (original.parent / match.group(2)).resolve()
        if not resource.is_file() or not resource.is_relative_to(ROOT):
            raise ValueError(f'Missing or outside resource: {resource}')
        data = resource.read_bytes()
        name = hashlib.sha256(data).hexdigest()[:16] + '-' + resource.name
        destination = OUTPUT / 'resources' / name
        destination.parent.mkdir(exist_ok=True)
        destination.write_bytes(data)
        relative = pathlib.Path(__import__('os').path.relpath(destination, file.parent)).as_posix()
        return match.group(1) + '"' + relative + '"'
    file.write_text(include.sub(rewrite, file.read_text(encoding='utf-8')), encoding='utf-8')
shutil.copytree(NATIVE / 'fixtures', OUTPUT / 'fixtures')
# Default helpers retain their public fixture paths; only 2D fixtures are needed.
for file in list((OUTPUT / 'fixtures').iterdir()):
    if not file.name.startswith('deep2d'):
        if not file.resolve().is_relative_to(OUTPUT / 'fixtures'):
            raise ValueError('Fixture cleanup outside staging directory')
        if file.is_file():
            file.unlink()
        else:
            shutil.rmtree(file)
for name in ['LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md']:
    shutil.copyfile(ROOT / name, OUTPUT / name)
manifest = (OUTPUT / 'Cargo.toml').read_text(encoding='utf-8').replace('license-file = "../../LICENSE"', 'license-file = "LICENSE"').replace('publish = false', 'publish = true')
(OUTPUT / 'Cargo.toml').write_text(manifest, encoding='utf-8')
(OUTPUT / 'source-resources.json').write_text(json.dumps({'sources': provenance, 'adaptations': ['exclude Studio Windows media compositor; retain host image atlas API']}, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'output': str(OUTPUT), 'sources': len(provenance)}))
