"""Preserve art review and apply the last result-readability changes separately."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parent.parent
BASE=ROOT/'deliverables/studio-020-20261007/intro-award-v2-20261008'
ART=BASE/'art-revision'
OUT=BASE/'photography-revision'
OUT.mkdir(exist_ok=True)
for name in ['computed-product-tokens.json','caption-cues.json','narration-timing.json']:
    (OUT/name).write_bytes((ART/name).read_bytes())
edl=json.loads((ART/'edl.json').read_text(encoding='utf-8'))
chapters={c['id']:c for c in edl['chapters']}
agent=chapters['P08']['sourceSegments'][2]
query=chapters['P08']['sourceSegments'][3]
assert query['frames']==90
query.update(kind='footage',source=agent['source'],sourceIn=0,sha256=agent['sha256'],backend='2d',
             semanticRole='Actual completed Agent run with expanded query/tool evidence',subtitlePosition='top',
             overlays=[{'text':'运行过程与查询记录','style':'Label','position':[550,400]}])
query.pop('authoredMotion',None)
what_if=chapters['P10']['sourceSegments'][1]
hold=chapters['P10']['sourceSegments'][2]
assert hold['frames']==120
image=OUT/'what-if-result-read.png'
if not image.exists():
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-threads','2','-ss','322.9',
                    '-i',what_if['source'],'-frames:v','1','-update','1',str(image)],check=True)
hold.update(kind='readingHold',source=str(image),sourceIn=0,sha256=hashlib.sha256(image.read_bytes()).hexdigest(),
            readingRole='resultReadability',sourceEvidence={'source':what_if['source'],'sha256':what_if['sha256'],'timestamp':322.9},
            semanticRole='Held historical result frame for audience reading; no execution action implied',
            historical=True,crop=what_if['crop'],overlays=what_if['overlays'])
hold.pop('backend',None)
edl['lastReview']={'changes':['Agent process speech stays on actual query evidence',
                           'Historical What-if result frame has four seconds of explicit reading hold'],
                   'audioClockUnchanged':True,'newPhotography':'awaiting actual published version captures'}
(OUT/'edl.json').write_text(json.dumps(edl,ensure_ascii=False,indent=2),encoding='utf-8')
work=OUT/'render-work'
work.mkdir(exist_ok=True)
for source in (ART/'render-work').glob('P??-*.mp4'):
    target=work/source.name
    if not target.exists():
        os.link(source,target)
print(OUT)
