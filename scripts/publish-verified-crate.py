"""Upload an already cargo-verified .crate over the official HTTP/1 registry API.

Workaround for hosts whose Cargo HTTP/2 publishing upload fails. Credentials are
read locally and never written to output. Run cargo publish --dry-run first.
"""
import json
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import tomllib
import urllib.error
import urllib.request

manifest = pathlib.Path(sys.argv[1]).resolve()
crate = pathlib.Path(sys.argv[2]).resolve()
metadata = json.loads(subprocess.check_output([
    'cargo', 'metadata', '--no-deps', '--format-version', '1',
    '--manifest-path', str(manifest),
], encoding='utf-8'))['packages'][0]
name, version = metadata['name'], metadata['version']
if crate.name != f'{name}-{version}.crate':
    raise ValueError('Archive must match manifest name and version')
endpoint = f'https://crates.io/api/v1/crates/{name}/{version}'
try:
    with urllib.request.urlopen(urllib.request.Request(endpoint, headers={'User-Agent': 'DeepMonkey-Release/0.2.0 (https://github.com/fatasia/DeepMonkey-Studio)'}), timeout=30) as response:
        if response.status == 200:
            print(f'{name} {version} already published')
            sys.exit(0)
except urllib.error.HTTPError as error:
    if error.code != 404:
        raise
deps = []
for item in metadata['dependencies']:
    deps.append({
        'name': item['name'], 'version_req': item['req'],
        'features': item['features'], 'optional': item['optional'],
        'default_features': item['uses_default_features'],
        'target': item['target'], 'kind': item['kind'] or 'normal',
        'registry': None, 'explicit_name_in_toml': item['rename'],
    })
payload = {key: metadata.get(key) for key in [
    'authors', 'description', 'documentation', 'homepage', 'keywords',
    'categories', 'license', 'license_file', 'repository', 'links', 'rust_version',
]}
payload.update(name=name, vers=version, deps=deps, features=metadata['features'],
               readme=(manifest.parent / 'README.md').read_text(encoding='utf-8'),
               readme_file='README.md', badges={})
encoded = json.dumps(payload).encode('utf-8')
archive = crate.read_bytes()
body = struct.pack('<I', len(encoded)) + encoded + struct.pack('<I', len(archive)) + archive
token = os.environ.get('CARGO_REGISTRY_TOKEN')
if not token:
    home = pathlib.Path(os.environ.get('CARGO_HOME', pathlib.Path.home() / '.cargo'))
    credentials = tomllib.loads((home / 'credentials.toml').read_text(encoding='utf-8'))
    token = credentials['registry']['token']
request = urllib.request.Request('https://crates.io/api/v1/crates/new', data=body,
    method='PUT', headers={'Authorization': token, 'Accept': 'application/json',
        'Content-Type': 'application/octet-stream', 'User-Agent': 'DeepMonkey-Release/0.2.0 (https://github.com/fatasia/DeepMonkey-Studio)'})
try:
    with urllib.request.urlopen(request, timeout=180) as response:
        result = json.load(response)
except urllib.error.HTTPError as error:
    print(f'Registry HTTP {error.code}: {error.read().decode("utf-8")[:2000]}')
    sys.exit(1)
except urllib.error.URLError:
    with tempfile.TemporaryDirectory(prefix='deepmonkey-registry-') as directory:
        upload = pathlib.Path(directory) / 'upload.bin'
        upload.write_bytes(body)
        escaped_token = token.replace('\\', '\\\\').replace('"', '\\"')
        config = f'header = "Authorization: {escaped_token}"\n'
        response = subprocess.run(['curl.exe' if os.name == 'nt' else 'curl',
            '--http1.1', '--silent', '--show-error', '--fail-with-body',
            '--max-time', '180', '--request', 'PUT', '--url', request.full_url,
            '--header', 'Content-Type: application/octet-stream',
            '--header', 'Accept: application/json', '--header', 'Expect: 100-continue',
            '--user-agent', 'DeepMonkey-Release/0.2.0 (https://github.com/fatasia/DeepMonkey-Studio)',
            '--data-binary', '@' + str(upload), '--config', '-'],
            input=config, text=True, capture_output=True, encoding='utf-8')
        if response.returncode:
            print(f'Registry upload failed: {response.stderr[:1000]} {response.stdout[:1000]}')
            sys.exit(1)
        result = json.loads(response.stdout)
print(json.dumps({'name': name, 'version': version, 'result': result}))
