import { DeepApp, PBR_RENDERER_RESOURCE, PbrRendererPlugin } from 'deepmonkey/app';
import { TEMPLATE_FEATURES } from './templates/deep-engine-3d/sceneTypes';
import { createScene } from './scene';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const status = document.querySelector<HTMLElement>('#status')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
const scene = createScene();
let frame = 0, stopped = false, paused = false, elapsed = 0, previous = performance.now();
let dispose: (() => Promise<void>) | undefined;
function resize() {
  const ratio = Math.min(devicePixelRatio, 1.5);
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
}
resize();
try {
  if (!navigator.gpu) throw new Error('当前浏览器无法使用 WebGPU，请使用支持 WebGPU 的浏览器，在 localhost 或 HTTPS 打开。');
  const app = await DeepApp.create({ state: null, plugins: [new PbrRendererPlugin({ canvas, gpu: navigator.gpu,
    packet: scene.packet, renderer: { features: TEMPLATE_FEATURES }, view: () => ({
      eye: scene.eye(elapsed).map((value, axis) => scene.target[axis]! + (value - scene.target[axis]!) * 1.55 * Math.max(1, 1.35 * canvas.height / canvas.width)) as [number, number, number], target: [...scene.target], extent: scene.extent,
      background: [...scene.background], floor: [...scene.floor], exposure: scene.exposure ?? 1.1,
      roughness: scene.roughness ?? .4, width: canvas.width, height: canvas.height, pixelRatio: 1,
    }) })] });
  dispose = () => app.dispose();
  const renderer = app.requireResource(PBR_RENDERER_RESOURCE);
  async function tick(now: number) {
    if (stopped) return;
    if (paused) return;
    elapsed += Math.min(now - previous, 100);
    previous = now;
    const update = scene.update?.(elapsed);
    if (update) renderer.updateInstances(update);
    app.invalidate('scene-animation');
    await app.advance(now);
    status.textContent = `WebGPU · ${scene.packet.instances.length} 个对象`;
    status.dataset.ready = 'true';
    frame = requestAnimationFrame(time => { void tick(time).catch(fail); });
  }
  pause.disabled = false;
  const schedule = () => { previous = performance.now(); frame = requestAnimationFrame(time => { void tick(time).catch(fail); }); };
  pause.onclick = () => { paused = !paused; pause.textContent = paused ? '继续动画' : '暂停动画'; pause.setAttribute('aria-pressed', String(paused)); if (paused) cancelAnimationFrame(frame); else schedule(); };
  const onResize = () => { resize(); if (paused) { app.invalidate('resize'); void app.advance(performance.now()).catch(fail); } };
  window.addEventListener('resize', onResize);
  window.addEventListener('pagehide', () => { stopped = true; cancelAnimationFrame(frame); window.removeEventListener('resize', onResize); void app.dispose(); }, { once: true });
  frame = requestAnimationFrame(time => { void tick(time).catch(fail); });
} catch (error) { fail(error); }
function fail(error: unknown) {
  stopped = true; cancelAnimationFrame(frame); pause.disabled = true;
  void dispose?.().catch(() => {});
  status.textContent = error instanceof Error ? error.message : String(error);
  status.closest('aside')?.classList.add('error');
}
