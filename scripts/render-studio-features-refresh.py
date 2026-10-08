"""Replace seven feature chapters with reviewed continuous Astra captures."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('astra_renderer', ROOT / 'scripts/render-studio-astra-intro.py')
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
FPS = 30


def cues(path):
    text = path.read_text(encoding='utf-8-sig').replace('\r\n', '\n')
    return [(renderer.timestamp(a), renderer.timestamp(b), words.strip()) for a, b, words in
            re.findall(r'(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\n(.*?)(?:\n\s*\n|$)', text, re.S)]


def stamp(value, vtt=False):
    ms = max(0, round(value * 1000))
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    seconds, ms = divmod(ms, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02}{'.' if vtt else ','}{ms:03}"


def prepare(folder):
    plan = json.loads((folder / 'features-refresh-plan.json').read_text(encoding='utf-8'))
    edl = json.loads((folder / 'edl.json').read_text(encoding='utf-8'))
    renderer.preparation().check(edl)
    renderer.validate_narration_clock(folder, edl)
    if not edl['identity'].get('modelId') or not edl['identity'].get('deviceId'):
        raise ValueError('Record the shared industrial identity before feature preparation')
    baseline = Path(plan['baseline'])
    if renderer.digest(baseline) != plan['baselineSha256']:
        raise ValueError('Preserved baseline hash changed')
    old_cues, new_cues = cues(baseline.with_suffix('.zh-CN.srt')), cues(folder / 'narration.srt')
    shots = {shot['id']: shot for shot in edl['shots']}
    chapters, subtitles, pending, cursor = [], [], [], 0
    backend = {'S14': 'webgl', 'S15': 'webgpu', 'S16': 'wasm'}
    for chapter in plan['retainedChapters']:
        replacement = next((item for item in plan['replacements'] if abs(item['baselineStart'] - chapter['start']) < .001), None)
        if replacement:
            ids = replacement['shots']
            if replacement['key'] == 'delivery':
                ids = [identity for identity in ids if identity != 'S21']
            selected = [shots[identity] for identity in ids]
            start, end = selected[0]['targetInFrame'] / FPS, selected[-1]['targetOutFrame'] / FPS
            for index, shot in enumerate(selected):
                if index and selected[index - 1]['targetOutFrame'] != shot['targetInFrame']:
                    raise ValueError('Replacement chapter must have contiguous edit windows')
                if not all(shot.get(key) for key in ['source', 'identityVerified', 'visualReviewed']):
                    pending.append({'chapter': replacement['key'], 'shot': shot['id'], 'action': shot['action']})
                    continue
                source = Path(shot['source'])
                if renderer.digest(source) != shot['sourceSha256']:
                    raise ValueError(f"Source hash changed: {shot['id']}")
                span = (shot['targetOutFrame'] - shot['targetInFrame']) / FPS
                if shot['sourceOut'] - shot['sourceIn'] < span or shot['sourceOut'] > float(renderer.probe(source)['format']['duration']) + .04:
                    raise ValueError(f"Source window exceeds real recording: {shot['id']}")
                if shot['id'] in backend and shot['backend'] != backend[shot['id']]:
                    raise ValueError('Actual rendering backend differs from the caption')
            title = {'authoring': '材质、环境与相机时间线',
                     'pipeline': '处理流程：编排与节点调试', 'ontology': '本体图谱：关系与行动',
                     'agent': 'Agent：工具与查询证据'}.get(replacement['key'], chapter['title'])
            item = {'title': title, 'kind': 'replacement', 'key': replacement['key'], 'shots': ids,
                    'inputStart': start, 'inputEnd': end, 'frames': round((end - start) * FPS)}
            selected_cues = new_cues
        else:
            start, end = round(chapter['start'] * FPS) / FPS, round(chapter['end'] * FPS) / FPS
            item = {'title': chapter['title'], 'kind': 'preserved', 'inputStart': start,
                    'inputEnd': end, 'frames': round((end - start) * FPS)}
            selected_cues = old_cues
        item['startFrame'], item['endFrame'] = cursor, cursor + item['frames']
        for a, b, words in selected_cues:
            a, b = max(a, start), min(b, end)
            if a < b:
                subtitles.append((a - start + cursor / FPS, b - start + cursor / FPS, words))
        chapters.append(item)
        cursor += item['frames']
    inputs = [folder / 'edl.json', folder / 'narration-180s.wav', folder / 'narration.srt',
              folder / 'computed-product-tokens.json', Path(__file__), ROOT / 'scripts/render-studio-astra-intro.py',
              ROOT / 'scripts/render-studio-astra-shot-proof.py', baseline.with_suffix('.zh-CN.srt')]
    input_hashes = {str(path): renderer.digest(path) for path in inputs}
    cache_key = hashlib.sha256(json.dumps(input_hashes, sort_keys=True).encode()).hexdigest()
    report = {'ready': not pending, 'pending': pending, 'totalFrames': cursor, 'seconds': cursor / FPS,
              'baseline': str(baseline), 'baselineSha256': plan['baselineSha256'], 'chapters': chapters,
              'edlSha256': renderer.digest(folder / 'edl.json'), 'inputHashes': input_hashes,
              'cacheKey': cache_key, 'sourcePolicy': plan['sourcePolicy']}
    (folder / 'features-refresh-readiness.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report, subtitles


def render(folder, output, report, subtitles):
    if not report['ready']:
        raise ValueError('Continuous captures are still missing; see features-refresh-readiness.json')
    if output.exists():
        raise ValueError('Choose a new output filename; preserve previous videos')
    work = folder / ('features-render-' + report['cacheKey'][:12])
    work.mkdir(exist_ok=True)
    picture, sound, sources, metadata = [], [], [], [';FFMETADATA1', 'title=DeepMonkey Studio：功能介绍']
    for index, chapter in enumerate(report['chapters']):
        source, start = Path(report['baseline']), chapter['inputStart']
        if chapter['kind'] == 'replacement':
            source = work / f"replacement-{chapter['key']}.mp4"
            if not source.exists():
                renderer.run([sys.executable, str(ROOT / 'scripts/render-studio-astra-shot-proof.py'),
                              '--shots', *chapter['shots'], '--folder', str(folder), '--output', str(source)])
            start = 0
        video, audio = work / f'{index:02}.mp4', work / f'{index:02}.wav'
        duration = chapter['frames'] / FPS
        if not video.exists():
            renderer.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1',
                          '-ss', str(start), '-i', str(source), '-an', '-vf', 'fps=30,setsar=1,format=yuv420p',
                          '-frames:v', str(chapter['frames']), '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18', str(video)])
        if not audio.exists():
            renderer.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1',
                          '-ss', str(start), '-i', str(source), '-vn', '-af', f'aresample=48000,apad,atrim=duration={duration}',
                          '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', str(audio)])
        info = renderer.probe(video)
        stream = next(item for item in info['streams'] if item['codec_type'] == 'video')
        if int(stream['nb_frames']) != chapter['frames'] or stream['avg_frame_rate'] != '30/1':
            raise ValueError('Chapter does not match the new edit clock')
        picture.append(video); sound.append(audio)
        sources.append({**chapter, 'source': str(source), 'sourceSha256': renderer.digest(source)})
        metadata += ['[CHAPTER]', 'TIMEBASE=1/1000', f"START={round(chapter['startFrame'] / FPS * 1000)}",
                     f"END={round(chapter['endFrame'] / FPS * 1000)}", f"title={chapter['title']}"]
    for name, files in [('picture', picture), ('sound', sound)]:
        (work / f'{name}.ffconcat').write_text('ffconcat version 1.0\n' + '\n'.join(f"file '{file.name}'" for file in files) + '\n', encoding='utf-8')
    (work / 'chapters.ffmeta').write_text('\n'.join(metadata) + '\n', encoding='utf-8')
    renderer.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1',
                  '-f', 'concat', '-safe', '0', '-i', 'picture.ffconcat', '-f', 'concat', '-safe', '0', '-i', 'sound.ffconcat',
                  '-f', 'ffmetadata', '-i', 'chapters.ffmeta', '-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2',
                  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
                  '-af', 'loudnorm=I=-16:TP=-1:LRA=9', '-t', str(report['seconds']), '-movflags', '+faststart', str(output)], cwd=work)
    info = renderer.probe(output)
    stream = next(item for item in info['streams'] if item['codec_type'] == 'video')
    if int(stream['nb_frames']) != report['totalFrames'] or len(info['chapters']) != len(report['chapters']) or abs(float(info['format']['duration']) - report['seconds']) > .08:
        raise ValueError('Final chapter/frame validation failed')
    renderer.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-xerror', '-threads', '2', '-i', str(output), '-f', 'null', '-'])
    for extension in ['srt', 'vtt']:
        lines = ['WEBVTT\n'] if extension == 'vtt' else []
        for index, (a, b, words) in enumerate(subtitles, 1):
            lines += [str(index), f"{stamp(a, extension == 'vtt')} --> {stamp(b, extension == 'vtt')}", words, '']
        output.with_suffix(f'.zh-CN.{extension}').write_text('\n'.join(lines), encoding='utf-8')
    output.with_suffix('.evidence.json').write_text(json.dumps({'sha256': renderer.digest(output), 'probe': info,
        'baselineSha256': report['baselineSha256'], 'edlSha256': report['edlSha256'], 'inputHashes': report['inputHashes'], 'chapters': sources,
        'fullDecode': 'passed', 'visualAcceptance': 'two complete picture reviews pending'}, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, default=renderer.DEFAULT)
    parser.add_argument('--render', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    report, subtitles = prepare(args.folder)
    print(json.dumps({'ready': report['ready'], 'seconds': report['seconds'],
                      'pending': [{key: item[key] for key in ['chapter', 'shot']} for item in report['pending']]}))
    if args.render:
        output = (args.output or args.folder.parent / 'deepmonkey-studio-features-refreshed.mp4').resolve()
        render(args.folder.resolve(), output, report, subtitles)
