"""Apply the approved same-duration final cut before freezing the README film."""
import importlib.util
import json
import wave
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('prepare',ROOT/'scripts/prepare-studio-readme-revision.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
OUT=p.OUT


def main():
    if (OUT/'render-work').exists():raise ValueError('Final cut is frozen after rendering starts')
    edl=json.loads((OUT/'edl.json').read_text(encoding='utf-8'))
    chapters=edl['chapters'];motion=OUT/'motion'
    chapters[0]['sourceSegments'][0]=p.segment('opening','conceptPlate',p.OLD/'plates/00.png',210)
    plugin=OUT/'plates/plugin-paths.png'
    image=Image.open(plugin).convert('RGB');draw=ImageDraw.Draw(image)
    draw.rectangle((80,930,700,977),fill=image.getpixel((50,50)))
    draw.text((92,939),'插件接入路径',font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',20),fill=(134,155,165))
    image.save(plugin)
    for segment in chapters[2]['sourceSegments']:
        if segment['id']=='revit':segment['sha256']=p.sha(plugin)
    first=chapters[3]['sourceSegments'][0]
    chapters[3]['sourceSegments']=[first,
        p.segment('scene-editor','screenshot',p.OLD/'assets/03-scene-editor-1920x1080.png',70,historical=True),
        p.segment('material','footage',p.RAW/'astra-smt-material-take1/material-preview-1080p.mp4',60,1.2,historical=False),
        p.segment('camera-path','footage',p.RAW/'astra-smt-camera-path-take1/camera-path-preview-1080p.mp4',180,4,historical=False)]
    chapters[8]['sourceSegments']=[chapters[8]['sourceSegments'][0],
        p.segment('gpu-lod-streaming','conceptMotion',motion/'readme-gpu-lod-streaming.mp4',150),
        p.segment('gpu-reading','conceptPlate',motion/'readme-gpu-lod-streaming-last-frame.png',54,
                  semanticRole='Reading pause on authored GPU/LOD/streaming diagram',sourceFrame=149)]
    phases=[('upper-reveal',32,0),('upper-read',78,31),('middle-reveal',20,32),('middle-read',166,51),
            ('bottom-reveal',29,52),('bottom-read',52,80),('contract-reveal',69,81),('contract-read',65,149)]
    group=[]
    for name,frames,frame in phases:
        if name.endswith('reveal'):
            group.append(p.segment(name,'conceptMotion',motion/'readme-three-layers.mp4',frames,frame/30))
        else:
            source=motion/('readme-three-layers-last-frame.png' if frame==149 else f'layers-reading-frame-{frame}.png')
            group.append(p.segment(name,'conceptPlate',source,frames,sourceFrame=frame,
                         semanticRole='Reading pause on authored layer diagram',
                         originalMotionSha256=p.sha(motion/'readme-three-layers.mp4')))
    chapters[9]['sourceSegments']=group
    # Recover original edited music on every run, then soften only music splice edges.
    old=json.loads((p.OLD/'timeline.json').read_text(encoding='utf-8'));original=p.pcm(p.OLD/'music-original.wav')
    parts=[]
    for chapter in chapters:
        i=chapter['originalSection'];count=chapter['targetOutFrame']-chapter['targetInFrame']
        at=old['sections'][4]['start']+old['sections'][4]['duration'] if i is None else old['sections'][i]['start']+p.CUTS[i][0][0]
        size=count*1600*4;body=original[round(at*p.RATE)*4:round(at*p.RATE)*4+size]
        parts.append(body+b'\0'*(size-len(body)))
    samples=np.frombuffer(bytearray(b''.join(parts)),dtype='<i2').reshape(-1,2)
    ramp=round(.01*p.RATE)
    for chapter in chapters[1:]:
        at=chapter['targetInFrame']*1600
        for a,b,gain in [(at-ramp,at,np.linspace(1,0,ramp)),(at,at+ramp,np.linspace(0,1,ramp))]:
            samples[a:b]=np.rint(samples[a:b].astype(np.float64)*gain[:,None]).astype('<i2')
    p.wav(OUT/'audio/music-edited.wav',samples.tobytes())
    edl['music']['sha256']=p.sha(OUT/'audio/music-edited.wav')
    edl['music']['spliceFadeSecondsEachSide']=.01
    edl['finalCut']={'frames':5205,'seconds':173.5,'ontologySeconds':8,'sourceFit':'complete contain','voiceTempoAdded':False}
    for chapter in chapters:
        if sum(s['frames'] for s in chapter['sourceSegments'])!=chapter['targetOutFrame']-chapter['targetInFrame']:
            raise ValueError('Final changes must preserve chapter length')
    p.save(OUT/'edl.json',edl)
    print(json.dumps({'frames':edl['totalFrames'],'seconds':edl['totalFrames']/30,'edlSha256':p.sha(OUT/'edl.json')}))


if __name__=='__main__':main()
