import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

/** npm performs registry selection, integrity verification, retries and content-addressed caching. */
export async function installRegistryRuntime(manifest, runtime, cache, npmCli) {
  for (const item of manifest.npmPackages) {
    if (!/^[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+$/.test(item.package) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid runtime package manifest');
    const directory = join(cache, 'packages', item.sha256);
    await mkdir(directory, { recursive: true });
    const payload = join(directory, 'runtime.tar.gz');
    let verified = false;
    try { verified = await digest(payload) === item.sha256; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!verified) {
      console.log(`Installing ${item.package} (${Math.ceil(item.bytes / 1e6)} MB) from your npm registry…`);
      let packed;
      try {
        const result = await run(process.execPath, [npmCli, 'pack', item.package, '--ignore-scripts', '--json', '--pack-destination', directory,
          '--fetch-timeout=300000', '--fetch-retries=3'], { maxBuffer: 4 * 1024 ** 2, windowsHide: true });
        const info = JSON.parse(result.stdout); packed = info[0]?.filename;
      } catch (error) {
        throw new Error(`Could not install ${item.package}. Check your npm registry/proxy, then rerun; completed packages remain cached.\n${error.stderr ?? error.message}`);
      }
      if (!packed || basename(packed) !== packed) throw new Error('Invalid npm archive path');
      const archive = join(directory, packed);
      await run('tar', ['-xzf', archive, '-C', directory, 'package/runtime.tar.gz'], { windowsHide: true });
      const extracted = join(directory, 'package/runtime.tar.gz');
      if (await digest(extracted) !== item.sha256) throw new Error('Runtime package checksum mismatch');
      await rename(extracted, payload); await rm(archive, { force: true });
    } else console.log(`Using cached ${item.package}`);
    const listing = await run('tar', ['-tzf', payload], { maxBuffer: 16 * 1024 ** 2, windowsHide: true });
    if (listing.stdout.split(/\r?\n/).filter(Boolean).some(path => path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').includes('..'))) throw new Error('Unsafe runtime archive path');
    console.log(`Preparing ${item.package}…`);
    await run('tar', ['-xzf', payload, '-C', runtime], { windowsHide: true });
  }
}
