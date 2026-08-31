import type { IceServerConfig } from "./config.js";

export function viewerHtml(sessionId: string, iceServers: IceServerConfig[]): string {
  const config = JSON.stringify({ sessionId, iceServers }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev Studio 云渲染</title><style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#090d0f;color:#dce5e8;font:13px system-ui,sans-serif}
video{width:100%;height:100%;object-fit:contain;outline:0}
.status{position:fixed;top:14px;left:14px;padding:8px 11px;border:1px solid #405058;border-radius:8px;background:#11191ddd;backdrop-filter:blur(10px)}
.status.ready{border-color:#31745e;color:#78ddb5}
.status.failed{border-color:#80414a;color:#f1a7af}
</style></head><body><video id="video" autoplay playsinline tabindex="0"></video><div id="status" class="status">正在建立真实 WebRTC 媒体…</div>
<script type="module">
const config=${config};
const viewerToken=new URLSearchParams(location.hash.slice(1)).get('token')||'';
history.replaceState(null,'',location.pathname);
const video=document.querySelector('#video');
const status=document.querySelector('#status');
const pc=new RTCPeerConnection({iceServers:config.iceServers});
let input;
pc.ontrack=event=>{
  video.srcObject=event.streams[0];
  video.play().catch(()=>{});
};
pc.ondatachannel=event=>{
  if(event.channel.label!=='input')return;
  input=event.channel;
  input.onopen=()=>{
    status.textContent='媒体与输入已连接';
    status.className='status ready';
    video.focus();
  };
};
pc.onconnectionstatechange=()=>{
  if(!['failed','closed','disconnected'].includes(pc.connectionState))return;
  status.textContent='WebRTC '+pc.connectionState;
  status.className='status failed';
};
void connect().catch(error=>{
  status.textContent='云渲染连接失败：'+(error instanceof Error?error.message:String(error));
  status.className='status failed';
  pc.close();
});
async function connect(){
  const offer=await fetchOffer();
  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  await waitIce(pc,10000);
  await fetch('/v1/viewer/'+encodeURIComponent(config.sessionId)+'/answer',{
    method:'POST',
    headers:{'content-type':'application/json','x-cloud-render-viewer-token':viewerToken},
    body:JSON.stringify(pc.localDescription),
    signal:AbortSignal.timeout(8000)
  }).then(assertResponse);
}
function send(value){
  if(input?.readyState==='open')input.send(JSON.stringify(value));
}
function point(event,action){
  const rect=video.getBoundingClientRect();
  const scale=Math.min(
    rect.width/(video.videoWidth||rect.width),
    rect.height/(video.videoHeight||rect.height)
  );
  const width=(video.videoWidth||rect.width)*scale;
  const height=(video.videoHeight||rect.height)*scale;
  const left=rect.left+(rect.width-width)/2;
  const top=rect.top+(rect.height-height)/2;
  send({
    type:'pointer',
    action,
    x:(event.clientX-left)/width,
    y:(event.clientY-top)/height,
    button:['left','middle','right'][event.button]??'left'
  });
}
video.addEventListener('pointermove',event=>point(event,'move'));
video.addEventListener('pointerdown',event=>{
  video.setPointerCapture(event.pointerId);
  point(event,'down');
});
video.addEventListener('pointerup',event=>point(event,'up'));
video.addEventListener('contextmenu',event=>event.preventDefault());
video.addEventListener('wheel',event=>{
  event.preventDefault();
  send({type:'wheel',deltaX:event.deltaX,deltaY:event.deltaY});
},{passive:false});
window.addEventListener('keydown',event=>{
  event.preventDefault();
  send({type:'key',action:'down',key:event.key});
});
window.addEventListener('keyup',event=>{
  event.preventDefault();
  send({type:'key',action:'up',key:event.key});
});
function waitIce(peer,timeoutMs){
  if(peer.iceGatheringState==='complete')return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('ICE gathering timeout')),timeoutMs);
    peer.addEventListener('icegatheringstatechange',()=>{
      if(peer.iceGatheringState!=='complete')return;
      clearTimeout(timeout);
      resolve();
    });
  });
}
async function fetchOffer(){
  const url='/v1/viewer/'+encodeURIComponent(config.sessionId)+'/offer';
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    try{
      const response=await fetch(url,{
        cache:'no-store',
        headers:{'x-cloud-render-viewer-token':viewerToken},
        signal:AbortSignal.timeout(Math.max(1,Math.min(3000,deadline-Date.now())))
      });
      if(response.ok)return response.json();
      if(response.status!==409)throw new Error('HTTP '+response.status);
    }catch(error){
      if(error instanceof Error&&error.message.startsWith('HTTP '))throw error;
    }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('渲染页启动超时');
}
function assertResponse(response){
  if(!response.ok)throw new Error('HTTP '+response.status);
  return response;
}
</script></body></html>`;
}
