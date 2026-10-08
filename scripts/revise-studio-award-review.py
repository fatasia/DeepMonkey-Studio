"""Preserve first export and apply the two final independent review corrections."""
import copy
import json
import os
import hashlib
from pathlib import Path
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parent.parent
BASE=ROOT/'deliverables/studio-020-20261007/intro-award-v2-20261008'
OUT=BASE/'review-revision'
OUT.mkdir(exist_ok=True)
for name in ['computed-product-tokens.json','caption-cues.json','narration-timing.json']:
    (OUT/name).write_bytes((BASE/name).read_bytes())
edl=json.loads((BASE/'edl.json').read_text(encoding='utf-8'))
agent=next(c for c in edl['chapters'] if c['id']=='P08')['sourceSegments'][2]
assert agent['id']=='agent-2' and agent['frames']==120
agent.pop('crop')
agent['overlays']=[
    {'text':'18 条运行记录','style':'Title','position':[545,380]},
    {'text':'温度 19.55–25.63 ℃','style':'Label','position':[550,495]},
    {'text':'压力 97.78–106.06 kPa','style':'Label','position':[550,550]},
]
agent['semanticRole']='Actual completed run result, full original page and measured values'
chapter=next(c for c in edl['chapters'] if c['id']=='P12')
wide,plate,detail,_=chapter['sourceSegments']
def make(source,identity,frames,label=None):
    value=copy.deepcopy(source)
    value['id']=identity
    value['frames']=frames
    if label:
        value['semanticRole']=label
        value['overlays']=[{'text':label,'style':'Label','position':[96,125]}]
    return value
# Real WordBoundary times: backend names 175.033–178.896; shared project
# 179.146–180.883; Rust sentence 181.458–184.033; package 184.358–188.471.
chapter['sourceSegments']=[
    make(plate,'backends-names',135),
    make(detail,'detail-shared-project',66,'发布 Viewer · Three.js'),
    make(plate,'backends-rust-core',90),
    make(wide,'wide-scene-package',126,'发布 Viewer · Three.js'),
    make(plate,'backends-paths',123),
]
assert sum(s['frames'] for s in chapter['sourceSegments'])==540
edl['finalReviewRevision']={
    'parentOriginal':str(BASE/'edl.json'),
    'changes':['Full-page Agent result with actual 18-row/range typography',
               'Rust sentence exactly on backend plate; Three-labelled footage on shared project/package sentences',
               'Explicit three-column branches on creation/runtime diagrams'],
    'voiceAndCaptionUnchanged':True,
}
plates=OUT/'plates'
plates.mkdir(exist_ok=True)
accent=json.loads((BASE/'computed-product-tokens.json').read_text(encoding='utf-8'))['--accent']
def tip(draw,x,y):
    draw.polygon([(x-8,y-12),(x+8,y-12),(x,y)],fill=accent)
for name in ['layers','backends']:
    image=Image.open(BASE/f'plates/{name}.png').convert('RGB')
    draw=ImageDraw.Draw(image)
    if name=='layers':
        for x in [384,960,1536]:
            draw.line((x,510,x,550),fill=accent,width=2)
        draw.line((384,550,1536,550),fill=accent,width=2)
        draw.line((960,550,960,595),fill=accent,width=2)
        tip(draw,960,595)
        draw.line((960,695,960,750),fill=accent,width=2)
        draw.line((384,750,1536,750),fill=accent,width=2)
        for x in [384,960,1536]:
            draw.line((x,750,x,797),fill=accent,width=2)
            tip(draw,x,797)
    else:
        draw.line((960,490,960,540),fill=accent,width=2)
        draw.line((384,540,1536,540),fill=accent,width=2)
        for x in [384,960,1536]:
            draw.line((x,540,x,595),fill=accent,width=2)
            tip(draw,x,595)
        tip(draw,1536,788)
    target=plates/f'{name}.png'
    image.save(target)
    identity=hashlib.sha256(target.read_bytes()).hexdigest()
    for c in edl['chapters']:
        for s in c['sourceSegments']:
            if s['source']==str(BASE/f'plates/{name}.png'):
                s.update(source=str(target),sha256=identity)
(OUT/'edl.json').write_text(json.dumps(edl,ensure_ascii=False,indent=2),encoding='utf-8')
# Link only immutable segment cache files; picture/mix/concat are rebuilt independently.
work=OUT/'render-work'
work.mkdir(exist_ok=True)
for source in (BASE/'render-work').glob('P??-*.mp4'):
    target=work/source.name
    if not target.exists():
        os.link(source,target)
print(OUT)
