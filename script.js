/* ── PROMPTS ── */
const PROMPTS_SOLO = [
  { act: 'Act I',   text: 'Look into the lens.\nRelax your face.',                       sub: 'Keep it simple'     },
  { act: 'Act II',  text: 'Shift your body slightly.\nKeep your eyes soft.',              sub: 'Let it feel natural' },
  { act: 'Act III', text: 'Look away for a second.\nLike you\'re thinking of something.', sub: 'Keep it effortless'  },
  { act: 'Act IV',  text: 'Do something a little unexpected.\nMake it memorable.',        sub: 'One last moment'     }
];

// Classic duet — both backgrounds stay, emotional direction only
const PROMPTS_DUET_CLASSIC = [
  { act: 'Act I',   text: 'Look into the lens.\nImagine them right beside you.',          sub: 'You\'re together'    },
  { act: 'Act II',  text: 'Look just past the lens.\nToward where they are.',     sub: 'See them there'   },
  { act: 'Act III', text: 'Make half of something.\nA heart, a shape, anything.',  sub: "They'll finish it"      },
  { act: 'Act IV',  text: "End with something iconic.\nDo something weird together.\nA pose you'll remember.",   sub: 'One last moment'     }
];

// Together duet — backgrounds removed, position cues matter
const PROMPTS_DUET_TOGETHER = [
  { act: 'Act I',   text: 'Center yourself in frame.\nWaist up. Same distance as them.', sub: 'Get in position'     },
  { act: 'Act II',  text: 'Angle your body toward their side.\nNot a profile. Just aware of their presence.', sub: 'Turn slightly inward' },
  { act: 'Act III', text: 'Make half of something.\nA heart, a shape, anything.',  sub: "They'll finish it"      },
  { act: 'Act IV',  text: "Keep the angle.\nDo something weird together.\nA pose you'll remember.",   sub: 'End with something iconic'     }
];

function getPrompts() {
  if (!S.isDuet) return PROMPTS_SOLO;
  return S.mode === 'together' ? PROMPTS_DUET_TOGETHER : PROMPTS_DUET_CLASSIC;
}

/* ── STATE ── */
const S = {
  code: null,
  isDuet: false,
  isHost: false,
  mode: 'classic',           // 'classic' | 'together'
  idx: 0,
  photosYou: [],
  photosPartner: [],
  compositedFrames: [],
  localStream: null,
  peer: null,
  conn: null,
  call: null,
  youReady: false,
  partnerReady: false,
  orient: 'vert',
  stamp: null,
  _advancing: false,
  // Guide sync handshake
  guideReadyYou: false,
  guideReadyPartner: false
};

/* ════════════════════════════════════════════════════════════
   REMOVE.BG
   ════════════════════════════════════════════════════════════ */
const REMOVEBG_API_KEY = 'xGGoH56ty9jCd4CreBmCj2zc'; 

async function removeBackground(sourceCanvas) {
  if (!REMOVEBG_API_KEY || REMOVEBG_API_KEY === 'YOUR_REMOVE_BG_API_KEY') {
    console.warn('[remove.bg] No API key — skipping');
    return sourceCanvas;
  }
  try {
    const blob = await new Promise(res => sourceCanvas.toBlob(res, 'image/jpeg', 0.92));
    const formData = new FormData();
    formData.append('image_file', blob, 'photo.jpg');
    formData.append('size', 'auto');
    formData.append('type', 'person');
    const resp = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': REMOVEBG_API_KEY },
      body: formData
    });
    if (!resp.ok) { console.warn('[remove.bg] API error:', resp.status); return sourceCanvas; }
    const resultBlob = await resp.blob();
    const url = URL.createObjectURL(resultBlob);
    const outCanvas = document.createElement('canvas');
    outCanvas.width = sourceCanvas.width; outCanvas.height = sourceCanvas.height;
    const outCtx = outCanvas.getContext('2d');
    await new Promise((res, rej) => {
      const img = new Image();
      img.onload  = () => { outCtx.drawImage(img, 0, 0, outCanvas.width, outCanvas.height); URL.revokeObjectURL(url); res(); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(); };
      img.src = url;
    });
    const id = outCtx.getImageData(0, 0, outCanvas.width, outCanvas.height);
    const d = id.data;
    for (let k = 0; k < d.length; k += 4) {
      if (d[k+3] < 10) continue;
      const g = d[k]*0.299 + d[k+1]*0.587 + d[k+2]*0.114;
      const v = Math.min(255, Math.max(0, (g - 128)*1.45 + 128));
      d[k] = d[k+1] = d[k+2] = v;
    }
    outCtx.putImageData(id, 0, 0);
    return outCanvas;
  } catch(e) {
    console.warn('[remove.bg] Failed — using original:', e);
    return sourceCanvas;
  }
}

/* ── Composite: ALWAYS side-by-side regardless of orientation ──
   isVert controls the frame SHAPE (tall vs wide), not the split direction.
   Both people are always placed left/right so they look like they're
   standing next to each other. ── */
function compositeTogether(personA, personB, W, H) {
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');

  // Dark background
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, W, H);

  // Film grain
  const gd = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < gd.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 20;
    gd.data[i]   = Math.max(0, Math.min(255, gd.data[i]   + n));
    gd.data[i+1] = Math.max(0, Math.min(255, gd.data[i+1] + n));
    gd.data[i+2] = Math.max(0, Math.min(255, gd.data[i+2] + n));
  }
  ctx.putImageData(gd, 0, 0);

  // Vignette
  const vig = ctx.createRadialGradient(W/2, H/2, H*0.15, W/2, H/2, H*0.85);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  // Always left/right split
  const hw = Math.floor(W / 2);

  function drawPerson(canvas, clipX, clipY, clipW, clipH) {
    if (!canvas) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(clipX, clipY, clipW, clipH); ctx.clip();
    const scale = Math.max(clipW / canvas.width, clipH / canvas.height);
    const dw = canvas.width * scale, dh = canvas.height * scale;
    ctx.drawImage(canvas, clipX + (clipW - dw)/2, clipY + (clipH - dh)/2, dw, dh);
    ctx.restore();
  }

  drawPerson(personA, 0,  0, hw, H);
  ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(hw-1, 0, 2, H);
  drawPerson(personB, hw, 0, hw, H);

  return out;
}

/* ── Load img src → greyscale cover-fit canvas ── */
function loadImgAsCanvas(src, w, h) {
  return new Promise(res => {
    if (!src) { res(null); return; }
    const img = new Image();
    img.onload = () => {
      const cc = document.createElement('canvas');
      cc.width = w; cc.height = h;
      const cx = cc.getContext('2d');
      const ir = img.width / img.height, br = w / h;
      let sx, sy, sw, sh;
      if (ir > br) { sh = img.height; sw = sh*br; sx = (img.width-sw)/2; sy = 0; }
      else         { sw = img.width;  sh = sw/br;  sx = 0; sy = (img.height-sh)/2; }
      cx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      const id = cx.getImageData(0, 0, w, h); const d = id.data;
      for (let k = 0; k < d.length; k += 4) {
        const g = d[k]*0.299 + d[k+1]*0.587 + d[k+2]*0.114;
        const v = Math.min(255, Math.max(0, (g-128)*1.45+128));
        d[k] = d[k+1] = d[k+2] = v;
      }
      cx.putImageData(id, 0, 0); res(cc);
    };
    img.onerror = () => res(null);
    img.src = src;
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ════════════════════════════════════════════════
   NAV
   ════════════════════════════════════════════════ */
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const isHome = id === 's-home';
  document.body.style.background            = isHome ? '#8B1A1A' : '#000000';
  document.documentElement.style.background = isHome ? '#8B1A1A' : '#000000';
}

function goToSession() { show('s-session'); }

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => c[Math.floor(Math.random()*c.length)]).join('');
}

/* ── Orientation ── */
function pickOrient(o) {
  S.orient = o;
  document.getElementById('oc-horiz').classList.toggle('selected', o === 'horiz');
  document.getElementById('oc-vert').classList.toggle('selected',  o === 'vert');
}

function confirmOrient() {
  if (S.isDuet) show('s-mode');  // always show mode picker for duet
  else beginShoot();
}

/* ── Mode picker (duet only) ── */
function pickMode(m) {
  S.mode = m;
  if (m === 'together') {
    // Host shows guide; sends show-guide to guest so they see it too
    show('s-guide');
    send({ type: 'show-guide', orient: S.orient, mode: S.mode });
  } else {
    // Classic: host starts shoot directly, guest receives start-shoot
    hostStartShoot();
  }
}

/* ── Host-side: kick off shoot (sends signal to guest) ── */
function hostStartShoot() {
  send({ type: 'start-shoot', orient: S.orient, mode: S.mode });
  beginShoot();
}

/* ── Guide screen: "We're ready" ── */
function guideReady() {
  S.guideReadyYou = true;
  send({ type: 'guide-ready' });

  // If partner already signalled ready, start; otherwise wait
  if (S.guideReadyPartner || !S.isDuet) {
    hostStartShoot();
  } else {
    // Update button to show we're waiting
    const btn = document.getElementById('guide-ready-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Waiting for partner…'; }
  }
}

/* ── Session flows ── */
function startSolo() {
  S.code='SOLO'; S.isDuet=false; S.isHost=false;
  S.mode='classic';  // reset mode for every solo session
  show('s-orient');
}

function createSession() {
  S.code=genCode(); S.isDuet=true; S.isHost=true;
  S.mode='classic';  // reset — mode picker will be shown fresh
  document.getElementById('wait-code').textContent = S.code;
  setBadge('waiting','Initialising…');
  show('s-waiting');
  initHost();
}

function joinSession() {
  const v = document.getElementById('join-input').value.trim().toUpperCase();
  if (v.length < 3) { alert('Enter a valid 4-character code'); return; }
  S.code=v; S.isDuet=true; S.isHost=false;
  S.mode='classic';  // reset — will be set by host's start-shoot message
  document.getElementById('wait-code').textContent = S.code;
  setBadge('waiting','Connecting…');
  show('s-waiting');
  initGuest();
}

function cancelWait() { cleanup(); show('s-session'); }

function setBadge(state, txt) {
  document.getElementById('conn-badge').className = 'conn-badge ' + state;
  document.getElementById('conn-txt').textContent = txt;
}

/* ── PeerJS host ── */
function initHost() {
  S.peer = new Peer('interlinked-host-'+S.code, { debug:0 });
  S.peer.on('open', () => setBadge('waiting','Waiting for partner…'));
  S.peer.on('connection', conn => {
    S.conn = conn;
    conn.on('open', () => {
      setBadge('connected','Partner connected');
      conn.on('data', handleData);
      show('s-orient');
    });
    conn.on('close', () => setBadge('error','Partner disconnected'));
  });
  S.peer.on('call', call => {
    S.call = call;
    call.answer(S.localStream || undefined);
    call.on('stream', remote => showPartnerVid(remote));
  });
  S.peer.on('error', e => { setBadge('error','Error. Try refreshing'); console.warn(e); });
  getCamera();
}

/* ── PeerJS guest ── */
function initGuest() {
  const hostId  = 'interlinked-host-'+S.code;
  const guestId = 'interlinked-guest-'+S.code+'-'+Date.now();
  S.peer = new Peer(guestId, { debug:0 });
  S.peer.on('open', async () => {
    S.conn = S.peer.connect(hostId, { reliable:true });
    S.conn.on('open', () => {
      setBadge('connected','Connected');
      S.conn.on('data', handleData);
    });
    S.conn.on('error', () => setBadge('error','Cannot reach host. Check code'));
    await getCamera();
    if (S.localStream) {
      S.call = S.peer.call(hostId, S.localStream);
      S.call.on('stream', remote => showPartnerVid(remote));
    }
  });
  S.peer.on('error', e => { setBadge('error','Cannot connect. Check code'); console.warn(e); });
}

/* ── Camera ── */
async function getCamera() {
  try {
    if (S.localStream) S.localStream.getTracks().forEach(t => t.stop());
    S.localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode:'user', width:{ ideal:640 }, height:{ ideal:640 } },
      audio: false
    });
    attachMyVid(S.localStream);
    if (!S.isHost && S.peer && S.peer.open && S.conn) {
      S.call = S.peer.call('interlinked-host-'+S.code, S.localStream);
      S.call.on('stream', remote => showPartnerVid(remote));
    }
    if (S.isHost && S.call) S.call.answer(S.localStream);
  } catch(e) {
    console.log('No camera — sim mode');
    runSimCam('left');
    document.getElementById('ph-you').style.display = 'none';
  }
}

function attachMyVid(stream) {
  const v = document.getElementById('vid-you');
  v.srcObject = stream; v.style.display = 'block';
  document.getElementById('ph-you').style.display = 'none';
}

function showPartnerVid(stream) {
  const v = document.getElementById('vid-partner');
  v.srcObject = stream; v.style.display = 'block';
  document.getElementById('ph-partner').style.display = 'none';
  document.getElementById('live-badge').textContent = 'Live';
}

function runSimCam(side) {
  const pane = document.getElementById(side==='left' ? 'cam-left' : 'cam-right');
  const c = document.createElement('canvas');
  c.width=320; c.height=480;
  c.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:grayscale(100%) contrast(1.2)';
  pane.appendChild(c);
  let f=0;
  (function loop() {
    const ctx=c.getContext('2d');
    ctx.fillStyle='#080808'; ctx.fillRect(0,0,320,480);
    for(let i=0;i<1500;i++){
      const x=Math.random()*320, y=Math.random()*480;
      const b=(Math.random()*40+Math.sin(f*0.03+i*0.01)*4)|0;
      ctx.fillStyle=`rgb(${b},${b},${b})`; ctx.fillRect(x,y,1,1);
    }
    f++; requestAnimationFrame(loop);
  })();
}

/* ── Data channel ── */
function send(data) {
  if (S.conn && S.conn.open) try { S.conn.send(data); } catch(e) {}
}

function handleData(d) {
  if (!d || !d.type) return;

  // Host sends show-guide → guest shows guide screen too
  if (d.type === 'show-guide') {
    S.orient = d.orient || 'vert';
    S.mode   = d.mode   || 'together';
    S.guideReadyYou = false;
    S.guideReadyPartner = false;
    // Reset the guide ready button
    const btn = document.getElementById('guide-ready-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'We\'re ready'; }
    show('s-guide');
  }

  // Guest clicked ready on guide → host receives this
  if (d.type === 'guide-ready') {
    S.guideReadyPartner = true;
    if (S.guideReadyYou) {
      // Both ready — start shoot
      hostStartShoot();
    } else {
      // Partner ready but we haven't clicked yet — update UI
      const btn = document.getElementById('guide-ready-btn');
      if (btn) btn.textContent = 'Partner ready. Click when you are';
    }
  }

  // Host sends start-shoot → guest begins shoot (classic mode, no guide needed)
  if (d.type === 'start-shoot') {
    S.orient = d.orient || 'vert';
    S.mode   = d.mode   || 'classic';
    applyOrientToStage();
    beginShoot();
  }

  if (d.type === 'countdown')     showCD(d.n);
  if (d.type === 'capture-now')   captureMe();
  if (d.type === 'partner-ready') {
    S.partnerReady = true;
    document.getElementById('sync-partner').classList.add('ready');
    if (S.youReady) kick();
  }

  // Store partner photo at correct frame index to prevent duplicates
  if (d.type === 'photo') {
    const frameIdx = (typeof d.idx === 'number') ? d.idx : S.photosPartner.length;
    S.photosPartner[frameIdx] = d.data;
    checkNext();
  }
}

/* ════════════════════════════════════════════════
   SHOOT
   ════════════════════════════════════════════════ */
async function beginShoot() {
  S.idx=0; S.photosYou=[]; S.photosPartner=[]; S.compositedFrames=[];
  S.youReady=false; S.partnerReady=false; S._advancing=false;
  S.guideReadyYou=false; S.guideReadyPartner=false;

  applyOrientToStage();
  show('s-shoot');
  setPrompt(0);

  // Ambient tip — only visible in together mode duet
  const tipEl = document.getElementById('shoot-ambient-tip');
  if (tipEl) tipEl.style.display = (S.isDuet && S.mode === 'together') ? 'block' : 'none';

  if (!S.localStream) await getCamera();
  else attachMyVid(S.localStream);
}

function applyOrientToStage() {
  const stage    = document.getElementById('cam-stage');
  const camRight = document.getElementById('cam-right');
  const syncBar  = document.getElementById('sync-bar');
  const inner    = document.getElementById('shoot-inner-wrap');

  stage.classList.remove('horiz','vert','solo');

  // Together mode duet: camera is ALWAYS side-by-side (horiz) regardless of
  // the orientation setting. Orientation only controls the final strip frame shape.
  const cameraIsHoriz = S.orient === 'horiz' || (S.isDuet && S.mode === 'together');
  if (inner) inner.classList.toggle('is-horiz', cameraIsHoriz);

  if (!S.isDuet) {
    stage.classList.add(S.orient==='horiz'?'horiz':'vert','solo');
    camRight.style.display='none'; syncBar.style.display='none';
    document.getElementById('lbl-you').textContent='Solo';
  } else {
    stage.classList.add(cameraIsHoriz?'horiz':'vert');
    camRight.style.display=''; syncBar.style.display='';
    // Guest: swap panels so host is always visually on the left
    const camLeft  = document.getElementById('cam-left');
    if (!S.isHost && camLeft && camRight) {
      // Move cam-right before cam-left in the DOM
      stage.insertBefore(camRight, camLeft);
    } else if (S.isHost && camLeft && camRight) {
      // Ensure host order: cam-left first, cam-right second
      stage.insertBefore(camLeft, camRight);
    }
    document.getElementById('lbl-you').textContent = S.isHost ? 'You' : 'You';
    document.getElementById('lbl-partner').textContent = 'Partner';
  }
}

function setPrompt(i) {
  const p = getPrompts()[i];
  document.getElementById('p-act').textContent = p.act;
  document.getElementById('p-txt').textContent = p.text;
  document.getElementById('p-sub').textContent = p.sub;
  document.getElementById('sync-ctr').textContent = (i+1)+' / 4';

  const btn = document.getElementById('cap-btn');
  btn.disabled=false; btn.textContent='Take Photo';

  const cd = document.getElementById('cd-dig');
  cd.style.transition='none'; cd.style.opacity='0'; cd.style.transform='scale(1.25)';

  document.getElementById('sync-you').classList.remove('ready');
  document.getElementById('sync-partner').classList.remove('ready');
  S.youReady=false; S.partnerReady=false; S._advancing=false;

  for (let j=0;j<4;j++) {
    document.getElementById('ps'+j).className='ps'+(j<i?' done':j===i?' cur':'');
  }
}

function onCapture() {
  const btn=document.getElementById('cap-btn');
  btn.disabled=true; btn.textContent='Ready…';
  S.youReady=true;
  document.getElementById('sync-you').classList.add('ready');
  send({ type:'partner-ready' });
  if (!S.isDuet || S.partnerReady) kick();
  else btn.textContent='Waiting for partner…';
}

function kick() {
  let n=3;
  showCD(n);
  if (S.isHost || !S.isDuet) send({ type:'countdown', n });
  const iv = setInterval(() => {
    n--;
    if (n > 0) {
      showCD(n);
      if (S.isHost || !S.isDuet) send({ type:'countdown', n });
    } else {
      clearInterval(iv);
      const cd=document.getElementById('cd-dig');
      cd.style.transition='none'; cd.style.opacity='0';
      if (S.isHost || !S.isDuet) send({ type:'capture-now' });
      doFlash(); captureMe();
    }
  }, 1000);
}

function showCD(n) {
  const el = document.getElementById('cd-dig');
  el.style.transition='none'; el.style.opacity='0'; el.style.transform='scale(1.3)';
  el.textContent=n;
  el.getBoundingClientRect();
  el.style.transition='opacity 0.15s ease, transform 0.15s ease';
  el.style.opacity='1'; el.style.transform='scale(1)';
}

function doFlash() {
  const v=document.getElementById('flash-veil');
  v.classList.add('flash');
  setTimeout(() => v.classList.remove('flash'), 90);
}

/* ── Capture ── */
function captureMe() {
  const vid=document.getElementById('vid-you');
  const cnv=document.getElementById('cv-you');
  cnv.width=480; cnv.height=480;
  const ctx=cnv.getContext('2d');
  if (vid.srcObject && vid.readyState >= 2) {
    ctx.drawImage(vid, 0, 0, 480, 480);
    bw(ctx,cnv);
  } else {
    simFrame(ctx,cnv,S.idx);
  }
  const url=cnv.toDataURL('image/jpeg',0.9);
  S.photosYou.push(url);
  send({ type:'photo', data:url, idx: S.idx });
  if (!S.isDuet) { S.photosPartner.push(null); setTimeout(advance,380); return; }
  checkNext();
}

function checkNext() {
  const fi=S.idx;
  // Both photos for this frame must be present before advancing
  if (S.photosYou.length <= fi) return;
  if (S.isDuet && S.photosPartner.length <= fi) return;
  if (S._advancing) return;
  S._advancing=true;
  setTimeout(advance,380);
}

async function advance() {
  S.idx++;
  if (S.idx < 4) { setPrompt(S.idx); }
  else {
    if (S.localStream) S.localStream.getTracks().forEach(t => t.stop());
    await runDrop();
  }
}

function bw(ctx, cnv) {
  const id=ctx.getImageData(0,0,cnv.width,cnv.height); const d=id.data;
  for (let k=0;k<d.length;k+=4) {
    const g=d[k]*0.299+d[k+1]*0.587+d[k+2]*0.114;
    const v=Math.min(255,Math.max(0,(g-128)*1.45+128));
    d[k]=d[k+1]=d[k+2]=v;
  }
  ctx.putImageData(id,0,0);
}

function simFrame(ctx,cnv,idx) {
  ctx.fillStyle='#080808'; ctx.fillRect(0,0,cnv.width,cnv.height);
  for(let i=0;i<2200;i++){
    const x=Math.random()*cnv.width, y=Math.random()*cnv.height;
    const b=(Math.random()*38)|0;
    ctx.fillStyle=`rgb(${b},${b},${b})`; ctx.fillRect(x,y,1,1);
  }
  ctx.fillStyle='#252525'; ctx.font='400 54px Kommuna,serif';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(['I','II','III','IV'][idx]||'·',cnv.width/2,cnv.height/2);
}

/* ── Stamp ── */
async function getStamp() {
  const now=new Date();
  const timeStr=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});
  const dateStr=now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
  let locationStr='';
  try {
    const pos=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{timeout:4000}));
    const {latitude:lat,longitude:lon}=pos.coords;
    const gr=await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,{headers:{'Accept-Language':'en'}});
    const gd=await gr.json(); const addr=gd.address||{};
    const city=addr.city||addr.town||addr.village||addr.county||'';
    const country=addr.country_code?addr.country_code.toUpperCase():'';
    locationStr=[city,country].filter(Boolean).join(', ');
  } catch(e) { locationStr=''; }
  return {timeStr,dateStr,locationStr};
}

/* ════════════════════════════════════════════════
   STRIP DROP
   ════════════════════════════════════════════════ */
function setDevelopingStatus(msg) {
  const el = document.getElementById('developing-status');
  if (el) el.textContent = msg;
}

async function runDrop() {
  show('s-drop');

  const travelWrap = document.getElementById('strip-travel-wrap');
  const hang       = document.getElementById('strip-hang');
  travelWrap.innerHTML = '';
  if (hang) hang.innerHTML = '';
  travelWrap.classList.remove('drop');
  travelWrap.style.transition = 'none';
  travelWrap.style.transform  = 'translateY(-650px)';

  const dlBtn = document.getElementById('dl-btn');
  dlBtn.disabled = true; dlBtn.textContent = 'Developing…';

  const progressArea = document.getElementById('developing-progress');
  if (progressArea) {
    progressArea.style.display = (S.isDuet && S.mode === 'together') ? 'flex' : 'none';
  }

  setDevelopingStatus('Getting your locations…');
  const stamp = await getStamp();
  S.stamp = stamp;

  if (S.isDuet && S.mode === 'together') {
    await buildCompositedFrames();
  } else {
    S.compositedFrames = [null, null, null, null];
  }

  setDevelopingStatus('Developing your strip…');

  const isVert = S.orient === 'vert';
  const slotW  = isVert ? 118 : 158;
  const slotFH = isVert ? 105 : 70;

  // Build the complete strip inside the machine
  travelWrap.innerHTML = makeStrip(slotW, slotFH, stamp);

  // End position: bottom of strip aligns with bottom of channel.
  // channelH - stripH = how far down to push so strip sits at the bottom.
  const channel  = document.querySelector('.drop-channel');
  const channelH = channel ? channel.getBoundingClientRect().height : 540;
  const knownStripH = S.orient === 'vert' ? 490 : 340;
  const endY = Math.max(0, channelH - knownStripH);

  travelWrap.getBoundingClientRect();

  requestAnimationFrame(() => {
    travelWrap.style.transition = 'transform 3.8s cubic-bezier(0.95, 0, 0.4, 1)';
    travelWrap.style.transform  = `translateY(${endY}px)`;
  });


  await Promise.all([
    new Promise(res => setTimeout(res, 4000)),
    renderCanvas()
  ]);

  if (progressArea) progressArea.style.display = 'none';
  dlBtn.disabled = false; dlBtn.textContent = 'Download Strip';
}

/* ── Individual frame HTML strings (no strip-paper wrapper) ── */
function makeFrameHTMLs(w, fh) {
  const isVert = S.orient === 'vert';
  const isDuo  = S.isDuet;
  const frames = [];
  for (let i = 0; i < 4; i++) {
    const comp = S.compositedFrames[i];
    const y    = S.photosYou[i]     || '';
    const p    = S.photosPartner[i] || '';
    const duo  = isDuo && p;
    let html   = '';
    if (duo && comp) {
      html += `<div class="s-frame" style="height:${fh}px;background:#060606;"><img src="${comp}" style="width:100%;height:${fh}px;object-fit:cover;" alt=""></div>`;
    } else if (duo) {
      if (isVert) {
        html += `<div class="s-frame vert-split" style="height:${fh}px">
          <div class="s-half"><img src="${y}" style="width:100%;height:${fh/2}px;object-fit:cover;filter:grayscale(100%) contrast(1.3) brightness(.9)" alt=""></div>
          <div class="s-hdiv-h"></div>
          <div class="s-half"><img src="${p}" style="width:100%;height:${fh/2}px;object-fit:cover;filter:grayscale(100%) contrast(1.3) brightness(.9)" alt=""></div>
        </div>`;
      } else {
        html += `<div class="s-frame" style="height:${fh}px">
          <div class="s-half" style="height:${fh}px"><img src="${y}" style="height:${fh}px" alt=""></div>
          <div class="s-hdiv"></div>
          <div class="s-half" style="height:${fh}px"><img src="${p}" style="height:${fh}px" alt=""></div>
        </div>`;
      }
    } else {
      html += `<div class="s-frame" style="height:${fh}px"><img class="s-solo-img" src="${y}" style="height:${fh}px;width:100%" alt=""></div>`;
    }
    html += `<div style="height:2px;background:#111;width:100%"></div>`;
    frames.push(html);
  }
  return frames;
}

/* ── Strip footer HTML ── */
function makeStripFooter(w, stamp) {
  stamp = stamp || S.stamp || {};
  const timeDate = [stamp.timeStr, stamp.dateStr].filter(Boolean).join('  ·  ');
  const location = stamp.locationStr || '';
  const sc = w / 158;
  const fTitle = Math.round(6.2*sc), fCode = Math.round(4.8*sc);
  const fTime  = Math.round(5.7*sc), fLoc  = Math.round(6.5*sc);
  const pad = Math.round(4*sc), gap = Math.round(2*sc);
  return `<div style="border-top:.5px solid #ccc;margin-top:2px;padding:${pad*2}px 3px ${pad}px;text-align:center;background:var(--cream,#f5f0e8);display:flex;flex-direction:column;align-items:center;gap:${gap}px;width:${w}px;box-sizing:border-box;">
    <div style="font-family:'Billa Mount',serif;font-size:${fTitle}px;color:#555;letter-spacing:.04em;line-height:1.5;white-space:nowrap;max-width:100%;">Interlinked Photobooth</div>
    <div style="font-family:'Kommuna',monospace;font-size:${fCode}px;color:#999;letter-spacing:.2em;white-space:nowrap;">${S.code||'SOLO'}</div>
    ${timeDate?`<div style="font-family:'Kommuna',monospace;font-size:${fTime}px;font-style:italic;color:#888;white-space:nowrap;max-width:100%;">${timeDate}</div>`:''}
    ${location?`<div style="font-family:'Saint Andrews Queen',serif;font-size:${fLoc}px;color:#888;white-space:nowrap;">${location}</div>`:''}
  </div>`;
}

/* ── Build composited frames ── */
async function buildCompositedFrames() {
  S.compositedFrames=[];
  const isVert=S.orient==='vert';
  // Together mode always uses side-by-side, so each half is square-ish
  // For vert strip: frame is tall (e.g. 320×352), each person gets 160×352
  // For horiz strip: frame is wide (480×270), each person gets 240×270
  // We render the composite at full frame size; side-by-side split is always horizontal
  const FW = isVert ? 320 : 480;
  const FH = isVert ? 352 : 270;

  for (let i=0;i<4;i++) {
    setDevelopingStatus(`Removing backgrounds… ${i+1} / 4`);
    try {
      // Guarantee both photos are present before processing
      const youSrc     = S.photosYou[i];
      const partnerSrc = S.photosPartner[i];
      if (!youSrc || !partnerSrc) { S.compositedFrames.push(null); continue; }

      const [cA,cB]=await Promise.all([
        loadImgAsCanvas(youSrc, FW/2, FH),      // each person gets half the width
        loadImgAsCanvas(partnerSrc, FW/2, FH)
      ]);
      if (cA && cB) {
        const [cutA,cutB]=await Promise.all([removeBackground(cA),removeBackground(cB)]);
        setDevelopingStatus(`Compositing… ${i+1} / 4`);
        // compositeTogether always places side-by-side
        const comp=compositeTogether(cutA,cutB,FW,FH);
        S.compositedFrames.push(comp.toDataURL('image/jpeg',0.92));
      } else { S.compositedFrames.push(null); }
    } catch(e) {
      console.warn('[composite] Frame',i,'failed:',e);
      S.compositedFrames.push(null);
    }
  }
}

/* ── makeStrip (kept for any legacy references) ── */
function makeStrip(w, fh, stamp) {
  stamp=stamp||S.stamp||{};
  const isVert=S.orient==='vert', isDuo=S.isDuet;
  let html=`<div class="strip-paper" style="width:${w}px;box-sizing:border-box;overflow:hidden;">`;
  for (let i=0;i<4;i++) {
    const comp=S.compositedFrames[i];
    // Host always on left, guest always on right
    const rawY=S.photosYou[i]||'', rawP=S.photosPartner[i]||'';
    const y = S.isHost ? rawY : rawP;
    const p = S.isHost ? rawP : rawY;
    const duo=isDuo&&(rawP||rawY);
    if (duo && comp) {
      html+=`<div class="s-frame" style="height:${fh}px;background:#060606;">
        <img src="${comp}" style="width:100%;height:${fh}px;object-fit:cover;" alt=""></div>`;
    } else if (duo) {
      if (isVert) {
        html+=`<div class="s-frame vert-split" style="height:${fh}px">
          <div class="s-half"><img src="${y}" style="width:100%;height:${fh/2}px;object-fit:cover;filter:grayscale(100%) contrast(1.3) brightness(.9)" alt=""></div>
          <div class="s-hdiv-h"></div>
          <div class="s-half"><img src="${p}" style="width:100%;height:${fh/2}px;object-fit:cover;filter:grayscale(100%) contrast(1.3) brightness(.9)" alt=""></div>
        </div>`;
      } else {
        html+=`<div class="s-frame" style="height:${fh}px">
          <div class="s-half" style="height:${fh}px"><img src="${y}" style="height:${fh}px" alt=""></div>
          <div class="s-hdiv"></div>
          <div class="s-half" style="height:${fh}px"><img src="${p}" style="height:${fh}px" alt=""></div>
        </div>`;
      }
    } else {
      html+=`<div class="s-frame" style="height:${fh}px">
        <img class="s-solo-img" src="${y}" style="height:${fh}px;width:100%" alt=""></div>`;
    }
    html+=`<div style="height:2px;background:#111;width:100%"></div>`;
  }
  const timeDate=[stamp.timeStr,stamp.dateStr].filter(Boolean).join('  ·  ');
  const location=stamp.locationStr||'';
  const sc=w/158;
  const fTitle=Math.round(6.2*sc),fCode=Math.round(4.8*sc),fTime=Math.round(5.7*sc),fLoc=Math.round(6.5*sc);
  const pad=Math.round(4*sc),gap=Math.round(2*sc);
  html+=`<div style="border-top:.5px solid #ccc;margin-top:2px;padding:${pad*2}px 3px ${pad}px;text-align:center;background:var(--cream,#f5f0e8);display:flex;flex-direction:column;align-items:center;gap:${gap}px;width:${w}px;box-sizing:border-box;">
    <div style="font-family:'Billa Mount',serif;font-size:${fTitle}px;color:#555;letter-spacing:.04em;line-height:1.5;white-space:nowrap;max-width:100%;">Interlinked Photobooth</div>
    <div style="font-family:'Kommuna',monospace;font-size:${fCode}px;color:#999;letter-spacing:.2em;white-space:nowrap;">${S.code||'SOLO'}</div>
    ${timeDate?`<div style="font-family:'Kommuna',monospace;font-size:${fTime}px;font-style:italic;color:#888;white-space:nowrap;max-width:100%;">${timeDate}</div>`:''}
    ${location?`<div style="font-family:'Saint Andrews Queen',serif;font-size:${fLoc}px;color:#888;white-space:nowrap;">${location}</div>`:''}
  </div></div>`;
  return html;
}

/* ── renderCanvas ── */
async function loadStripFonts() {
  try {
    const fonts=[
      new FontFace('Billa Mount','url(fonts/BillaMount.ttf)'),
      new FontFace('Kommuna','url(fonts/Kommuna.ttf)'),
      new FontFace('Saint Andrews Queen','url(fonts/Saint-AndrewsQueen.ttf)')
    ];
    await Promise.all(fonts.map(f=>f.load().then(l=>document.fonts.add(l)).catch(()=>{})));
  } catch(e) {}
}

async function renderCanvas() {
  await loadStripFonts();
  const isVert=S.orient==='vert';
  const W=isVert?360:600, PAD=16, FW=W-PAD*2;
  const FH=isVert?Math.round(FW*1.1):Math.round(FW*0.56);
  const GAP=4, PADY=36, FOOT=130;
  const H=PADY+4*(FH+GAP)-GAP+FOOT;
  const c=document.getElementById('cv-render');
  c.width=W; c.height=H;
  const ctx=c.getContext('2d');
  ctx.fillStyle='#f5f0e8'; ctx.fillRect(0,0,W,H);

  const loadImg=src=>new Promise(res=>{
    if(!src){res(null);return;}
    const img=new Image();
    img.onload=()=>res(img); img.onerror=()=>res(null); img.src=src;
  });

  for (let i=0;i<4;i++) {
    const fy=PADY+i*(FH+GAP);
    const comp=S.compositedFrames[i];
    const duo=S.isDuet&&S.photosPartner[i];
    ctx.fillStyle='#111'; ctx.fillRect(PAD,fy,FW,FH);
    // Host always on left, guest always on right
    const rawYc=S.photosYou[i]||'', rawPc=S.photosPartner[i]||'';
    const leftPhoto  = S.isHost ? rawYc : rawPc;
    const rightPhoto = S.isHost ? rawPc : rawYc;

    if (duo && comp) {
      // Together: use composited frame (already side-by-side)
      const img=await loadImg(comp);
      if(img) ctx.drawImage(img,PAD,fy,FW,FH);
    } else if (duo) {
      // Classic: split based on orientation
      if (isVert) {
        const hh=Math.floor(FH/2);
        const [a,b]=await Promise.all([loadImgAsCanvas(leftPhoto,FW,hh),loadImgAsCanvas(rightPhoto,FW,hh)]);
        if(a) ctx.drawImage(a,PAD,fy,FW,hh);
        if(b) ctx.drawImage(b,PAD,fy+hh,FW,hh);
        ctx.fillStyle='#000'; ctx.fillRect(PAD,fy+hh-1,FW,2);
      } else {
        const hw=Math.floor(FW/2);
        const [a,b]=await Promise.all([loadImgAsCanvas(leftPhoto,hw,FH),loadImgAsCanvas(rightPhoto,hw,FH)]);
        if(a) ctx.drawImage(a,PAD,fy,hw,FH);
        if(b) ctx.drawImage(b,PAD+hw,fy,hw,FH);
        ctx.fillStyle='#000'; ctx.fillRect(PAD+hw-1,fy,2,FH);
      }
    } else if (S.photosYou[i]) {
      const a=await loadImgAsCanvas(leftPhoto||S.photosYou[i],FW,FH);
      if(a) ctx.drawImage(a,PAD,fy,FW,FH);
    }
  }

  const footY=PADY+4*(FH+GAP);
  ctx.strokeStyle='#ccc'; ctx.lineWidth=0.5;
  ctx.beginPath(); ctx.moveTo(PAD,footY); ctx.lineTo(PAD+FW,footY); ctx.stroke();
  const st=S.stamp||{};
  ctx.textAlign='center'; ctx.textBaseline='middle';
  const bs=footY+30, lineH=22;
  ctx.fillStyle='#555'; ctx.font='400 14px "Billa Mount", serif';
  ctx.fillText('Interlinked Photobooth',W/2,bs);
  ctx.fillStyle='#999'; ctx.font='400 11px Kommuna';
  ctx.fillText(S.code||'SOLO',W/2,bs+lineH);
  if (st.timeStr||st.dateStr) {
    ctx.fillStyle='#888'; ctx.font='italic 400 13px Kommuna';
    ctx.fillText([st.timeStr,st.dateStr].filter(Boolean).join('  ·  '),W/2,bs+lineH*2);
  }
  if (st.locationStr) {
    ctx.fillStyle='#888'; ctx.font='400 15px "Saint Andrews Queen", serif';
    ctx.fillText(st.locationStr,W/2,bs+lineH*3);
  }
}

function downloadStrip() {
  const c=document.getElementById('cv-render');
  const a=document.createElement('a');
  a.download=`interlinked-${S.code||'solo'}-${S.orient}-${Date.now()}.jpg`;
  a.href=c.toDataURL('image/jpeg',0.95); a.click();
}

/* ── Cleanup ── */
function cleanup() {
  if(S.localStream){S.localStream.getTracks().forEach(t=>t.stop());S.localStream=null;}
  if(S.call){try{S.call.close();}catch(e){}S.call=null;}
  if(S.conn){try{S.conn.close();}catch(e){}S.conn=null;}
  if(S.peer){try{S.peer.destroy();}catch(e){}S.peer=null;}
}

function reshoot() {
  cleanup();
  // Full state reset including mode — forces mode picker on next session
  S.idx=0; S.photosYou=[]; S.photosPartner=[]; S.compositedFrames=[];
  S._advancing=false; S.mode='classic';
  S.youReady=false; S.partnerReady=false;
  S.guideReadyYou=false; S.guideReadyPartner=false;

  ['vid-you','vid-partner'].forEach(id=>{
    const v=document.getElementById(id);
    v.style.display='none'; v.srcObject=null;
  });
  document.getElementById('ph-you').style.display='flex';
  document.getElementById('ph-partner').style.display='flex';
  document.getElementById('live-badge').textContent='';
  document.getElementById('sync-bar').style.display='';
  document.getElementById('lbl-you').textContent='You';
  const tw=document.getElementById('strip-travel-wrap');
  const hang=document.getElementById('strip-hang');
  tw.innerHTML=''; hang.innerHTML='';
  const dlBtn=document.getElementById('dl-btn');
  dlBtn.disabled=true; dlBtn.textContent='Developing…';
  show('s-session');
}

function exitShoot() { cleanup(); show('s-home'); }

function toggleInstructions(visible) {
  const panel=document.getElementById('shoot-instructions');
  if(panel) panel.classList.toggle('shoot-hidden',!visible);
}

document.body.style.background='#8B1A1A';
document.documentElement.style.background='#8B1A1A';