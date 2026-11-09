import {GarmentController} from './controller.js';
import {rackPositions,slideStep} from './rack-layout.js';
import {mobileRailPositions,mobileSwipeDestination} from './mobile-rail.js';
import {validateCatalog,validateManifest,localAsset} from './catalog.js';
import {createCloth,stepCloth,rowOffset} from './cloth.js';

const $=selector=>document.querySelector(selector);
const rack=$('#rack'),holder=$('#rack-items');
const banner=new URLSearchParams(location.search).has('banner');if(banner)document.documentElement.classList.add('banner');
const mobile=matchMedia('(max-width:700px)'),reduced=matchMedia('(prefers-reduced-motion:reduce)');
let catalog,states=[],active=-1,selected=0,pending=-1,intentTimer,ready=false,raf=0,lastTime=0,drag=null,railOffset=0,railVelocity=0,suppressClickUntil=0;
/* Every file is requested with the release stamp from index.html (?v=...), so a new release reaches
   visitors at once instead of after the host's 10-minute cache. */
const RELEASE=new URL(import.meta.url).searchParams.get('v');
const bust=u=>{if(RELEASE)u.searchParams.set('v',RELEASE);return u;};
const manifestUrl=item=>bust(new URL('../public/'+item.motion,import.meta.url));
const assetUrl=(item,file)=>bust(new URL(file,manifestUrl(item)));
function updateInfo(index){
  selected=index;const item=catalog.items[index];
  $('#selected-index').textContent=String(index+1).padStart(2,'0')+' / '+String(states.length).padStart(2,'0');
  $('#selected-name').textContent=item.name;$('#selected-type').textContent=[item.type,item.color].filter(Boolean).join(' · ');$('#selected-price').textContent=item.price||'';
  $('#previous').disabled=!ready||index===0;$('#next').disabled=!ready||index===states.length-1;
}
function cell(s,frame){const {width:w,height:h,columns}=s.manifest;return [(frame%columns)*w,Math.floor(frame/columns)*h,w,h];}
function paint(s,frame){paintBlend(s,frame);}
/* Compose one moment of the turn into a buffer of width W: shadow, hanger behind the garment,
   the garment (cross-faded atlas frames, sharp stills at rest), then the hanger seen inside the
   collar or hood once the garment faces the camera. Mid-turn this runs on a small buffer at atlas
   resolution (the frames hold no more detail than that), which keeps every turn light. */
function compose(ctx,s,exact,W,H){
  const m=s.manifest,last=m.frameCount-1,f=W/m.width,oy=(m.hanger?.garmentDrop||0)*f,gh=H-oy;
  ctx.clearRect(0,0,W,H);
  drawShadow(ctx,s,exact/last,W,H,oy);
  drawHanger(ctx,s,exact,f,oy,false);
  if(exact<.02&&s.profileStill){ctx.globalAlpha=1;ctx.drawImage(s.profileStill,0,oy,W,gh);}
  else if(exact>last-.02&&s.frontStill){ctx.globalAlpha=1;ctx.drawImage(s.frontStill,0,oy,W,gh);}
  else{
    const a=Math.max(0,Math.min(last,Math.floor(exact))),b=Math.min(last,a+1),t=exact-a;
    ctx.globalAlpha=1;ctx.drawImage(s.frames[a],0,oy,W,gh);
    if(t>.02&&a!==b){ctx.globalAlpha=t;ctx.drawImage(s.frames[b],0,oy,W,gh);}
    /* Fade the full-resolution still out over the first/last frame and a half, so leaving or
       reaching a rest pose never pops between the sharp still and the motion frames. */
    const w0=Math.max(0,1-exact/1.5),w1=Math.max(0,1-(last-exact)/1.5);
    if(w0>0&&s.profileStill){ctx.globalAlpha=w0;ctx.drawImage(s.profileStill,0,oy,W,gh);}
    if(w1>0&&s.frontStill){ctx.globalAlpha=w1;ctx.drawImage(s.frontStill,0,oy,W,gh);}
  }
  ctx.globalAlpha=1;drawHanger(ctx,s,exact,f,oy,true);ctx.globalAlpha=1;
}
function paintBlend(s,exact){
  if(!s.image)return;
  const last=s.manifest.frameCount-1,low=exact>=1.5&&exact<=last-1.5;
  const target=low?s.lbuffer:s.buffer,ctx=low?s.lctx:s.bctx;
  compose(ctx,s,exact,target.width,target.height);s.source=target;
  s.button.dataset.frame=String(Math.round(exact));present(s);
}
/* Soft drop shadow, baked once per rest pose at half resolution. A CSS drop-shadow filter on the
   canvas was re-blurred on every animation frame and halved the frame rate. */
const SHADOW={scale:.5,pad:60};
function bakeShadow(still){
  if(!still)return null;const {scale:k,pad}=SHADOW,w=Math.round(still.width*k),h=Math.round(still.height*k);
  const sil=document.createElement('canvas');sil.width=w;sil.height=h;const sc=sil.getContext('2d');
  sc.drawImage(still,0,0,w,h);sc.globalCompositeOperation='source-in';sc.fillStyle='rgb(48,40,32)';sc.fillRect(0,0,w,h);
  const c=document.createElement('canvas');c.width=w+2*pad;c.height=h+2*pad;const x=c.getContext('2d');
  const u=still.width/430*k; // one CSS pixel of the displayed garment, in shadow pixels
  x.filter=`blur(${(10*u).toFixed(1)}px)`;x.globalAlpha=.2;x.drawImage(sil,pad,pad+16*u);
  x.filter=`blur(${(1.5*u).toFixed(1)}px)`;x.globalAlpha=.12;x.drawImage(sil,pad,pad+2*u);
  return c;
}
function drawShadow(ctx,s,p,W,H,oy){
  const gh=H-oy,{pad}=SHADOW;
  const one=(sh,a)=>{if(!sh||a<=.01)return;const kx=W/(sh.width-2*pad),ky=gh/(sh.height-2*pad);ctx.globalAlpha=a;ctx.drawImage(sh,-pad*kx,oy-pad*ky,W+2*pad*kx,gh+2*pad*ky);};
  p=Math.max(0,Math.min(1,p));one(s.profileShadow,1-p);one(s.frontShadow,p);ctx.globalAlpha=1;
}
function canvasRatio(m){const w=m.stillWidth||m.width,h=m.stillHeight||m.height;return (h+(m.hanger?.garmentDrop||0)*w/m.width)/w;}
/* Shared 3D-rendered metal hanger, turned to the garment's angle. It sits inside the garment
   (manifest hanger.seat, garment pixels): drawn once behind the garment, and once more in front,
   clipped to the collar or hood opening, while the garment faces the camera. */
let hanger=null;
function hangerAngle(s,exact){
  const list=s.manifest.hangerAngles,n=s.manifest.frameCount;if(!Array.isArray(list)||list.length!==n)return 90*(1-exact/(n-1));
  const a=Math.max(0,Math.min(n-1,Math.floor(exact))),b=Math.min(n-1,a+1),t=exact-a;return list[a]+(list[b]-list[a])*t;
}
function drawHanger(ctx,s,exact,f,oy,front){
  const h=s.manifest.hanger;if(!hanger||!h||!Array.isArray(h.seat))return;
  const angle=hangerAngle(s,exact),open=Array.isArray(h.opening)&&h.opening.length>2;
  /* Facing the camera, only the part seen through the opening is drawn; the rest is inside the
     garment. As it turns away, the hanger behind the garment takes over. */
  const facing=open?Math.max(0,Math.min(1,(40-angle)/30)):0;
  if(front&&!open)return;
  const alpha=front?facing:open?1-facing:1;if(alpha<=.001)return;
  const {cellWidth:cw,cellHeight:ch,columns,steps,maxDegrees,apex,span}=hanger.meta;
  const k=h.span*f/span,ky=k*(h.stretch||1),sx=h.seat[0]*f,sy=h.seat[1]*f+oy,dx=sx-apex[0]*k,dy=sy-apex[1]*ky;
  if(Array.isArray(h.hook)){ // steel stem from the rail hook down to the hanger
    const x=h.hook[0]*f,r=Math.max(1,(h.stem||1.75)*f*s.manifest.width/s.displayWidth),g=ctx.createLinearGradient(x-r,0,x+r,0);
    g.addColorStop(0,'#6f7479');g.addColorStop(.32,'#f1f3f5');g.addColorStop(.62,'#a7acb1');g.addColorStop(1,'#62676c');
    ctx.globalAlpha=alpha;ctx.fillStyle=g;ctx.fillRect(x-r,h.hook[1]*f-1,2*r,sy-h.hook[1]*f+2*ky);
  }
  if(!front&&open)return; // the body sits inside the garment: from behind it would only poke out past the shoulders
  if(front){ctx.save();ctx.beginPath();h.opening.forEach(([x,y],i)=>{i?ctx.lineTo(x*f,y*f+oy):ctx.moveTo(x*f,y*f+oy);});ctx.closePath();ctx.clip();}
  const pos=Math.max(0,Math.min(1,angle/maxDegrees))*(steps-1),i=Math.floor(pos),j=Math.min(steps-1,i+1),t=pos-i;
  const src=n=>[(n%columns)*cw,Math.floor(n/columns)*ch,cw,ch];
  if(front&&h.shade>0){
    /* Inside a collar or hood the metal sits in the fabric's shade: darken it on a scratch canvas. */
    const sc=hanger.scratch||(hanger.scratch=document.createElement('canvas')),w=Math.ceil(cw*k),hh=Math.ceil(ch*ky);
    if(sc.width<w||sc.height<hh){sc.width=Math.max(sc.width,w);sc.height=Math.max(sc.height,hh);}
    const x=sc.getContext('2d');x.globalCompositeOperation='source-over';x.globalAlpha=1;x.clearRect(0,0,w,hh);
    x.drawImage(hanger.image,...src(i),0,0,w,hh);if(t>.02&&j!==i){x.globalAlpha=t;x.drawImage(hanger.image,...src(j),0,0,w,hh);x.globalAlpha=1;}
    x.globalCompositeOperation='source-atop';x.fillStyle=`rgba(${h.shadeColor||'20,20,24'},${h.shade})`;x.fillRect(0,0,w,hh);x.globalCompositeOperation='source-over';
    ctx.globalAlpha=alpha;ctx.drawImage(sc,0,0,w,hh,dx,dy,w,hh);
  }else{
    ctx.globalAlpha=alpha;ctx.drawImage(hanger.image,...src(i),dx,dy,cw*k,ch*ky);
    if(t>.02&&j!==i){ctx.globalAlpha=alpha*t;ctx.drawImage(hanger.image,...src(j),dx,dy,cw*k,ch*ky);}
  }
  if(front)ctx.restore();
  ctx.globalAlpha=1;
}
/* Copy the composed buffer to screen with the cloth response: a small swing about the hook and a
   hem that trails the turn and ripples. At rest it is a single 1:1 copy, so stills stay sharp. */
function present(s){
  const cw=s.canvas.width,ch=s.canvas.height,ctx=s.ctx,c=s.cloth,src=s.source||s.buffer;
  const f=cw/s.manifest.width,px=(s.manifest.pivot?.[0]??.5)*cw,py=(s.manifest.pivot?.[1]??.03)*s.manifest.height*f;
  ctx.clearRect(0,0,cw,ch);
  const still=reduced.matches||(Math.abs(c.swing)<1e-4&&Math.abs(c.lag)<.05&&c.ripple<.01);
  if(still){ctx.drawImage(src,0,0,src.width,src.height,0,0,cw,ch);return;}
  /* Hem lag and ripple: shift whole rows sideways in an unrotated scratch canvas at the buffer's own
     resolution (seamless, since row edges stay on the pixel grid), then swing it about the hook in one draw. */
  const w=s.warp||(s.warp=document.createElement('canvas')),sw=src.width,sh=src.height,k=sh/ch;
  if(w.width!==sw||w.height!==sh){w.width=sw;w.height=sh;}
  const wx=w.getContext('2d');wx.clearRect(0,0,sw,sh);
  const top=Math.floor(py*k),step=Math.max(2,Math.round(sh/60)),sf=sw/s.manifest.width;wx.drawImage(src,0,0,sw,top,0,0,sw,top);
  for(let y=top;y<sh;y+=step){const hh=Math.min(step,sh-y),u=(y/k-py)/(ch-py);wx.drawImage(src,0,y,sw,hh,rowOffset(c,u)*sf,y,sw,hh);}
  ctx.save();ctx.translate(px,py);ctx.rotate(c.swing);ctx.translate(-px,-py);ctx.drawImage(w,0,0,sw,sh,0,0,cw,ch);ctx.restore();
}
function sizeCanvas(s){
  const m=s.manifest,maxW=m.stillWidth||m.width,ratio=canvasRatio(m);
  const w=Math.max(m.width,Math.min(maxW,Math.round(s.displayWidth*Math.min(devicePixelRatio||1,2))));
  if(s.canvas.width===w)return;
  s.canvas.width=w;s.canvas.height=Math.round(w*ratio);s.buffer.width=w;s.buffer.height=s.canvas.height;
  s.lbuffer.width=m.width;s.lbuffer.height=Math.round(m.width*ratio);
  for(const c of [s.ctx,s.bctx,s.lctx]){c.imageSmoothingEnabled=true;c.imageSmoothingQuality=mobile.matches?'medium':'high';}
  if(s.image)paintBlend(s,s.controller.position*(m.frameCount-1));
}
/* One small canvas per frame (same memory as the atlas): each draw touches only that frame,
   never a re-decode or a copy of the whole atlas. */
function sliceFrames(img,m){
  const out=[];
  for(let i=0;i<m.frameCount;i++){const c=document.createElement('canvas');c.width=m.width;c.height=m.height;
    c.getContext('2d').drawImage(img,(i%m.columns)*m.width,Math.floor(i/m.columns)*m.height,m.width,m.height,0,0,m.width,m.height);out.push(c);}
  return out;
}
function resident(img){
  const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
  c.getContext('2d').drawImage(img,0,0);return c;
}
/* Move garments with a composited transform instead of `left`: no layout per frame and no
   whole-pixel snapping, which made the garments shiver while the rail was swiped on phones. */
function place(s){s.button.style.transform=`translate3d(${s.position.toFixed(2)}px,0,0) translateX(-50%)`;}
function activate(index){
  if(!ready)return;
  active=index;
  states.forEach((s,i)=>{s.button.classList.toggle('active',i===index);s.controller.setTarget(i===index?1:0,{immediate:reduced.matches});});
  if(index>=0)updateInfo(index);
  wake();
}
function cancelIntent(){clearTimeout(intentTimer);intentTimer=undefined;pending=-1;}
function intend(index){
  if(!ready||pending===index||active===index)return;
  cancelIntent();pending=index;
  if(index<0){activate(-1);return;}
  intentTimer=setTimeout(()=>{pending=-1;activate(index);},catalog.timing.intentMs);
}
function targets(){
  const width=holder.clientWidth,garmentWidth=states[0]?.displayWidth||370;
  if(mobile.matches)return mobileRailPositions({width,items:states.map(s=>({half:s.displayWidth*(.08+.35*s.controller.position)})),focus:selected,offset:railOffset,gap:banner?48:12});
  return rackPositions({count:states.length,width,garmentWidth,active,minimumSpread:35});
}
function tick(time){
  const dt=lastTime?Math.min(50,time-lastTime):0;lastTime=time;
  let moving=false;
  if(mobile.matches&&!drag){
    const next=slideStep(railOffset,railVelocity,0,dt,23);railOffset=next.position;railVelocity=next.velocity;
    moving ||=Math.abs(railOffset)>.03||Math.abs(railVelocity)>.2;
    if(!moving&&active!==selected)intend(selected);
  }
  for(const s of states){
    moving=s.controller.step(dt)||moving;
    if(reduced.matches||!s.image)continue;
    const alive=stepCloth(s.cloth,s.controller.position,dt);
    if(alive||s.clothAlive)present(s); // one last copy when it comes to rest
    s.clothAlive=alive;moving ||=alive;
  }
  const positions=targets();
  states.forEach((s,i)=>{
    const next=reduced.matches?{position:positions[i],velocity:0}:slideStep(s.position,s.velocity,positions[i],dt,active<0?30:28);
    s.position=next.position;s.velocity=next.velocity;place(s);
    moving ||=Math.abs(s.position-positions[i])>.03||Math.abs(s.velocity)>.2;
  });
  if(moving)raf=requestAnimationFrame(tick);else{raf=0;lastTime=0;}
}
function wake(){if(!raf&&!document.hidden)raf=requestAnimationFrame(tick);}
function stop(){cancelAnimationFrame(raf);raf=0;lastTime=0;}
function layout(){
  if(!states.length)return;
  const displayWidth=mobile.matches?(banner?Math.min(260,Math.round(innerWidth*.66)):315):banner?(innerWidth>=1600?470:innerWidth>=1200?430:380):innerWidth>=1400?400:370;
  states.forEach(s=>{s.displayWidth=displayWidth;s.button.style.setProperty('--garment-width',displayWidth+'px');sizeCanvas(s);});
  $('#interaction-hint').textContent=mobile.matches?'Glissez pour parcourir · Touchez pour voir':'Survolez pour tourner la pièce · Cliquez pour voir';
  cancelIntent();drag=null;railOffset=0;railVelocity=0;
  const positions=targets();states.forEach((s,i)=>{s.position=positions[i];s.velocity=0;place(s);});
  activate(mobile.matches?selected:-1);wake();
}
function hitAt(x){
  let nearest=-1,best=Infinity;
  states.forEach((s,i)=>{const d=Math.abs(x-s.position),half=i===active?s.displayWidth*.43:30;if(d<=half&&d<best){nearest=i;best=d;}});
  return nearest;
}
rack.addEventListener('pointermove',event=>{
  if(!ready||$('#product-dialog').open||$('#about-dialog').open)return;
  if(drag&&event.pointerId===drag.id){
    const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;
    if(!drag.horizontal&&Math.abs(dx)>7&&Math.abs(dx)>Math.abs(dy)*1.2){drag.horizontal=true;rack.setPointerCapture(event.pointerId);cancelIntent();activate(-1);}
    if(!drag.horizontal)return;
    const now=performance.now();drag.velocity=(event.clientX-drag.lastX)/Math.max(1,now-drag.lastTime);drag.lastX=event.clientX;drag.lastTime=now;
    railOffset=dx;railVelocity=0;wake();return;
  }
  if(!mobile.matches&&event.pointerType!=='touch')intend(hitAt(event.clientX-holder.getBoundingClientRect().left));
});
rack.addEventListener('pointerleave',()=>{if(!mobile.matches&&!drag){cancelIntent();activate(-1);}});
rack.addEventListener('pointerdown',event=>{
  if(!ready||!mobile.matches||event.button!==0)return;
  const now=performance.now();drag={id:event.pointerId,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastTime:now,velocity:0,horizontal:false};
});
function endDrag(event){
  if(!drag||event.pointerId!==drag.id)return;
  const previous=drag;drag=null;
  if(previous.horizontal){
    const width=rack.clientWidth,positions=targets();
    const next=mobileSwipeDestination({positions,width,focus:selected,delta:railOffset,velocity:previous.velocity});
    const offset=positions[next]-width/2;selected=next;railOffset=offset;railVelocity=0;updateInfo(next);suppressClickUntil=performance.now()+450;
    if(rack.hasPointerCapture(event.pointerId))rack.releasePointerCapture(event.pointerId);
    if(reduced.matches)railOffset=0;
    wake();
  }
}
rack.addEventListener('pointerup',endDrag);rack.addEventListener('pointercancel',event=>{if(drag?.id===event.pointerId){drag=null;railOffset=0;railVelocity=0;wake();}});
rack.addEventListener('click',event=>{
  if(!ready||performance.now()<suppressClickUntil)return;
  const button=event.target.closest('.garment');if(!button)return;
  const index=Number(button.dataset.index);
  if(mobile.matches&&index!==selected){browse(index);return;}
  openProduct(index);
});
function browse(index){
  if(!ready)return;
  index=Math.max(0,Math.min(states.length-1,index));cancelIntent();
  if(mobile.matches){const p=targets();railOffset=p[index]-rack.clientWidth/2;railVelocity=0;selected=index;activate(-1);if(reduced.matches)railOffset=0;updateInfo(index);wake();}
  else activate(index);
}
$('#previous').addEventListener('click',()=>browse(selected-1));$('#next').addEventListener('click',()=>browse(selected+1));
$('#inspect').addEventListener('click',()=>openProduct(selected));
function detailSide(back){
  const item=catalog.items[selected],s=states[selected];
  $('#detail-image').src=back?bust(new URL('../public/'+item.back,import.meta.url)).href:assetUrl(item,s.manifest.front).href;
  $('#detail-image').alt=item.name+' — '+(back?'dos':'face');
  $('#view-front').setAttribute('aria-pressed',String(!back));$('#view-back').setAttribute('aria-pressed',String(back));
}
function openProduct(index){
  if(!ready)return;
  cancelIntent();activate(index);const item=catalog.items[index];
  $('#product-title').textContent=item.name;$('#product-type').textContent=item.type||'';$('#product-description').textContent=item.description||'';$('#product-color').textContent=item.color||'—';
  for(const [key,value] of [['price',item.price],['sizes',Array.isArray(item.sizes)?item.sizes.join(' · '):item.sizes]]){const row=$('#product-'+key);row.textContent=value||'';row.parentElement.hidden=!value;}
  $('#product-preview').textContent=item.previewLabel||(states[index].manifest.source?.kind==='original-procedural-illustration'?'Illustration originale':'Images produit préparées');
  $('#view-back').hidden=!item.back;$('#view-back').disabled=!item.back;
  const link=$('#product-link');link.hidden=!item.productUrl;if(item.productUrl){link.href=item.productUrl;link.target=banner?'_top':'_blank';}
  detailSide(false);$('#product-dialog').showModal();
}
$('#view-front').addEventListener('click',()=>detailSide(false));$('#view-back').addEventListener('click',()=>detailSide(true));
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>document.getElementById(button.dataset.close).close()));
$('#about-open').addEventListener('click',()=>{cancelIntent();$('#about-dialog').showModal();});
document.querySelectorAll('dialog').forEach(dialog=>{
  dialog.addEventListener('close',()=>{if(!mobile.matches)activate(-1);});
  dialog.addEventListener('click',event=>{const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();});
});
addEventListener('resize',layout);mobile.addEventListener('change',layout);reduced.addEventListener('change',()=>activate(active));
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelIntent();stop();}else wake();});
async function boot(){
  try{
    const response=await fetch(bust(new URL('../config/catalog.json',import.meta.url)));if(!response.ok)throw new Error('Catalog not found.');
    catalog=validateCatalog(await response.json());$('#site-title').firstChild.textContent=catalog.title||'Garment Showcase';
    for(const [i,item] of catalog.items.entries()){
      const res=await fetch(manifestUrl(item));if(!res.ok)throw new Error('Motion manifest not found: '+item.id);
      const manifest=validateManifest(await res.json());
      const button=document.createElement('button');button.className='garment';button.dataset.index=String(i);button.setAttribute('aria-label','Inspect '+item.name);button.disabled=true;
      const wire=document.createElement('span');wire.className='wire';wire.setAttribute('aria-hidden','true');
      const fallback=document.createElement('img');fallback.src=assetUrl(item,manifest.profile).href;fallback.alt='';fallback.width=manifest.width;fallback.height=manifest.height;
      const canvas=document.createElement('canvas');canvas.width=manifest.stillWidth||manifest.width;canvas.height=Math.round(canvas.width*canvasRatio(manifest));canvas.setAttribute('aria-hidden','true');
      button.append(wire,fallback,canvas);holder.append(button);
      const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
      const buffer=document.createElement('canvas');buffer.width=canvas.width;buffer.height=canvas.height;const bctx=buffer.getContext('2d');
      const lbuffer=document.createElement('canvas');lbuffer.width=manifest.width;lbuffer.height=Math.round(manifest.width*canvasRatio(manifest));const lctx=lbuffer.getContext('2d');
      const state={button,manifest,canvas,ctx,buffer,bctx,lbuffer,lctx,source:null,cloth:createCloth(),clothAlive:false,image:null,position:0,velocity:0,displayWidth:370};
      state.controller=new GarmentController({frameCount:manifest.frameCount,durationMs:catalog.timing.turnMs,returnDurationMs:catalog.timing.returnMs,endpointWindow:catalog.timing.endpointWindow,onFrame:()=>{},onProgress:exact=>paintBlend(state,exact)});
      button.addEventListener('focus',()=>{if(button.matches(':focus-visible'))browse(i);});
      button.addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();const next=Math.max(0,Math.min(states.length-1,i+(event.key==='ArrowRight'?1:-1)));states[next].button.focus();browse(next);}});
      states.push(state);
    }
    const withHanger=states.find(s=>s.manifest.hanger);
    if(withHanger){
      try{
        const h=withHanger.manifest.hanger,img=new Image();img.src=bust(new URL('../public/'+localAsset(h.atlas),import.meta.url)).href;
        const meta=await (await fetch(bust(new URL('../public/'+localAsset(h.meta),import.meta.url)))).json();await img.decode();
        if(meta&&meta.steps>1&&meta.cellWidth>0&&meta.cellHeight>0&&meta.span>0)hanger={image:resident(img),meta};
      }catch(error){console.warn('Hanger not loaded:',error.message);}
    }
    layout();let loaded=0;$('#load-counter').textContent=`0 / ${states.length}`;
    await Promise.all(states.map(async(s,i)=>{
      const image=new Image();image.src=assetUrl(catalog.items[i],s.manifest.atlas).href;await image.decode();
      const {width,height,columns,frameCount}=s.manifest;
      if(image.naturalWidth!==width*columns||image.naturalHeight!==height*Math.ceil(frameCount/columns))throw new Error('Atlas dimensions do not match manifest: '+catalog.items[i].id);
      const still=async name=>{const im=new Image();im.src=assetUrl(catalog.items[i],s.manifest[name]).href;try{await im.decode();return resident(im);}catch{return null;}};
      [s.profileStill,s.frontStill]=await Promise.all([still('profile'),still(s.manifest.turn?'turn':'front')]);
      s.image=image;s.frames=sliceFrames(image,s.manifest);s.profileShadow=bakeShadow(s.profileStill);s.frontShadow=bakeShadow(s.frontStill);
      /* Atlas and stills are copied into canvases once: a large <img> can be evicted from the decode
         cache and re-decoded on the next draw, which showed up as a ~0.4 s hitch when a turn started. */
      paint(s,0);s.button.classList.add('ready');$('#load-counter').textContent=`${++loaded} / ${states.length}`;
    }));
    ready=true;states.forEach(s=>s.button.disabled=false);rack.setAttribute('aria-busy','false');$('#load-state').hidden=true;$('#inspect').disabled=false;updateInfo(selected);layout();
    document.documentElement.dataset.ready='true';
  }catch(error){$('#load-text').textContent='Chargement impossible';$('#load-counter').textContent='Vérifiez les fichiers';rack.setAttribute('aria-busy','false');console.error(error.message);}
}
boot();

/* In banner mode, report the page height to the embedding shop page so the iframe never crops. */
if(banner&&window.parent!==window){
  let last=0;const send=()=>{const m=document.querySelector('main'),h=Math.ceil(m.getBoundingClientRect().bottom+scrollY);if(Math.abs(h-last)>1){last=h;window.parent.postMessage({type:'riches-banner-height',height:h},'*');}};
  new ResizeObserver(send).observe(document.querySelector('main'));addEventListener('load',send);
}
