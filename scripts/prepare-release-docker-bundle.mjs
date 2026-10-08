import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JSZip = createRequire(new URL('../apps/web/package.json', import.meta.url))('jszip');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareDockerDeployment({ manifest, output, repository = root }) {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.savedImages?.length, 3);
  const files = new Map();
  for (const name of ['docker-compose.yml', 'docker-compose.app.yml', 'LICENSE', 'LICENSE.zh-CN.md', 'THIRD_PARTY_NOTICES.md'])
    files.set(name, await readFile(join(repository, name)));
  for (const name of ['start.ps1', 'start.sh']) files.set(name, Buffer.from(
    (await readFile(join(repository, 'scripts/docker-offline', name), 'utf8')).replaceAll('{{VERSION}}', manifest.version)));
  files.set('.env.example', Buffer.from(`STUDIO_VERSION=${manifest.version}
STUDIO_PORT=4100
STUDIO_PUBLIC_ORIGIN=http://localhost:4100
POSTGRES_PORT=5432
POSTGRES_DATABASE=bim_studio
POSTGRES_USER=postgres
POSTGRES_PASSWORD=
MINIO_ROOT_USER=studio-admin
MINIO_ROOT_PASSWORD=
MINIO_API_PORT=9000
MINIO_CONSOLE_PORT=9001
BIM_STUDIO_MINIO_IMAGE=deep-monkey-minio:2025.5.24
BIM_STUDIO_ADMIN_PASSWORD=
BIM_STUDIO_SESSION_SECRET=
BIM_STUDIO_POSTGRES_VOLUME=bim_studio_postgres_data
BIM_STUDIO_MINIO_VOLUME=bim_studio_minio_data
BIM_STUDIO_DATA_VOLUME=bim_studio_application_data
`));
  const imageName = `DeepMonkey-Studio-Docker-${manifest.version}.tar.gz`;
  files.set('docker-images.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  files.set('INSTALL.md', Buffer.from(`# DeepMonkey Studio ${manifest.version} Docker\n\nDownload this deployment ZIP and ${imageName} from the same Release. Extract the ZIP and place the image archive beside start.ps1 / start.sh.\n\nWindows: run PowerShell -File ./start.ps1. Linux: run sh ./start.sh. Docker Engine and Docker Compose are required. The scripts verify SHA-256, load all three images and start with --no-build --pull never.\n\nFirst startup creates .env with random local credentials. Sign in as admin using BIM_STUDIO_ADMIN_PASSWORD from .env. Open http://localhost:4100; edit STUDIO_PORT and STUDIO_PUBLIC_ORIGIN before startup to use another port. Existing .env is preserved.\n\nStop: docker compose -f docker-compose.yml -f docker-compose.app.yml down. Keep the named volumes when upgrading.\n\nSource revision: ${manifest.revision}\n`));
  const records = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
  files.set('SHA256SUMS.txt', Buffer.from(`${manifest.sha256}  ${imageName}\n`
    + records.map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n'));
  await mkdir(output, { recursive: true });
  const stage = join(output, 'docker'); await mkdir(stage, { recursive: true });
  const zip = new JSZip();
  for (const [name, bytes] of files) { await writeFile(join(stage, name), bytes); zip.file(name, bytes); }
  const zipBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  const archive = join(output, `DeepMonkey-Studio-Docker-${manifest.version}-deployment.zip`);
  await writeFile(archive, zipBytes);
  const result = { version: manifest.version, revision: manifest.revision, archive: basename(archive), bytes: zipBytes.length,
    sha256: sha256(zipBytes), imageArchive: imageName, imageSha256: manifest.sha256, files: records };
  await writeFile(archive.replace(/\.zip$/, '.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = resolve(process.argv[2]);
  console.log(JSON.stringify(await prepareDockerDeployment({ manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
    output: process.argv[3] ? resolve(process.argv[3]) : dirname(manifestPath) }), null, 2));
}
