"""Export the README-based film with complete-source fit and isolated subtitles."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parent.parent
DEFAULT=ROOT/'deliverables/studio-020-20261007/intro-readme-revision-20261008'


def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


fit=load_module('full_fit',ROOT/'scripts/lib/studioFilmFullFit.py')
media=load_module('media',ROOT/'scripts/render-studio-award-intro.py')


def run(args):
    return subprocess.check_output(args,text=True,encoding='utf-8',errors='replace')


def clock(value):
    ticks=round(value*100)
    return f'{ticks//360000}:{ticks//6000%60:02}:{ticks//100%60:02}.{ticks%100:02}'


def source_info(segment):
    streams=media.probe(segment['source'])['streams']
    video=next(s for s in streams if s['codec_type']=='video')
    ratio=video.get('sample_aspect_ratio','1:1')
    sar=1 if ratio in ['N/A','0:1'] else int(ratio.split(':')[0])/int(ratio.split(':')[1])
    return video['width'],video['height'],sar


def validate(edl):
    if edl['schema']!='studio-readme-revision.v1' or edl['fps']!=30:
        raise ValueError('Unknown README film clock')
    if not 0<edl['totalFrames']<=5385:
        raise ValueError('Film exceeds 179.5 seconds')
    cursor=0;ids=set()
    for chapter in edl['chapters']:
        if chapter['id'] in ids or chapter['targetInFrame']!=cursor:
            raise ValueError('Chapter identities/clock differ')
        ids.add(chapter['id']);frames=0
        for segment in chapter['sourceSegments']:
            fit.validate_layout(segment)
            if type(segment['frames']) is not int or segment['frames']<=0:
                raise ValueError('Positive integer frames required')
            frames+=segment['frames']
            if segment['kind'] not in ['footage','screenshot','conceptPlate','conceptMotion']:
                raise ValueError('Explicit recorded/static/concept source required')
            if media.sha(segment['source'])!=segment['sha256']:
                raise ValueError('Source identity changed')
            if segment['kind'] in ['footage','conceptMotion']:
                duration=float(media.probe(segment['source'])['format']['duration'])
                if segment.get('sourceIn',0)<0 or segment.get('sourceIn',0)+segment['frames']/30>duration+.001:
                    raise ValueError('Original motion cannot be looped or padded')
        if frames!=chapter['targetOutFrame']-cursor:
            raise ValueError('Chapter source frames differ')
        cursor=chapter['targetOutFrame']
    if cursor!=edl['totalFrames']:
        raise ValueError('Total edit clock differs')


def captions(cues,work,tokens,total):
    text=media.shared().ass_color(tokens['--text-strong'])
    bg=media.shared().ass_color(tokens['--bg-0'])
    header='\n'.join(['[Script Info]','ScriptType: v4.00+','PlayResX: 1920','PlayResY: 1080','WrapStyle: 2',
        '[V4+ Styles]','Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        f'Style: Caption,Microsoft YaHei,38,{text},{text},{bg},{bg},0,0,0,0,100,100,0,0,1,0,0,5,90,90,0,1',
        '[Events]','Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'])
    previous=0;events=[]
    for cue in cues:
        if not previous<=cue['start']<cue['end']<=total/30+.001:
            raise ValueError('Subtitle clock exceeds speech edit')
        previous=cue['end'];display=fit.caption_text(cue['text']).replace('\n',r'\N')
        events.append(f"Dialogue: 0,{clock(cue['start'])},{clock(cue['end'])},Caption,,0,0,0,,{{\\an5\\pos(960,1020)}}{display}")
    path=work/'captions.ass';path.write_text(header+'\n'+'\n'.join(events),encoding='utf-8-sig')
    return path


def render(folder,output):
    edl=json.loads((folder/'edl.json').read_text(encoding='utf-8'));validate(edl)
    if output.exists():raise ValueError('Preserve existing output')
    edl_sha=media.sha(folder/'edl.json')
    tokens=json.loads((folder/'computed-product-tokens.json').read_text(encoding='utf-8'))
    cues=json.loads((folder/'caption-cues.json').read_text(encoding='utf-8'))
    work=folder/'render-work';work.mkdir(exist_ok=True)
    caption_file=captions(cues,work,tokens,edl['totalFrames'])
    def stamp(seconds,separator):
        value=round(seconds*1000)
        return f'{value//3600000:02}:{value//60000%60:02}:{value//1000%60:02}{separator}{value%1000:03}'
    srt=[];vtt=['WEBVTT','']
    for index,cue in enumerate(cues,1):
        text=fit.caption_text(cue['text'])
        srt.append(f"{index}\n{stamp(cue['start'],',')} --> {stamp(cue['end'],',')}\n{text}\n")
        vtt.append(f"{stamp(cue['start'],'.')} --> {stamp(cue['end'],'.')}\n{text}\n")
    output.with_suffix('.srt').write_text('\n'.join(srt),encoding='utf-8')
    output.with_suffix('.vtt').write_text('\n'.join(vtt),encoding='utf-8')
    clips=[];evidence=[]
    for chapter in edl['chapters']:
        for segment in chapter['sourceSegments']:
            print(f"Encoding {chapter['id']} / {segment['id']}",flush=True)
            geometry=source_info(segment)
            transform,box=fit.filter_for(*geometry[:2],tokens['--bg-0'],geometry[2],segment.get('maxScale'))
            key=hashlib.sha256((json.dumps(segment,sort_keys=True)+transform).encode()).hexdigest()[:16]
            clip=work/f"{chapter['id']}-{segment['id']}-{key}.mp4"
            if not clip.exists():
                source=['-ss',str(segment.get('sourceIn',0)),'-i',segment['source']] if segment['kind'] in ['footage','conceptMotion'] else ['-loop','1','-i',segment['source']]
                run(['ffmpeg','-hide_banner','-loglevel','error','-threads','2','-filter_threads','1',*source,'-an','-vf',transform,
                     '-frames:v',str(segment['frames']),'-c:v','libx264','-threads','2','-preset','fast','-crf','18',str(clip)])
            actual=media.probe(clip)['streams'][0]
            if int(actual['nb_frames'])!=segment['frames'] or actual['avg_frame_rate']!='30/1':
                raise ValueError('Cached clip clock differs')
            clips.append(clip)
            evidence.append({'chapter':chapter['id'],**segment,'fit':box,'clipSha256':media.sha(clip)})
    concat=work/'clips.ffconcat';concat.write_text('ffconcat version 1.0\n'+'\n'.join(f"file '{x.name}'" for x in clips),encoding='utf-8')
    picture=work/'picture.mp4'
    run(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',str(concat),'-c','copy',str(picture)])
    voice=edl['narration'];music=edl['music']
    for item in [voice,music]:
        if media.sha(item['source'])!=item['sha256']:raise ValueError('Original sound identity changed')
    seconds=edl['totalFrames']/30
    audio=work/'mix.wav'
    run(['ffmpeg','-y','-hide_banner','-loglevel','error','-threads','2','-i',voice['source'],'-i',music['source'],
         '-filter_complex',f'[1:a]afade=t=out:st={seconds-3}:d=3[m];[0:a][m]amix=inputs=2:normalize=0,apad,atrim=duration={seconds}[a]',
         '-map','[a]','-ar','48000','-ac','2',str(audio)])
    metadata=work/'chapters.ffmeta';lines=[';FFMETADATA1']
    for c in edl['chapters']:lines+=['[CHAPTER]','TIMEBASE=1/30',f"START={c['targetInFrame']}",f"END={c['targetOutFrame']}",f"title={c['title']}"]
    metadata.write_text('\n'.join(lines),encoding='utf-8')
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-threads','2','-filter_threads','1','-i',str(picture),'-i',str(audio),
         '-f','ffmetadata','-i',str(metadata),'-map','0:v:0','-map','1:a:0','-map_metadata','2','-map_chapters','2','-vf','ass=captions.ass',
         '-c:v','libx264','-threads','2','-preset','fast','-crf','18','-c:a','aac','-b:a','192k','-ar','48000','-ac','2',
         '-af','loudnorm=I=-16:TP=-1:LRA=9','-t',str(seconds),'-movflags','+faststart',str(output)],cwd=work,check=True)
    run(['ffmpeg','-hide_banner','-loglevel','error','-xerror','-threads','2','-i',str(output),'-f','null','-'])
    if media.sha(folder/'edl.json')!=edl_sha:raise ValueError('EDL changed during export')
    result={'output':str(output),'sha256':media.sha(output),'edlSha256':edl_sha,'totalFrames':edl['totalFrames'],
            'fullDecode':'passed','layout':'full-source-fit-safe-subtitles.v1','sources':evidence,'visualReview':'pending'}
    output.with_suffix('.evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(output)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--project',type=Path,default=DEFAULT);parser.add_argument('--output',type=Path)
    args=parser.parse_args();render(args.project.resolve(),(args.output or args.project/'deepmonkey-studio-system-intro-readme-20261008.mp4').resolve())
