"""Sample completed real CDP captures on their original clock at 30fps.

Preserves raw manifests and pixels. Stable timestamp sorting changes arrival order,
never elapsed time. Each output frame uses the latest observed frame at its clock.
"""
import argparse
import bisect
import hashlib
import json
import math
from pathlib import Path
import subprocess
from PIL import Image

FPS=30
def sha(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()

def load(manifest_path):
    capture=json.loads(manifest_path.read_text(encoding='utf-8'))
    if capture.get('schema')!='studio-real-screencast.v1':
        raise ValueError('Require completed real CDP capture clock contract')
    raw=capture['frames']
    if len(raw)<2: raise ValueError('At least two observed frames required')
    times=[frame['metadata']['timestamp'] for frame in raw]
    if any(type(t) not in (int,float) or not math.isfinite(t) for t in times):
        raise ValueError('Finite actual timestamps required')
    ordered=sorted(enumerate(raw),key=lambda item:item[1]['metadata']['timestamp'])
    timestamps=[frame['metadata']['timestamp'] for _,frame in ordered]
    if any(a>=b for a,b in zip(timestamps,timestamps[1:])):
        raise ValueError('Duplicate timestamps cannot define observed intervals')
    start,end=capture['wallStartMs']/1000,capture['wallEndMs']/1000
    if not all(math.isfinite(v) for v in (start,end)) or not start<=timestamps[0]<timestamps[-1]<=end:
        raise ValueError('Completed wall clock must bracket observed frame timestamps')
    records=[]; size=None
    for arrival,frame in ordered:
        path=(manifest_path.parent/frame['file']).resolve()
        if not path.is_relative_to(manifest_path.parent.resolve()) or not path.is_file():
            raise ValueError('Missing or escaping original source frame')
        with Image.open(path) as im:
            if size is None: size=im.size
            if im.size!=size: raise ValueError('Capture dimensions changed during source recording')
        records.append({'arrivalIndex':arrival,'timestamp':frame['metadata']['timestamp'],'file':str(path),'sha256':sha(path)})
    return capture,records,start,end,size

def encode(manifest_path,output,role,backend):
    if output.exists(): raise ValueError('Retain existing output; choose a new destination')
    capture,records,wall_start,wall_end,size=load(manifest_path)
    if capture.get('backend',backend)!=backend:
        raise ValueError('Backend label differs from completed capture identity')
    times=[frame['timestamp'] for frame in records]
    seconds=wall_end-times[0]
    count=round(seconds*FPS)
    if count<=0: raise ValueError('Capture is shorter than an output frame')
    indices=[bisect.bisect_right(times,times[0]+n/FPS)-1 for n in range(count)]
    output.parent.mkdir(parents=True,exist_ok=True)
    args=['ffmpeg','-y','-hide_banner','-loglevel','error','-threads','2','-filter_threads','2',
          '-f','rawvideo','-pixel_format','rgb24','-video_size',f'{size[0]}x{size[1]}','-framerate',str(FPS),'-i','pipe:0',
          '-vf','scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
          '-an','-c:v','libx264','-threads','2','-preset','fast','-crf','17','-movflags','+faststart',str(output)]
    proc=subprocess.Popen(args,stdin=subprocess.PIPE)
    last=-1; pixels=None
    try:
        for index in indices:
            if index!=last:
                with Image.open(records[index]['file']) as im: pixels=im.convert('RGB').tobytes()
                last=index
            proc.stdin.write(pixels)
    finally: proc.stdin.close()
    if proc.wait(): raise RuntimeError('Real footage encoding failed')
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(output)],text=True))
    v=probe['streams'][0]
    if v['width']!=1920 or v['height']!=1080 or v['avg_frame_rate']!='30/1' or int(v['nb_frames'])!=count:
        raise ValueError('Encoded source differs from 1080p30 clock')
    duration=float(probe['format']['duration'])
    if abs(duration-seconds)>1/FPS+.001: raise ValueError('Source duration drift exceeds one CFR frame')
    subprocess.run(['ffmpeg','-v','error','-xerror','-threads','2','-i',str(output),'-f','null','-'],check=True)
    evidence={'kind':'footage','semanticRole':role,'source':str(output.resolve()),'sha256':sha(output),'frames':count,'fps':FPS,'duration':duration,
              'sourceIn':0,'backend':backend,'historical':False,'identityVerified':True,'visualReviewed':False,'subtitlePosition':'bottom','overlays':[],
              'rawManifest':str(manifest_path.resolve()),'rawManifestSha256':sha(manifest_path),'sourceFrames':len(records),'sourceSize':list(size),
              'publishedSourceIdentity':{key:capture.get(key) for key in ['url','projectId','sceneId','assetId','modelAssetId','deviceKey','backend'] if key in capture},
              'sourceDuration':seconds,'frameEventSpan':times[-1]-times[0],'captureWallStart':wall_start,'captureWallEnd':wall_end,
              'capturedIdleTail':wall_end-times[-1],'unobservedLead':times[0]-wall_start,'maxFrameGap':max(b-a for a,b in zip(times,times[1:])),
              'finalReadingHold':0,'durationQuantizationSeconds':duration-seconds,'arrivalInversions':sum(b<=a for a,b in zip([r['metadata']['timestamp'] for r in capture['frames']],[r['metadata']['timestamp'] for r in capture['frames']][1:])),
              'clockMethod':'Stable timestamp order; latest observed frame sampled at n/30 seconds; no time scaling or synthetic motion','fullDecode':'passed','sourceFrameIdentities':records}
    output.with_suffix('.evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in evidence.items() if k!='sourceFrameIdentities'},ensure_ascii=False),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('manifest',type=Path); parser.add_argument('output',type=Path); parser.add_argument('--role',required=True)
    parser.add_argument('--backend',required=True,choices=['webgl','webgpu','wasm','native'])
    opts=parser.parse_args(); encode(opts.manifest.resolve(),opts.output.resolve(),opts.role,opts.backend)
