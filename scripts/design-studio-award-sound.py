"""Chapter automation and original abstract accents; no invented factory sounds."""
import hashlib
import json
from pathlib import Path
import wave
import numpy as np

ROOT=Path(__file__).resolve().parent.parent
BASE=ROOT/'deliverables/studio-020-20261007/intro-award-v2-20261008'
OUT=BASE/'art-revision'
OUT.mkdir(exist_ok=True)
SOURCE=Path('D:/Documents/bim/deliverables/system-intro-20260925/music-original.wav')
RATE=48000
DURATION=7328/30
with wave.open(str(SOURCE),'rb') as source:
    assert source.getsampwidth()==2 and source.getnchannels()==2 and source.getframerate()==RATE
    original=np.frombuffer(source.readframes(source.getnframes()),dtype='<i2').reshape(-1,2).astype(np.float32)/32768

# Find a stronger existing rhythmic passage by stereo envelope changes.
window=RATE//20
levels=np.array([np.sqrt(np.mean(original[n:n+window]**2)) for n in range(0,len(original)-window,window)])
flux=np.maximum(0,np.diff(levels))
candidates=[(float(np.mean(flux[n:n+300])),n/20) for n in range(200,len(flux)-300,20)]
engine_in=max(candidates)[1]
EVENTS=[
    {'time':39.0,'frequency':392,'role':'editorial engineering-node convergence'},
    {'time':73.25,'frequency':440,'role':'editorial data-line arrival'},
    {'time':97.0,'frequency':494,'role':'editorial relation-graph arrival'},
    {'time':165.13,'frequency':220,'role':'editorial batch convergence'},
    {'time':166.63,'frequency':330,'role':'editorial incremental change'},
    {'time':167.83,'frequency':440,'role':'editorial near-far completion'},
]

def gain(t):
    knots=np.array([0,2.1,2.6,7.5,7.7,8.4,8.65,12.1,12.4,13.2,60.0,60.4,
                    108.1,108.5,158.7,159.0,232.2,232.67,238.6,239.3,DURATION])
    values=np.array([0,0,.10,.10,0,0,.08,.08,.14,.85,.85,.92,
                     .92,.42,.42,.90,.90,.25,.25,.12,0])
    return np.interp(t,knots,values)

target=OUT/'soundtrack-art.wav'
with wave.open(str(target),'wb') as output:
    output.setnchannels(2);output.setsampwidth(2);output.setframerate(RATE)
    for offset in range(0,round(DURATION*RATE),RATE):
        length=min(RATE,round(DURATION*RATE)-offset)
        t=(offset+np.arange(length))/RATE
        normal=original[(offset+np.arange(length))%len(original)]
        alternate=original[(np.maximum(0,((t-159+engine_in)*RATE).astype(np.int64)))%len(original)]
        progress=np.clip((t-158.925)/.15,0,1)
        score=normal*np.cos(progress*np.pi/2)[:,None]+alternate*np.sin(progress*np.pi/2)[:,None]
        score*=gain(t)[:,None]
        # An abstract, quiet opening air tone. It has no device or room identity.
        air=.016*(np.sin(2*np.pi*98*t)+.3*np.sin(2*np.pi*146*t))
        air*=np.clip(1-t/2.1,0,1)
        score+=air[:,None]
        # Clean pulse enters with the data chapter, recedes for reading, and returns
        # in the mechanism section. It is a musical cue, not a product click.
        beat_phase=np.mod(t-60.4,.625)
        beat_gate=((t>=60.4)&(t<108.5))|((t>=159)&(t<232.2))
        pulse=.04*np.sin(2*np.pi*(64*beat_phase-17*beat_phase**2))*np.exp(-beat_phase*24)*beat_gate
        score+=pulse[:,None]
        for event in EVENTS:
            dt=t-event['time']
            envelope=np.where((dt>=0)&(dt<.25),np.exp(-np.maximum(dt,0)*20)*np.minimum(np.maximum(dt,0)/.008,1),0)
            note=.12*(np.sin(2*np.pi*event['frequency']*dt)+.18*np.sin(2*np.pi*event['frequency']*2*dt))*envelope
            score+=note[:,None]
        output.writeframes((np.clip(score,-.98,.98)*32767).astype('<i2').tobytes())

digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
identity={'source':str(target),'sha256':digest(target),'origin':'Self-composed original music with authored chapter automation and abstract musical accents',
          'baseSource':str(SOURCE),'baseSha256':digest(SOURCE),'duration':DURATION,'enginePassageSourceIn':engine_in,
          'events':EVENTS,'speechDucking':'Applied downstream from the unchanged actual narrator waveform',
          'deviceAudio':False}
(OUT/'soundtrack-art.json').write_text(json.dumps(identity,ensure_ascii=False,indent=2),encoding='utf-8')
edl=json.loads((OUT/'edl.json').read_text(encoding='utf-8'))
edl['soundtrack']=identity
(OUT/'edl.json').write_text(json.dumps(edl,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'source':str(target),'enginePassageSourceIn':engine_in,'sha256':identity['sha256']}))
