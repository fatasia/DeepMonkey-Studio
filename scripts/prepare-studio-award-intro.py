"""Prepare natural narration, variable chapters and actual word-boundary captions for award v2."""
import argparse
import asyncio
import importlib.util
import json
import math
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'deliverables/studio-020-20261007/intro-award-v2-20261008'
PLAN = ROOT / 'docs/assets/studio-020/intro-astra-236s-director-script.md'
spec = importlib.util.spec_from_file_location('astra_preparation', ROOT/'scripts/prepare-studio-astra-intro.py')
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)
voice.OUT = OUT
EDITS = {
    'P06': '二维画布可以组织组件、数据和三维视口。数据既能成为看板上的指标，也能作为空间对象的属性来源。画面、数值与现场，在同一份工程里组织。',
    'P08': 'AI因此能够带着工程上下文工作。它读取对象和数据，调用工具，给出有来源的结果。运行过程和查询证据，都可以展开查看。',
    'P09': '从理解，走向行动。事件、动作与脚本，在同一份工程中组织起来。简单规则可以配置，复杂逻辑可以编写，把业务经验整理成可复用的行为。',
    'P10': '当问题需要推演，工程也能保留条件和结果。在这个工况示例里，输入条件与推演结果一起保留，让下一次判断有依据。这也是我们走向AI for Science的起点。',
    'P13': '这套能力，也可以离开编辑器。引擎SDK、场景接口、插件和MCP，让自己的应用接入渲染、数据与行动。这里，场景接口读出工程，独立Viewer继续运行。上层自由创作，底层可以复用。',
    'P14': '再把工程交给使用它的人。发布后，场景在浏览器中独立运行。Windows客户端、离线运行包与Docker部署，是工程走向个人和团队的交付方式。一份创作，走进下一段工作。',
}


def plan():
    rows = []
    for line in PLAN.read_text(encoding='utf-8').splitlines():
        match = re.match(r'\| (P\d{2}) / (\d{2}):(\d{2})–(\d{2}):(\d{2}) \| (.*?) \|', line)
        if match:
            identity, a, b, c, d, text = match.groups()
            rows.append({'id': identity, 'text': EDITS.get(identity, text),
                         'plannedSeconds': (int(c)*60+int(d))-(int(a)*60+int(b))})
    if [r['id'] for r in rows] != [f'P{i:02}' for i in range(1,16)]:
        raise ValueError('Director script must contain 15 ordered narration paragraphs')
    return rows


async def prepare():
    OUT.mkdir(exist_ok=True)
    (OUT/'audio').mkdir(exist_ok=True)
    old = json.loads((OUT/'edl.json').read_text(encoding='utf-8')) if (OUT/'edl.json').exists() else None
    paragraphs, chapters, schedule, cursor = plan(), [], [], 0
    for paragraph in paragraphs:
        item = await voice.make_voice({**paragraph, 'spoken': voice.spoken(paragraph['text'])})
        frames = max(round(paragraph['plannedSeconds']*30), math.ceil((item['duration']+1.5)*30))
        start = cursor/30 + (2 if paragraph['id']=='P01' else .3)
        if start+item['duration'] > (cursor+frames)/30-.3:
            frames = math.ceil((start-cursor/30+item['duration']+.5)*30)
        schedule.append({**item, 'start': start, 'end': start+item['duration']})
        previous = next((c for c in old['chapters'] if c['id']==paragraph['id']), None) if old else None
        segments = previous['sourceSegments'] if previous and sum(s['frames'] for s in previous['sourceSegments']) == frames else [
            {'id': 'pending', 'kind': 'footage', 'frames': frames, 'source': None, 'semanticRole': paragraph['text']}]
        chapters.append({'id': paragraph['id'], 'title': paragraph['text'].split('。')[0], 'targetInFrame': cursor,
                         'targetOutFrame': cursor+frames, 'sourceSegments': segments})
        cursor += frames
        print(f"{item['id']}: {item['duration']:.3f}s natural, chapter {frames/30:.3f}s", flush=True)
    voice.save(OUT/'narration-timing.json', {'rate': '+0%', 'entries': schedule})
    cues = [cue for item in schedule for cue in voice.timed_captions(item)]
    voice.save(OUT/'caption-cues.json', cues)
    for extension in ['srt', 'vtt']:
        lines = ['WEBVTT\n'] if extension=='vtt' else []
        for index, cue in enumerate(cues, 1):
            lines += [str(index), f"{voice.stamp(cue['start'],extension=='vtt')} --> {voice.stamp(cue['end'],extension=='vtt')}", cue['text'], '']
        (OUT/f'narration.{extension}').write_text('\n'.join(lines), encoding='utf-8')
    inputs, filters = [], []
    for i, item in enumerate(schedule):
        inputs += ['-i', item['audio']]
        filters.append(f"[{i}:a]aresample=48000,adelay={round(item['start']*1000)}:all=1[a{i}]")
    seconds = cursor/30
    filters.append(''.join(f'[a{i}]' for i in range(len(schedule)))+f'amix=inputs={len(schedule)}:normalize=0,apad,atrim=duration={seconds}[out]')
    audio = OUT/'narration.wav'
    subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-threads','2','-filter_complex_threads','2',*inputs,
                    '-filter_complex',';'.join(filters),'-map','[out]','-c:a','pcm_s16le','-ar','48000','-ac','1',str(audio)],check=True)
    if abs(voice.duration(audio)-seconds)>.001:
        raise ValueError('Narration PCM clock differs from chapter frames')
    edl = {'schema': 'studio-film-segments.v1', 'fps': 30, 'totalFrames': cursor, 'chapters': chapters,
           'identity': old['identity'] if old else json.loads((OUT.parent/'intro-astra/edl.json').read_text(encoding='utf-8'))['identity'],
           'plan': str(PLAN), 'planSha256': voice.sha(PLAN), 'narration': {'source': str(audio),'sha256': voice.sha(audio),
           'captionSha256': voice.sha(OUT/'caption-cues.json')}}
    voice.save(OUT/'edl.json',edl)
    (OUT/'narration.md').write_text('# 系统介绍 v2 · 自然旁白\n\n'+'\n\n'.join(f"{p['id']} · {p['text']}" for p in paragraphs),encoding='utf-8')
    shutil.copyfile(OUT.parent/'intro-astra/computed-product-tokens.json',OUT/'computed-product-tokens.json')
    print(json.dumps({'seconds':seconds,'frames':cursor,'spokenSeconds':sum(x['duration'] for x in schedule),'cues':len(cues)}))


if __name__=='__main__':
    asyncio.run(prepare())
