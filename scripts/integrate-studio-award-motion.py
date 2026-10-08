"""Integrate audited editorial motion while retaining actual footage and speech clocks."""
import copy
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
BASE=ROOT/'deliverables/studio-020-20261007/intro-award-v2-20261008'
OUT=BASE/'art-revision'
edl=json.loads((OUT/'edl.json').read_text(encoding='utf-8'))
manifest=json.loads((BASE/'motion-graphics/manifest.json').read_text(encoding='utf-8'))
def replacement(original,key,source_in=0):
    item=copy.deepcopy(manifest[key])
    item.update(id=original['id'],frames=original['frames'],sourceIn=source_in,
                authoredMotion=True,subtitlePosition=original.get('subtitlePosition','bottom'))
    item.pop('backend',None)
    return item
chapters={c['id']:c for c in edl['chapters']}
for chapter in edl['chapters']:
    for index,segment in enumerate(chapter['sourceSegments']):
        if segment['kind']!='conceptPlate':
            continue
        key=Path(segment['source']).stem
        if key not in manifest or key=='closing':
            continue
        seconds=segment['frames']/30
        start=0 if seconds>=4.5 else (.7 if key=='data' else 1.2 if key=='semantics' else 2.0 if seconds==3 and key=='backends' else 5-seconds)
        chapter['sourceSegments'][index]=replacement(segment,key,start)

# Give the primary architecture and ontology one complete causal animation.
for key,kind in [('P03','layers'),('P07','semantics')]:
    chapter=chapters[key]
    core=next(s for s in chapter['sourceSegments'] if s['kind']=='conceptMotion' and Path(s['source']).stem==kind)
    borrowed=150-core['frames']
    core.update(frames=150,sourceIn=0)
    chapter['sourceSegments'][-1]['frames']-=borrowed

# Read the actual interface once, then move the delivered project outside the
# authoring frame; the separate Viewer keeps its explicit Three identity.
chapter=chapters['P13']
source=next(s for s in chapters['P01']['sourceSegments'] if s['id']=='wide-idea-frame')['source']
identity=next(s for s in chapters['P01']['sourceSegments'] if s['id']=='wide-idea-frame')['sha256']
chapter['sourceSegments'][2]={
    'id':'world-interface-result','kind':'footage','source':source,'sourceIn':15,'frames':120,'sha256':identity,
    'identityVerified':True,'visualReviewed':True,'backend':'webgl','subtitlePosition':'bottom',
    'semanticRole':'Actual ServerClient scene read and separately identified Three Viewer',
    'presentation':{'kind':'worldFrame','revealFrames':16},
    'overlays':[
        {'text':'读出工程','style':'Title','position':[96,355],'start':.6},
        {'text':'场景接口 · 发布版本 1\nSMT 产线 · 1 模型','style':'Label','position':[100,480],'start':.6},
        {'text':'独立发布 Viewer · Three.js','style':'Label','position':[720,160],'start':.6},
    ]
}
edl['artRevision']['conceptMotionManifest']=str(BASE/'motion-graphics/manifest.json')
edl['artRevision']['maxSingleConceptSeconds']=5
(OUT/'edl.json').write_text(json.dumps(edl,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'motionSegments':sum(s['kind']=='conceptMotion' for c in edl['chapters'] for s in c['sourceSegments']),
                  'remainingStaticSeconds':sum(s['frames']/30 for c in edl['chapters'] for s in c['sourceSegments'] if s['kind']=='conceptPlate')}))
