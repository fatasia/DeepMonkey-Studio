"""Stage crates.io packages from the engine sources without changing source manifests."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'artifacts/releases/0.2.0/registry-rust').resolve()
INCLUDE = re.compile(r'(include_(?:str|bytes)!\(\s*)"([^"\n]+)"')


def stage(relative, name):
    source = ROOT / relative
    target = OUTPUT / name
    if target.exists():
        raise ValueError(f'Use a new output directory: {target}')
    target.mkdir(parents=True)
    for directory in ['src', 'assets', 'fixtures', 'tests']:
        if (source / directory).exists():
            shutil.copytree(source / directory, target / directory)
    for filename in ['LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md']:
        shutil.copyfile(ROOT / filename, target / filename)
    text = (source / 'Cargo.toml').read_text(encoding='utf-8')
    old_name = re.search(r'^name = "([^"]+)"', text, re.M).group(1)
    text = text.replace(f'name = "{old_name}"', f'name = "{name}"', 1)
    text = re.sub(r'^license-file = .+$', 'license-file = "LICENSE"', text, flags=re.M)
    text = text.replace('publish = false', 'publish = true\nreadme = "README.md"\nautobins = false')
    if 'repository =' not in text:
        text = text.replace('[package]', '[package]\nrepository = "https://github.com/fatasia/DeepMonkey-Studio"\nhomepage = "https://github.com/fatasia/DeepMonkey-Studio"')
    if name == 'deepmonkey-native':
        text = text.replace('geometry_dag = { path = "geometry_dag" }', 'geometry_dag = { package = "deepmonkey-geometry", version = "=0.1.0" }')
        text += '\n[lib]\nname = "deepmonkey_native"\npath = "src/lib.rs"\n\n[[bin]]\nname = "deepmonkey-native"\npath = "src/main.rs"\n'
    else:
        text = text.replace('name = "geometry_dag"\npath = "src/bin/geometry_dag.rs"', 'name = "deepmonkey-geometry"\npath = "src/bin/geometry_dag.rs"')
    (target / 'Cargo.toml').write_text(text, encoding='utf-8')
    if (source / 'Cargo.lock').exists():
        shutil.copyfile(source / 'Cargo.lock', target / 'Cargo.lock')
    resources = []
    for file in list(target.rglob('*.rs')):
        original_file = source / file.relative_to(target)
        code = file.read_text(encoding='utf-8')

        def rewrite(match):
            resource = (original_file.parent / match.group(2)).resolve()
            if not resource.is_file():
                raise ValueError(f'Missing include resource: {original_file}: {match.group(2)}')
            if resource.is_relative_to(source) and (target / resource.relative_to(source)).is_file():
                return match.group(0)
            if not resource.is_relative_to(ROOT):
                raise ValueError(f'Include escapes repository: {resource}')
            data = resource.read_bytes()
            sha = hashlib.sha256(data).hexdigest()
            destination = target / 'vendored' / (sha[:16] + '-' + resource.name)
            destination.parent.mkdir(exist_ok=True)
            destination.write_bytes(data)
            resources.append({'source': resource.relative_to(ROOT).as_posix(), 'sha256': sha})
            return match.group(1) + '"' + os.path.relpath(destination, file.parent).replace('\\', '/') + '"'

        code = INCLUDE.sub(rewrite, code)
        if name == 'deepmonkey-native':
            code = code.replace('deep_engine_native::', 'deepmonkey_native::')
        file.write_text(code, encoding='utf-8')
    shutil.copyfile(source / 'README.crates.md', target / 'README.md')
    (target / 'source-resources.json').write_text(json.dumps(resources, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'name': name, 'output': str(target), 'vendoredResources': len(resources)}))


stage('packages/deep-engine-native/geometry_dag', 'deepmonkey-geometry')
stage('packages/deep-engine-native', 'deepmonkey-native')
