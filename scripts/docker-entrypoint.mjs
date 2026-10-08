import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

if (process.env.BIM_STUDIO_STORAGE_MODE === 'standalone') {
  const directory = process.env.DATA_DIR ?? '/var/lib/studio';
  await mkdir(directory, { recursive: true });
  const credentialsPath = join(directory, 'standalone-credentials.json');
  let credentials;
  try { credentials = JSON.parse(await readFile(credentialsPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    credentials = { adminPassword: process.env.BIM_STUDIO_ADMIN_PASSWORD ?? randomBytes(24).toString('hex'),
      sessionSecret: process.env.BIM_STUDIO_SESSION_SECRET ?? randomBytes(32).toString('hex') };
    await writeFile(credentialsPath, `${JSON.stringify(credentials)}\n`, { flag: 'wx', mode: 0o600 });
  }
  process.env.METADATA_STORE = 'json';
  process.env.OBJECT_STORE = 'local';
  process.env.WEB_ORIGIN ??= 'http://localhost:4100';
  process.env.BIM_STUDIO_ADMIN_PASSWORD ??= credentials.adminPassword;
  process.env.BIM_STUDIO_SESSION_SECRET ??= credentials.sessionSecret;
  console.log(`Standalone storage ready; administrator credentials: ${credentialsPath}`);
}
await import('../apps/api/dist/index.js');
