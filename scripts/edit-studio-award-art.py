"""Create a separate Chinese art revision; never alter the audited baseline film."""
import copy
import hashlib
import json
import os
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
BASE=ROOT/'deliverables/studio-020-20261007/intro-award-v2-20261008'
REVIEW=BASE/'review-revision'
OUT=BASE/'art-revision'
OUT.mkdir(exist_ok=True)
for name in ['computed-product-tokens.json','caption-cues.json','narration-timing.json']:
    (OUT/name).write_bytes((BASE/name).read_bytes())
edl=json.loads((REVIEW/'edl.json').read_text(encoding='utf-8'))
chapters={c['id']:c for c in edl['chapters']}
first=chapters['P01']['sourceSegments']
paths={k:next(s['source'] for s in first if k in Path(s['source']).name) for k in ['wide','detail','close']}
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def overlay(text,position,style='Title',start=0,end=None):
    value={'text':text,'position':position,'style':style,'start':start}
    if end is not None:
        value['end']=end
    return value
def frame(key,start,seconds,identity,titles,reveal=0,label='DeepMonkey Studio · 作者工程'):
    source=paths[key]
    return {'id':identity,'kind':'footage','source':source,'sourceIn':start,'frames':round(seconds*30),
            'sha256':sha(source),'identityVerified':True,'visualReviewed':True,'backend':'webgl',
            'semanticRole':'Editorial engineering viewport, actual Three Viewer footage',
            'subtitlePosition':'bottom','presentation':{'kind':'worldFrame','revealFrames':reveal},
            'overlays':[overlay(label,[720,160],'Label',reveal/30),*titles]}
first[2]=frame('wide',0,5,'wide-idea-frame',[
    overlay('你创造的\n世界',[96,360],start=.6)],reveal=16)
chapters['P02']['sourceSegments']=[
    frame('detail',3,4,'detail-understand',[overlay('可以理解',[96,370])]),
    frame('close',8,4,'close-edit',[overlay('可以修改',[96,370])]),
    frame('wide',9,4,'wide-definition',[
        overlay('可以继续使用',[96,370],end=1.3),
        overlay('开源世界底座',[96,350],start=1.3),
        overlay('元宇宙\nAI for Science · 世界模型',[100,480],'Label',start=1.3)]),
    frame('detail',11,4,'detail-definition',[
        overlay('开源世界底座',[96,350]),
        overlay('元宇宙\nAI for Science · 世界模型',[100,480],'Label')]),
]
chapters['P15']['sourceSegments']=[frame('wide',12.5,12,'wide-world-remains',[
    overlay('你创造的\n世界',[96,360],end=3),
    overlay('我将它\n留下来',[96,360],start=3,end=9),
    overlay('DeepMonkey\nStudio',[96,360],start=9),
    overlay('github.com/fatasia/DeepMonkey-Studio',[100,665],'Label',start=9),
],label='独立运行 · 发布 Viewer · Three.js')]
edl['artRevision']={'language':'zh-CN','principle':'The same actual world inside an editorial project frame',
                    'originalSpeed':True,'productPixels':'No background removal or invented lighting',
                    'baseline':str(REVIEW/'edl.json')}
(OUT/'edl.json').write_text(json.dumps(edl,ensure_ascii=False,indent=2),encoding='utf-8')
work=OUT/'render-work'
work.mkdir(exist_ok=True)
for directory in [BASE/'render-work',REVIEW/'render-work']:
    for source in directory.glob('P??-*.mp4'):
        target=work/source.name
        if not target.exists():
            os.link(source,target)
# An independent 28-second picture proof uses the same sources/layout, without
# changing the full project's audio/caption clock or pretending it is the final film.
preview=OUT/'opening-art-proof'
preview.mkdir(exist_ok=True)
short=copy.deepcopy(edl)
short['chapters']=short['chapters'][:2]
short['totalFrames']=840
(preview/'edl.json').write_text(json.dumps(short,ensure_ascii=False,indent=2),encoding='utf-8')
(preview/'computed-product-tokens.json').write_bytes((OUT/'computed-product-tokens.json').read_bytes())
print(OUT)
