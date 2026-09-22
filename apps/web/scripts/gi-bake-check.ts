import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { giFixture } from './gi-bake-fixture';
import { bakeWebLightmap } from '../src/optimizer/lightmapBaker';
const results: unknown[] = [], files: number[][] = [];
const runtime = window as typeof window & { result?: unknown; files?: number[][]; failure?: string };
try {
  for (const samples of [0,64] as const) {
    const document = giFixture();
    const result = await bakeWebLightmap(document,{resolution:256,strength:1,ambient:.3,ambientColor:'#ffffff',ambientOcclusion:false,aoSamples:4,
      shadows:true,shadowSamples:1,indirectSamples:samples,denoise:true,lights:[{id:'sun',name:'sun',type:'directional',enabled:true,color:'#ffffff',intensity:2,
        direction:[1,1,1],position:[5,5,5],range:100}]});
    const bytes = await new WebIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document);files.push([...bytes]);
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer as ArrayBuffer,'');
    const panel = window.document.getElementById(samples?'on':'off')!,width=panel.clientWidth,height=600;
    const renderer = new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(width,height);
    renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;panel.append(renderer.domElement);
    const scene = new THREE.Scene();scene.background = new THREE.Color(getComputedStyle(panel).backgroundColor);
    const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();scene.environment=pmrem.fromScene(room).texture;scene.environmentIntensity=.2;
    scene.add(gltf.scene);const sun = new THREE.DirectionalLight(0xffffff,2);sun.position.set(5,5,5);scene.add(sun);
    const camera = new THREE.PerspectiveCamera(42,width/height,.01,100);
    const bounds = new THREE.Box3().setFromObject(gltf.scene), sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
    const distance = sphere.radius / Math.sin(Math.min(vertical, horizontal)) * 1.05;
    camera.position.copy(sphere.center).addScaledVector(new THREE.Vector3(6,4,7).normalize(),distance);
    camera.far=distance+sphere.radius*3;camera.updateProjectionMatrix();camera.lookAt(sphere.center);
    const projectedBounds: number[][] = [];
    for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){
      camera.updateMatrixWorld();projectedBounds.push(new THREE.Vector3(x,y,z).project(camera).toArray());
    }
    renderer.render(scene,camera);results.push({...result,glbBytes:bytes.length,drawCalls:renderer.info.render.calls,projectedBounds});
  }
  runtime.result=results;runtime.files=files;window.document.getElementById('status')!.textContent='GLB 导出与重新加载完成';
}catch(error){runtime.failure=String(error);throw error;}
