#!/usr/bin/env node
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('create-deepmonkey <directory> [--template 02-factory-floor] [--no-install] [--no-start] [--no-open]');
  process.exit(0);
}
const templateIndex = args.indexOf('--template');
const template = templateIndex < 0 ? '02-factory-floor' : args[templateIndex + 1];
const templates = ['01-starter', '02-factory-floor', '03-equipment-monitor', '04-robot-cell', '05-pipeline', '06-logistics', '07-energy', '08-structure'];
if (!templates.includes(template)) throw new Error(`Choose a template: ${templates.join(', ')}`);
const positional = args.filter((arg, index) => !arg.startsWith('--') && (templateIndex < 0 || index !== templateIndex + 1));
const target = resolve(positional[0] ?? 'my-world');
const existing = await readdir(target).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
if (existing.length) throw new Error(`Directory is not empty: ${target}`);
await mkdir(target, { recursive: true });
const payload = fileURLToPath(new URL('../payload/', import.meta.url));
await cp(payload, target, { recursive: true });
const packageName = basename(target).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '') || 'my-world';
await writeFile(join(target, 'package.json'), JSON.stringify({ name: packageName, version: '0.0.0', private: true, type: 'module',
  scripts: { dev: 'vite --host 127.0.0.1', start: 'vite --host 127.0.0.1', build: 'tsc --noEmit && vite build', typecheck: 'tsc --noEmit' },
  dependencies: { deepmonkey: 'file:vendor/deepmonkey-0.2.1.tgz', fflate: 'file:vendor/fflate-0.8.3.tgz' },
  devDependencies: { '@webgpu/types': 'file:vendor/webgpu-types-0.1.72.tgz', '@types/node': '24.10.0', typescript: '5.9.3', vite: '8.1.0' }
}, null, 2) + '\n');
await writeFile(join(target, 'scene.ts'), `export { createScene } from './templates/deep-engine-3d/templates/${template}/scene';\n`);
console.log(`Created ${target}\nTemplate: ${template}\nCodex: $deep-engine-3d\nClaude Code: /deep-engine-3d`);
async function npm(command) {
  const cli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const executable = cli?.endsWith('.js') ? process.execPath : 'npm';
  const parameters = cli?.endsWith('.js') ? [cli, ...command] : command;
  const child = spawn(executable, parameters, { cwd: target, stdio: 'inherit', windowsHide: true,
    shell: !cli?.endsWith('.js') && process.platform === 'win32' });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code) throw new Error(`npm ${command[0]} exited with ${code}. Continue from ${target}.`);
}
if (!args.includes('--no-install')) await npm(['install', '--no-audit', '--no-fund']);
if (!args.includes('--no-start') && !args.includes('--no-install')) await npm(['run', 'dev', '--', ...(args.includes('--no-open') ? [] : ['--open'])]);
else console.log(`cd ${target}\nnpm install\nnpm run dev`);
