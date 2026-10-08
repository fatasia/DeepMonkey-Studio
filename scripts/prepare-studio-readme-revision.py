"""Preserve V3 voices and pictures, shorten by sentence, and add eight-second ontology."""
import hashlib
import json
from pathlib import Path
import re
import wave
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parent.parent
OLD=Path('D:/Documents/bim/deliverables/system-intro-20260925/v3')
OUT=ROOT/'deliverables/studio-020-20261007/intro-readme-revision-20261008'
RAW=OUT.parent/'intro-astra/raw'
FPS=30;RATE=48000
FRAMES=[406,264,596,479,567,240,329,450,598,511,330,435]
CUTS={0:[(0,406/30)],1:[(0,8.494048)],2:[(0,596/30)],3:[(0,479/30)],4:[(0,567/30)],
      5:[(4.773095,15.566667)],6:[(0,10.140873),(17.769127,22.392857)],
      7:[(0,19.704365)],8:[(0,511/30)],9:[(5.130238,15.966667)],10:[(0,435/30)]}


def sha(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def save(path,data):path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')


def pcm(path):
    with wave.open(str(path)) as stream:
        if (stream.getframerate(),stream.getnchannels(),stream.getsampwidth())!=(RATE,2,2):
            raise ValueError('Original stereo PCM contract differs')
        return stream.readframes(stream.getnframes())


def wav(path,data):
    with wave.open(str(path),'wb') as stream:
        stream.setframerate(RATE);stream.setnchannels(2);stream.setsampwidth(2);stream.writeframes(data)


def seconds(text):
    a,b,c,d=map(int,re.split('[:,]',text));return a*3600+b*60+c+d/1000


def originals():
    blocks=(OLD/'中文字幕.srt').read_text(encoding='utf-8-sig').strip().split('\n\n')
    result=[]
    for block in blocks:
        lines=block.splitlines();a,b=lines[1].split(' --> ')
        result.append({'oldCueId':int(lines[0]),'start':seconds(a),'end':seconds(b),'text':'\n'.join(lines[2:])})
    return result


def revised_plates():
    folder=OUT/'plates';folder.mkdir(exist_ok=True)
    # Keep original typography/logo while separating all UI from the concept plate.
    opening=Image.open(OLD/'plates/00.png').convert('RGB');bg=opening.getpixel((50,50))
    ImageDraw.Draw(opening).rectangle((866,209,1846,900),fill=bg);opening.save(folder/'opening-concept.png')
    plugins=Image.open(OLD/'plates/05.png').convert('RGB');d=ImageDraw.Draw(plugins)
    d.rectangle((85,402,960,824),fill=bg);d.rectangle((1056,402,1760,824),fill=bg)
    font=ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc',50)
    d.text((94,528),'Unity → Studio',font=font,fill=(230,236,239))
    d.text((1064,528),'Revit → GLB',font=font,fill=(230,236,239));plugins.save(folder/'plugin-paths.png')
    delivery=Image.open(OLD/'plates/24.png').convert('RGB');d=ImageDraw.Draw(delivery)
    d.rectangle((80,600,1840,668),fill=bg);font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',38)
    for i,text in enumerate(['Web','Windows','Native','WASM']):d.text((90+i*452,605),text,font=font,fill=(230,236,239))
    delivery.save(folder/'delivery-no-mobile.png')
    return folder


def segment(name,kind,source,frames,start=0,**more):
    return {'id':name,'kind':kind,'source':str(source),'sha256':sha(source),'frames':frames,'sourceIn':start,**more}


def main():
    OUT.mkdir(exist_ok=True);(OUT/'audio').mkdir(exist_ok=True)
    if (OUT/'edl.json').exists():raise ValueError('Preserve frozen EDL; do not rerun preparation')
    plates=revised_plates();old=json.loads((OLD/'timeline.json').read_text(encoding='utf-8'))
    original_cues=originals();cues=[];chapters=[];voice_edits=[];voice_pcm=[];music_parts=[]
    music=pcm(OLD/'music-original.wav');cursor=0
    order=[0,1,2,3,4,None,5,6,7,8,9,10]
    for position,(index,count) in enumerate(zip(order,FRAMES)):
        identity=f'C{position:02}';length=count/FPS;start=cursor/FPS
        if index is None:
            source=OUT/'audio/ontology-eight-second.wav';data=pcm(source)
            body=b'\0'*(round(.25*RATE)*4)+data
            meta=json.loads(source.with_suffix('.json').read_text(encoding='utf-8'))
            for item in meta:
                cues.append({'start':start+.25+item['offset']/1e7,'end':start+.25+(item['offset']+item['duration'])/1e7,
                             'text':item['text'],'chapter':identity,'sourceBoundary':str(source.with_suffix('.json'))})
            title='本体图谱';voice_edits.append({'chapter':identity,'source':str(source),'sha256':sha(source),'extraTempo':False,'leadSeconds':.25,'duration':length})
            music_at=old['sections'][4]['start']+old['sections'][4]['duration']
        else:
            source=OLD/f'voice-{index:02}.wav';data=pcm(source);pieces=[];offset=0
            for part,(a,b) in enumerate(CUTS[index]):
                if part:
                    pause=.11;pieces.append(b'\0'*(round(pause*RATE)*4));offset+=pause
                payload=data[round(a*RATE)*4:round(b*RATE)*4];pieces.append(payload)
                for cue in original_cues:
                    local=cue['start']-old['sections'][index]['start']
                    if a-.001<=local<b-.002:
                        cues.append({**cue,'start':start+offset+max(0,local-a),
                                     'end':start+offset+min(b-a,cue['end']-old['sections'][index]['start']-a),'chapter':identity})
                voice_edits.append({'chapter':identity,'source':str(source),'sha256':sha(source),'sourceIn':a,'sourceOut':b,
                                    'targetIn':start+offset,'extraTempo':False,'boundarySilenceChecked':True})
                offset+=len(payload)/(RATE*4)
            body=b''.join(pieces);title=old['sections'][index]['title'];music_at=old['sections'][index]['start']+CUTS[index][0][0]
        maximum=count*1600*4
        if len(body)>maximum:raise ValueError('Original speech exceeds its unaccelerated window')
        voice_pcm.append(body+b'\0'*(maximum-len(body)))
        part=music[round(music_at*RATE)*4:round((music_at+length)*RATE)*4]
        music_parts.append(part+b'\0'*(maximum-len(part)))
        chapters.append({'id':identity,'title':title,'targetInFrame':cursor,'targetOutFrame':cursor+count,'originalSection':index,'sourceSegments':[]})
        cursor+=count
    cues.sort(key=lambda x:x['start'])
    for previous,current in zip(cues,cues[1:]):previous['end']=min(previous['end'],current['start'])
    wav(OUT/'audio/narration-edited.wav',b''.join(voice_pcm));wav(OUT/'audio/music-edited.wav',b''.join(music_parts))
    save(OUT/'voice-edit.json',{'originalTempoAlreadyBaked':1.26,'furtherTempo':False,'totalFrames':cursor,'edits':voice_edits})
    save(OUT/'caption-cues.json',cues)
    def img(name,n,frames):return segment(name,'screenshot',OLD/'assets'/n,frames,historical=True)
    def plate(name,n,frames):return segment(name,'conceptPlate',OLD/'plates'/f'{n:02}.png',frames)
    def video(name,folder,file,frames,at):return segment(name,'footage',RAW/folder/file,frames,at,backend='2d',historical=False)
    groups=[]
    groups.append([segment('opening','conceptPlate',plates/'opening-concept.png',210),img('opening-ui','02-applied-in-3d.png',196)])
    groups.append([plate('principle-a',1,132),plate('principle-b',2,132)])
    boundaries=json.loads((OLD/'voice-02.json').read_text(encoding='utf-8'));revit=round((.25+boundaries[3]['offset']/1e7/1.26)*30)
    groups.append([img('editors','10-editor-overview.png',102),plate('formats',4,161),img('unity','02aa-unity-runtime-recovered.png',revit-263),segment('revit','conceptPlate',plates/'plugin-paths.png',596-revit)])
    groups.append([img('optimizer','optimizer-bake-live-review.png',169),img('scene-editor','03-scene-editor-1920x1080.png',310)])
    groups.append([plate('protocols',8,327),video('pipeline','astra-data-take3','data-preview-1080p.mp4',150,3),img('dashboard','10-editor-overview.png',90)])
    groups.append([video('drag','astra-ontology-take2','ontology-preview-1080p.mp4',60,0),video('ports','astra-link-take2','link-preview-1080p.mp4',60,0),video('mapping','astra-link-take2','link-preview-1080p.mp4',60,4),video('saved','astra-link-take2','link-preview-1080p.mp4',60,8)])
    groups.append([img('behavior','02bb-behavior-editor-1920x1080.png',130),img('operations','operations-1440-planning-flow-edited.png',199)])
    groups.append([video('agent','astra-agent-success-result-take2','agent-result-preview-1080p.mp4',304,0),img('science','battery-science-current.png',146)])
    groups.append([plate('rendering',18,394),plate('efficiency',19,204)])
    motion=OUT/'motion'
    groups.append([segment('three-layers','conceptMotion',motion/'readme-three-layers.mp4',150),segment('layers-read','conceptPlate',motion/'readme-three-layers-last-frame.png',361,semanticRole='Explicit reading pause on authored architecture, not product execution')])
    groups.append([segment('delivery','conceptPlate',plates/'delivery-no-mobile.png',330)])
    groups.append([plate('author',26,435)])
    for chapter,group in zip(chapters,groups):chapter['sourceSegments']=group
    edl={'schema':'studio-readme-revision.v1','fps':30,'totalFrames':cursor,'chapters':chapters,
         'baseline':{'source':str(OLD/'DeepMonkey-Studio-系统介绍-V3.mp4'),'sha256':sha(OLD/'DeepMonkey-Studio-系统介绍-V3.mp4')},
         'narration':{'source':str(OUT/'audio/narration-edited.wav'),'sha256':sha(OUT/'audio/narration-edited.wav')},
         'music':{'source':str(OUT/'audio/music-edited.wav'),'sha256':sha(OUT/'audio/music-edited.wav'),'originalSource':str(OLD/'music-original.wav'),'originalSha256':sha(OLD/'music-original.wav')},
         'layout':'full-source-fit-safe-subtitles.v1','newOntologySeconds':8}
    save(OUT/'edl.json',edl)
    print(json.dumps({'frames':cursor,'seconds':cursor/30,'captions':len(cues),'newVoiceSeconds':6.12}))


if __name__=='__main__':main()
