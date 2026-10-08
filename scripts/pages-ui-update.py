"""Package/deploy the Pages UI while retaining the frozen 0.2.0 demo resources."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import zipfile

ENTRY_FILES = {'index.html', '404.html', '.nojekyll', 'editor-hosting.json', 'demo/workspace.json', '.vite/manifest.json'}
MAX_BYTES = 150_000_000


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def allowed(name):
    path = pathlib.PurePosixPath(name)
    return (not path.is_absolute() and '\\' not in name and '..' not in path.parts
            and path.as_posix() == name
            and (name in ENTRY_FILES or name.startswith('assets/')))


def inspect_archive(archive):
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    if len(set(names)) != len(names) or not ENTRY_FILES.issubset(names):
        raise ValueError('Missing or duplicate UI entries')
    if any(not allowed(entry.filename) or entry.is_dir() or (entry.external_attr >> 16) & 0o170000 == 0o120000 for entry in entries):
        raise ValueError('Unsafe UI archive entry')
    size = sum(entry.file_size for entry in entries)
    if size > MAX_BYTES:
        raise ValueError('UI update exceeds size budget')
    host = json.loads(archive.read('editor-hosting.json'))
    workspace = json.loads(archive.read('demo/workspace.json'))
    if host.get('productionDeployment') != 'browser-local-demo' or host.get('apiOrigin') is not None:
        raise ValueError('UI update must be a browser-local demo')
    if workspace.get('schemaVersion') != 1 or workspace.get('defaultPath') != '/':
        raise ValueError('UI update must open the project workspace')
    return len(entries), size


def pack(site, base_archive, output, manifest_path, revision):
    if not re.fullmatch('[0-9a-f]{40}', revision):
        raise ValueError('A full Git revision is required')
    paths = sorted(path for path in site.rglob('*') if path.is_file() and allowed(path.relative_to(site).as_posix()))
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in paths:
            if path.is_symlink():
                raise ValueError('Symlinks are not supported')
            archive.write(path, path.relative_to(site).as_posix())
    with zipfile.ZipFile(output) as archive:
        count, size = inspect_archive(archive)
    manifest = {'schemaVersion': 1, 'sourceRevision': revision, 'baseEditorSha256': digest(base_archive),
                'uiSha256': digest(output), 'files': count, 'expandedBytes': size}
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(manifest))


def apply(site, base_archive, update, manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('schemaVersion') != 1 or not re.fullmatch('[0-9a-f]{40}', manifest.get('sourceRevision', '')):
        raise ValueError('Invalid UI update manifest')
    if digest(base_archive) != manifest.get('baseEditorSha256') or digest(update) != manifest.get('uiSha256'):
        raise ValueError('UI update or base editor checksum mismatch')
    with zipfile.ZipFile(update) as archive:
        count, size = inspect_archive(archive)
        if (count, size) != (manifest.get('files'), manifest.get('expandedBytes')):
            raise ValueError('UI update size mismatch')
        original = json.loads((site / 'demo/workspace.json').read_text(encoding='utf-8'))
        revised = json.loads(archive.read('demo/workspace.json'))
        if {k: v for k, v in original.items() if k != 'defaultPath'} != {k: v for k, v in revised.items() if k != 'defaultPath'}:
            raise ValueError('UI update changes frozen demo data')
        for entry in archive.infolist():
            target = (site / entry.filename).resolve()
            if not target.is_relative_to(site) or target.is_symlink():
                raise ValueError('Unsafe UI destination')
        # Validate compressed data before replacing the active entry point.
        if archive.testzip() is not None:
            raise ValueError('Corrupt UI archive')
        assets = site / 'assets'
        if assets.is_symlink() or not assets.resolve().is_relative_to(site):
            raise ValueError('Unsafe asset directory')
        if assets.exists():
            shutil.rmtree(assets)
        archive.extractall(site)
    (site / 'pages-ui-version.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'applied': True, 'revision': manifest['sourceRevision'], 'expandedBytes': size}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['pack', 'apply'])
    parser.add_argument('site', type=pathlib.Path)
    parser.add_argument('base_archive', type=pathlib.Path)
    parser.add_argument('update', type=pathlib.Path)
    parser.add_argument('manifest', type=pathlib.Path)
    parser.add_argument('--revision')
    args = parser.parse_args()
    if args.mode == 'pack':
        pack(args.site.resolve(), args.base_archive, args.update, args.manifest, args.revision or '')
    else:
        apply(args.site.resolve(), args.base_archive, args.update, args.manifest)


if __name__ == '__main__':
    main()
