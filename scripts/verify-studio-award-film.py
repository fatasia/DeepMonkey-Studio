"""Verify final encoding, original source identities and speech/caption synchronization."""
import importlib.util
import argparse
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--project',type=Path,default=ROOT/'deliverables/studio-020-20261007/intro-award-v2-20261008')
parser.add_argument('--film',default='deepmonkey-studio-intro-award-v2.mp4')
args=parser.parse_args()
OUT=args.project.resolve()
spec=importlib.util.spec_from_file_location('award',ROOT/'scripts/render-studio-award-intro.py')
award=importlib.util.module_from_spec(spec)
spec.loader.exec_module(award)
edl=json.loads((OUT/'edl.json').read_text(encoding='utf-8'))
film=OUT/args.film
evidence=json.loads(film.with_suffix('.evidence.json').read_text(encoding='utf-8'))
if award.validate(edl) or evidence['sha256']!=award.sha(film) or evidence['edlSha256']!=award.sha(OUT/'edl.json'):
    raise ValueError('Final source/edit/output identity failed')
timing=json.loads((OUT/'narration-timing.json').read_text(encoding='utf-8'))
cues=json.loads((OUT/'caption-cues.json').read_text(encoding='utf-8'))
helper=award.shared().preparation()
expected=[cue for item in timing['entries'] for cue in helper.timed_captions(item)]
if cues!=expected or len(cues)!=61:
    raise ValueError('Caption content or timing differs from real speech word boundaries')
for extension in ['srt','vtt']:
    text=film.with_suffix(f'.{extension}').read_text(encoding='utf-8')
    blocks=text.strip().split('\n\n')
    if extension=='vtt':
        if blocks.pop(0)!='WEBVTT':
            raise ValueError('VTT header differs')
    if len(blocks)!=len(cues):
        raise ValueError('External subtitle cue count differs')
    for index,(block,cue) in enumerate(zip(blocks,cues),1):
        display=cue['text'].replace('AI for\nScience','\nAI for Science')
        expected_block='\n'.join([str(index),f"{helper.stamp(cue['start'],extension=='vtt')} --> {helper.stamp(cue['end'],extension=='vtt')}",display])
        if block!=expected_block:
            raise ValueError('External subtitles differ from actual speech/display contract')
for item in timing['entries']:
    chapter=next(c for c in edl['chapters'] if c['id']==item['id'])
    if item['start']<chapter['targetInFrame']/30 or item['end']>chapter['targetOutFrame']/30:
        raise ValueError('Actual speech exceeds chapter')
    if award.sha(item['audio'])!=item['sha256']:
        raise ValueError('Voice clip changed')
info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-show_chapters','-of','json',str(film)]))
video=next(s for s in info['streams'] if s['codec_type']=='video')
audio=next(s for s in info['streams'] if s['codec_type']=='audio')
if int(video['nb_frames'])!=edl['totalFrames'] or video['avg_frame_rate']!='30/1' or video['width']!=1920 or video['height']!=1080:
    raise ValueError('Final picture contract failed')
if video['codec_name']!='h264' or audio['codec_name']!='aac' or len(info['chapters'])!=15:
    raise ValueError('Codec/chapter count failed')
if audio['sample_rate']!='48000' or audio['channels']!=2:
    raise ValueError('Audio delivery requires 48 kHz stereo')
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-xerror','-threads','2','-i',str(film),'-f','null','-'],check=True)
result=subprocess.run(['ffmpeg','-hide_banner','-threads','2','-i',str(film),'-vn','-af','loudnorm=I=-16:TP=-1:LRA=9:print_format=json','-f','null','-'],capture_output=True,text=True,encoding='utf-8',check=True).stderr
loudness=json.loads(result[result.rfind('{'):result.rfind('}')+1])
if not -17<float(loudness['input_i'])<-15 or float(loudness['input_tp'])>-.7:
    raise ValueError(f'Final loudness/true peak outside AAC tolerance: {loudness}')
sources={s['source']:s['sha256'] for c in edl['chapters'] for s in c['sourceSegments']}
report={'output':str(film),'sha256':award.sha(film),'duration':info['format']['duration'],'frames':video['nb_frames'],
        'fps':video['avg_frame_rate'],'size':[video['width'],video['height']],'codec':[video['codec_name'],audio['codec_name']],
        'audioSampleRate':audio['sample_rate'],'audioChannels':audio['channels'],
        'chapters':len(info['chapters']),'captionCount':len(cues),'actualSpeechBoundarySync':'passed','externalSubtitleSync':'passed',
        'sourceIdentity':'passed','sources':sources,'fullDecode':'passed','loudness':loudness,
        'voiceNaturalRate':timing['rate'],'visualReview':'parent independent reviews pending'}
(OUT/'final-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
