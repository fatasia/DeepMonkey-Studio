"""Admit reviewed opening footage and prepare a self-contained 60-second design sample."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'deliverables/studio-020-20261007/intro-award-v2-20261008'
RAW=OUT.parent/'intro-astra/raw'
OLD=Path('D:/Documents/bim/deliverables/system-feature-screencast-20260926/DeepMonkeyStudio-全功能原生录屏-v3.webm')
sha=lambda p:hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
FILES={
 'detail':RAW/'astra-viewer-device-detail-take1/viewer-device-detail-1080p.mp4',
 'close':RAW/'astra-viewer-machines-close-take1/viewer-machines-close-1080p.mp4',
 'wide':RAW/'astra-viewer-hero-wide-take1/viewer-hero-wide-1080p.mp4',
 'editor':RAW/'astra-smt-hero-take1/smt-hero-preview-1080p.mp4',
 'material':RAW/'astra-smt-material-take1/material-preview-1080p.mp4',
 'camera':RAW/'astra-smt-camera-path-take1/camera-path-preview-1080p.mp4',
 'history':OLD,'layers':OUT/'plates/layers.png',
}
if sha(OLD)!='44493b49d3b4e15e36fe703e06fa6e15877d3b0ead357abe0e1d56cada16c26f':
    raise ValueError('Audited historical recording changed')


def segment(identity,source,start,seconds,role,overlays=None):
    return {'id':identity,'kind':'conceptPlate' if source=='layers' else 'footage','source':str(FILES[source]),
            'sourceIn':start,'frames':round(seconds*30),'sha256':sha(FILES[source]),
            'identityVerified':True,'visualReviewed':True,'semanticRole':role,'backend':'webgl' if source!='layers' else None,
            'historical':source=='history','subtitlePosition':'bottom','overlays':overlays or []}


edl=json.loads((OUT/'edl.json').read_text(encoding='utf-8'))
music=Path('D:/Documents/bim/deliverables/system-intro-20260925/music-original.wav')
edl['soundtrack']={'source':str(music),'sha256':sha(music),'origin':'existing self-composed product soundtrack'}
chapter={c['id']:c for c in edl['chapters']}
chapter['P01']['title']='你创造的世界'
chapter['P01']['sourceSegments']=[
 segment('device','detail',0,4,'当前发布SMT细部实动'),segment('stations','close',0,3,'工位纵深'),
 segment('world','wide',0,5,'产线全景')]
chapter['P02']['title']='创作，有了去处'
chapter['P02']['sourceSegments']=[
 segment('definition','wide',5,4,'当前SMT独立Viewer，产品观点',[
 {'start':.3,'end':3.8,'text':'你创造的世界','style':'Title','position':[96,118]}]),
 segment('inside','detail',10,4,'真实设备细部'),
 segment('principle','wide',9,4,'真实全景与理念',[
 {'start':.2,'end':3.8,'text':'开源世界底座','style':'Title','position':[96,118]},
 {'start':.2,'end':3.8,'text':'元宇宙 · AI for Science · 世界模型','style':'Label','position':[100,228]}]),
 segment('independent','close',13,4,'独立Viewer近景',[
 {'start':.2,'end':3.8,'text':'DeepMonkey Studio','style':'Title','position':[96,118]}])]
chapter['P03']['title']='上层创作，下层复用'
chapter['P03']['sourceSegments']=[
 segment('workbench','editor',0,1,'当前三维创作'),
 segment('two-dimensional','history',49,4,'历史二维编辑器组件库',[
 {'text':'二维编辑器 · 创作示例','style':'Label','position':[96,120]}]),
 segment('script','history',72,4,'历史非空脚本编辑，不把注释说成执行',[
 {'text':'脚本编辑器 · 创作示例','style':'Label','position':[96,120]}]),
 segment('layers','layers',0,4,'产品两层结构说明'),
 segment('return','detail',9,3,'回当前真实设备近景')]
chapter['P03']['sourceSegments'][1]['crop']=[0,0,.44,1]
chapter['P03']['sourceSegments'][2]['crop']=[0,0,.72,1]
chapter['P04']['title']='把现场搭起来'
chapter['P04']['sourceSegments']=[
 segment('material','material',1.2,2,'真实粗糙度参数修改',[{'text':'材质编辑','style':'Label','position':[96,120]}]),
 segment('surface','detail',4,3,'独立Viewer场景承接'),
 segment('timeline','camera',2,5,'两相机关键帧巡检播放'),
 segment('continue','close',3,6,'同工程发布Viewer与GLTF动画')]
(OUT/'edl.json').write_text(json.dumps(edl,ensure_ascii=False,indent=2),encoding='utf-8')
sample=OUT/'opening-sample'
sample.mkdir(exist_ok=True)
selected=copy.deepcopy(edl)
selected['chapters']=selected['chapters'][:4]
selected['totalFrames']=selected['chapters'][-1]['targetOutFrame']
seconds=selected['totalFrames']/30
audio=sample/'narration.wav'
subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-threads','2','-i',str(OUT/'narration.wav'),'-t',str(seconds),'-c:a','pcm_s16le',str(audio)],check=True)
cues=[c for c in json.loads((OUT/'caption-cues.json').read_text(encoding='utf-8')) if c['end']<=seconds]
(sample/'caption-cues.json').write_text(json.dumps(cues,ensure_ascii=False,indent=2),encoding='utf-8')
selected['narration']={'source':str(audio),'sha256':sha(audio),'captionSha256':sha(sample/'caption-cues.json')}
(sample/'edl.json').write_text(json.dumps(selected,ensure_ascii=False,indent=2),encoding='utf-8')
shutil.copyfile(OUT/'computed-product-tokens.json',sample/'computed-product-tokens.json')
print(sample)
