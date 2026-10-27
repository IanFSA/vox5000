/* VOX5000 local recording journal, version 1. No network upload. */
(function () {
'use strict';
const DB = 'vox5000-recovery-v1', STORE = 'chunks', META = 'sessions';
let dbPromise;
function db() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, {keyPath:['session','seq']});
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, {keyPath:'id'});
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch(err => { dbPromise = null; throw err; });
  return dbPromise;
}
function transact(store, mode, action) {
  return db().then(d => new Promise((resolve,reject) => {
    const tx=d.transaction(store,mode);
    const s=tx.objectStore(store);
    let result;
    try {result=action(s);} catch(e) {reject(e);return;}
    tx.oncomplete=()=>resolve(result && result.result);
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||new Error('Storage transaction aborted'));
  }));
}
async function sessions() {
  const d=await db();
  return new Promise((resolve,reject)=>{
    const tx=d.transaction(META,'readonly'), req=tx.objectStore(META).getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);
  });
}
async function chunksFor(id) {
  const d=await db();
  return new Promise((resolve,reject)=>{
    const tx=d.transaction(STORE,'readonly'), req=tx.objectStore(STORE).getAll(IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]));
    req.onsuccess=()=>resolve((req.result||[]).sort((a,b)=>a.seq-b.seq));
    req.onerror=()=>reject(req.error);
  });
}
const active = new Map();
function begin(role, room, mime) {
  const id=[Date.now(),crypto.randomUUID()].join('-');
  const state={id,seq:0,pending:Promise.resolve(),error:null};
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  active.set(role,state);
  state.pending=state.pending.then(()=>transact(META,'readwrite',s=>s.put({
    id,role,room,mime:mime||'audio/webm',created:Date.now(),status:'recording',count:0
  }))).catch(e=>{state.error=e;console.error('VOX5000 durable recording failed',e);});
  return id;
}
function append(role, blob) {
  const state=active.get(role);
  if (!state || !blob || !blob.size) return;
  const seq=state.seq++;
  state.pending=state.pending.then(()=>transact(STORE,'readwrite',s=>s.put({session:state.id,seq,blob})))
    .catch(e=>{state.error=e;console.error('VOX5000 could not save audio chunk',e);
      const note=document.getElementById('voxRecoveryError');
      if(note) note.textContent='WARNING: local recording backup failed. Save your recording before leaving this page.';
    });
}
async function finish(role) {
  const state=active.get(role);
  if(!state) return;
  await state.pending;
  if(state.error) { active.delete(role); await refresh(); throw state.error; }
  await transact(META,'readwrite',s=>{
    const req=s.get(state.id);
    req.onsuccess=()=>{if(req.result) s.put({...req.result,status:'stopped',count:state.seq});};
  });
  active.delete(role);
  await refresh();
}
async function download(id) {
  const list=await chunksFor(id);
  if(!list.length) throw new Error('No saved chunks');
  for(let i=0;i<list.length;i++) if(list[i].seq!==i) throw new Error('Recording contains missing chunks');
  const item=(await sessions()).find(s=>s.id===id);
  const mime=item?.mime||'audio/webm';
  const blob=new Blob(list.map(c=>c.blob),{type:mime});
  const href=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=href;a.download='VOX5000_RECOVERY_'+id+'.webm';document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(href),60000);
}
async function remove(id) {
  const d=await db();
  const rows=await chunksFor(id);
  await new Promise((resolve,reject)=>{
    const tx=d.transaction([STORE,META],'readwrite');
    for(const c of rows) tx.objectStore(STORE).delete([id,c.seq]);
    tx.objectStore(META).delete(id);
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  await refresh();
}
async function refresh() {
  const panel=document.getElementById('voxRecoveryPanel');
  if(!panel)return;
  try{
    const all=(await sessions()).sort((a,b)=>b.created-a.created);
    const list=document.getElementById('voxRecoveryList');list.replaceChildren();
    if(!all.length){list.textContent='No locally saved recordings on this device.';return;}
    for(const item of all) {
      const row=document.createElement('div');
      row.style.cssText='margin:8px 0;padding:10px;border:1px solid #555;border-radius:6px';
      const label=document.createElement('div');
      label.textContent=new Date(item.created).toLocaleString()+' · '+item.role+' · '+item.status+' · '+item.id.slice(0,13);
      const dl=document.createElement('button');dl.textContent='Download recovery';dl.type='button';
      dl.onclick=()=>download(item.id).catch(e=>alert('Recovery download failed: '+e.message));
      const del=document.createElement('button');del.textContent='Delete local backup';del.type='button';
      del.style.marginLeft='10px';
      del.onclick=()=>{if(confirm('Permanently delete this local audio backup?'))remove(item.id).catch(e=>alert(e.message));};
      row.append(label,dl,del);list.appendChild(row);
    }
  }catch(e){console.error(e);document.getElementById('voxRecoveryList').textContent='Recording recovery storage unavailable: '+e.message;}
}
function mount() {
  const wrap=document.createElement('section');
  wrap.id='voxRecoveryPanel';
  wrap.style.cssText='position:relative;margin:20px auto;padding:16px;max-width:720px;background:#171717;color:#eee;border:1px solid #666;border-radius:8px;font:14px sans-serif;z-index:10';
  const details=document.createElement('details');
  const summary=document.createElement('summary');summary.textContent='Local recording recovery and backups';
  summary.style.cssText='cursor:pointer;font-weight:bold';
  const description=document.createElement('p');
  description.textContent='Recordings are saved in this browser on this device. Download important recordings before clearing browser data. Recoveries may be incomplete if the microphone or browser stopped.';
  const warning=document.createElement('p');warning.id='voxRecoveryError';warning.style.color='#ffac66';
  const list=document.createElement('div');list.id='voxRecoveryList';
  const emergency=document.createElement('button');
  emergency.type='button';emergency.textContent='Emergency stop and save guest recording';
  emergency.style.cssText='margin:10px 0;padding:9px;background:#754000;color:white;border:1px solid #aa7a3c;border-radius:4px';
  emergency.onclick=()=>{
    if(!confirm('Stop your local guest recording now? Use only if the host is unreachable.'))return;
    if(!window.VOXEmergencyStopGuest?.())alert('No active guest recording was found.');
    refresh();
  };
  details.append(summary,description,emergency,warning,list);wrap.append(details);document.body.append(wrap);
  details.addEventListener('toggle',()=>{if(details.open)refresh();});
  refresh();
}
document.addEventListener('DOMContentLoaded',mount);
window.VOXRecovery={begin,append,finish,refresh};
})();