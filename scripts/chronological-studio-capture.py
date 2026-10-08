"""Preserve CDP raw capture and derive stable original timestamp order for small arrival inversions."""
import copy
import hashlib
import json
from pathlib import Path
import sys

raw=Path(sys.argv[1]).resolve()
derived=raw.with_name('frames-chronological.json')
if derived.exists():
    raise ValueError('Preserve prior derived manifest')
capture=json.loads(raw.read_text(encoding='utf-8'))
frames=capture['frames']
inversions=[{'index':i,'file':a['file'],'nextFile':b['file'],
             'arrivalInversionMs':(a['metadata']['timestamp']-b['metadata']['timestamp'])*1000}
            for i,(a,b) in enumerate(zip(frames,frames[1:])) if b['metadata']['timestamp']<=a['metadata']['timestamp']]
if not inversions or any(not 0<x['arrivalInversionMs']<5 for x in inversions):
    raise ValueError('Only inspected sub-five-millisecond arrival inversions supported')
ordered=sorted(frames,key=lambda frame:frame['metadata']['timestamp'])
if any(a['metadata']['timestamp']>=b['metadata']['timestamp'] for a,b in zip(ordered,ordered[1:])):
    raise ValueError('Duplicate timestamps cannot be recovered')
sha=lambda p:hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
audit={'rawManifest':str(raw),'rawManifestSha256':sha(raw),'arrivalInversions':inversions,
       'method':'Stable original event timestamp order; raw pixels, timestamps and wall clock unchanged'}
result=copy.deepcopy(capture)
result['frames']=ordered
result['chronologyRecovery']=audit
derived.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
audit.update({'derivedManifest':str(derived),'derivedManifestSha256':sha(derived),'sourceFrames':len(frames),
              'derivedEventSpan':ordered[-1]['metadata']['timestamp']-ordered[0]['metadata']['timestamp'],
              'invertedFrameSha256':{f:sha(raw.parent/f) for x in inversions for f in [x['file'],x['nextFile']]}})
raw.with_name('chronology-recovery.evidence.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(audit,ensure_ascii=False))
