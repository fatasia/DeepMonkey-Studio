"""Build all reviewed film chapters with original-speed captures and explicit editorial diagrams."""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'deliverables/studio-020-20261007/intro-award-v2-20261008'
RAW=OUT.parent/'intro-astra/raw'
OLD=Path('D:/Documents/bim/deliverables/system-feature-screencast-20260926/DeepMonkeyStudio-全功能原生录屏-v3.webm')
sha=lambda p:hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
paths={
 'wide':RAW/'astra-viewer-hero-wide-take1/viewer-hero-wide-1080p.mp4',
 'close':RAW/'astra-viewer-machines-close-take1/viewer-machines-close-1080p.mp4',
 'detail':RAW/'astra-viewer-device-detail-take1/viewer-device-detail-1080p.mp4',
 'camera':RAW/'astra-smt-camera-path-take1/camera-path-preview-1080p.mp4',
 'data':RAW/'astra-data-take3/data-preview-1080p.mp4',
 'ontology':RAW/'astra-ontology-take2/ontology-preview-1080p.mp4',
 'link':RAW/'astra-link-take2/link-preview-1080p.mp4',
 'action':RAW/'astra-action-preview-take2/action-preview-1080p.mp4',
 'agent':RAW/'astra-agent-success-result-take2/agent-result-preview-1080p.mp4',
 'history':OLD,
}
edl=json.loads((OUT/'edl.json').read_text(encoding='utf-8'))
chapters={c['id']:c for c in edl['chapters']}


def segment(key,seconds,start=0,label=None,crop=None):
    is_plate=key not in paths
    source=OUT/f'plates/{key}.png' if is_plate else paths[key]
    value={'id':key,'kind':'conceptPlate' if is_plate else 'footage','source':str(source),'sourceIn':start,
           'frames':round(seconds*30),'sha256':sha(source),'identityVerified':True,'visualReviewed':True,
           'semanticRole':label or key,'historical':key=='history','subtitlePosition':'bottom','overlays':[]}
    if key in ['data','ontology','link','agent']:
        value['subtitlePosition']='top'
    if not is_plate:
        value['backend']='webgl' if key in ['wide','close','detail','camera','history'] else '2d'
    if crop:
        value['crop']=crop
    if label:
        value['overlays']=[{'text':label,'style':'Label','position':[96,125]}]
    return value


def assign(identity,items,title):
    chapter=chapters[identity]
    remaining=chapter['targetOutFrame']-chapter['targetInFrame']-sum(s['frames'] for s in items)
    items[-1]['frames']+=remaining
    for i,s in enumerate(items):
        s['id']=f'{s["id"]}-{i}'
    chapter['title']=title
    chapter['sourceSegments']=items


assign('P05',[segment('close',3,10),segment('data',5,3),segment('data',3,14),segment('data',5)],'数据，有了来处')
# Product data capture and explanatory data plate share the label; select the last as plate explicitly.
chapters['P05']['sourceSegments'][-1].update(kind='conceptPlate',source=str(OUT/'plates/data.png'),sourceIn=0,sha256=sha(OUT/'plates/data.png'),backend=None)
assign('P06',[segment('history',4,49,'二维工作台 · 独立创作示例'),segment('data',4),segment('close',8,11)],'画面、数据与空间')
chapters['P06']['sourceSegments'][1].update(kind='conceptPlate',source=str(OUT/'plates/data.png'),sourceIn=0,sha256=sha(OUT/'plates/data.png'),backend=None)
assign('P07',[segment('semantics',3),segment('ontology',2,3),segment('link',4,0),segment('link',2,4),segment('detail',5,9)],'对象 · 关系 · 行动')
assign('P08',[segment('close',3,17),segment('agent',3,0),segment('agent',4,7,crop=[.749,.326,.238,.238]),segment('semantics',3),segment('wide',5,10)],'带着上下文工作')
assign('P09',[segment('history',3,72,'脚本生命周期 · 创作示例'),segment('action',3,2,'行动预览 · 输入与影响',crop=[.38,.36,.54,.54]),segment('behaviors',4),segment('camera',6,4)],'让经验成为行为')
assign('P10',[segment('close',4,4),segment('history',2,321,'工况推演 · 独立示例',crop=[.09,.105,.89,.83]),segment('simulation',4),segment('detail',6,3)],'保留条件与结果')
assign('P11',[segment('wide',5,8),segment('efficiency',5),segment('camera',6,4)],'把计算花在需要的地方')
assign('P12',[segment('wide',5,16,'Three.js · 当前发布场景'),segment('backends',4),segment('detail',5,1,'独立 Viewer · 运行路径示例'),segment('backends',4)],'共享工程，不同运行路径')
assign('P13',[segment('sdk',4),segment('close',5,8,'独立 Viewer · 当前发布场景'),segment('sdk',4),segment('layers',4),segment('detail',4,8)],'开放能力，独立使用')
assign('P14',[segment('wide',6,4,'Web 发布 · 当前独立运行'),segment('delivery',4),segment('detail',8,9)],'交给下一位使用者')
assign('P15',[segment('wide',3,21),segment('detail',6,12),segment('closing',3)],'我将它留下来')
edl['editorialPolicy']={'history':'Independent historical feature example; no shared task identity implied',
 'mechanismPlates':'Explicit product explanation; no invented UI execution or performance numbers',
 'sdk':'Actual ServerClient public-scene read, followed by independent Three Viewer; no Deep renderer adapter claimed',
 'excludedCaptures':['viewer-pullback-ending','viewer-ending-v2']}
(OUT/'edl.json').write_text(json.dumps(edl,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'frames':edl['totalFrames'],'chapters':len(edl['chapters']),
                  'segments':sum(len(c['sourceSegments']) for c in edl['chapters'])}))
