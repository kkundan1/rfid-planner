// RFID R&D Planner – screens and logic.
// Ported from the claude.ai version; it talks to the server through lib/claude-shim.js.
/* eslint-disable */
export function startPlanner(){
if(window.__plannerStarted)return;window.__plannerStarted=true;

/* ---------- utilities ---------- */
const $=s=>document.querySelector(s);
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DAY=864e5;
const d2n=s=>{if(!s||!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;const[y,m,d]=s.split('-').map(Number);return Math.round(Date.UTC(y,m-1,d)/DAY)};
const n2d=n=>new Date(n*DAY).toISOString().slice(0,10);
const _now=new Date();
const TODAY=Math.round(Date.UTC(_now.getFullYear(),_now.getMonth(),_now.getDate())/DAY);
const dow=n=>((n+4)%7+7)%7; // 0 = Sunday
const isWE=n=>{const w=dow(n);return w===0||w===6};
const nextWork=n=>{n++;while(isWE(n))n++;return n};
const monday=n=>n-((dow(n)+6)%7);
const workdays=(a,b)=>{let c=0;for(let n=a;n<=b;n++)if(!isWE(n))c++;return c};
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WD=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const fmt=n=>{if(n==null||!isFinite(n))return '—';const d=new Date(n*DAY);return d.getUTCDate()+' '+MON[d.getUTCMonth()]};
const fmtY=n=>{if(n==null||!isFinite(n))return '—';const d=new Date(n*DAY);return d.getUTCDate()+' '+MON[d.getUTCMonth()]+' '+d.getUTCFullYear()};
function isoWeek(n){const d=new Date(n*DAY);const day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day+3);const y=d.getUTCFullYear();const j4=Date.UTC(y,0,4);const j4d=(new Date(j4).getUTCDay()+6)%7;return 1+Math.round(((d-j4)/DAY-3+j4d)/7)}
const uid=p=>p+Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4);
const initials=n=>String(n||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase()||'?';
const STATUS={todo:'Not started',active:'In progress',blocked:'Blocked',done:'Done'};
const PSTATUS={planning:'Planning',active:'Active',hold:'On hold',done:'Completed'};
const PRIO={low:'Low',normal:'Normal',high:'High',critical:'Critical'};
const chevron='<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ---------- data store (shared db when available, in-memory otherwise) ---------- */
const COLS=['members','projects','tasks','access','requests','history','creds','pwvault','memberlogin','updates','settings','skills','calendar'];
const S={};COLS.forEach(c=>S[c]=new Map());
const loaded={};COLS.forEach(c=>loaded[c]=false);
let db=null,U=null,mode='connecting',readOnly=false,meReady=false;
let ME={id:null,name:'',isOwner:false,canEdit:false,avatarUrl:''};
const PF={};
const chains=new Map();
function chain(key,fn){const prev=chains.get(key)||Promise.resolve();const p=prev.then(()=>fn());chains.set(key,p.catch(()=>{}));return p}
const clean=o=>{const c={...o};delete c.id;return c};
function handleErr(e){
  const code=e&&e.code;
  if(code==='invalid_argument'){readOnly=true;toast('Your account can’t make this change. Ask an admin for Read & write access.');schedule()}
  else if(code==='quota_exceeded')toast('Storage is full. Delete old projects or tasks to make room.');
  else if(code==='revoked'){readOnly=true;schedule()}
  else toast('Couldn’t save that change. Check your connection and try again.');
}
function sysErr(e){if(e&&e.code==='invalid_argument')toast('Only admins can change this.');else toast('Couldn’t save that change. Check your connection and try again.')}
const ROLE={admin:'Admin',write:'Read & write',read:'Read only',none:'No access yet',disabled:'Disabled'};
function role(){
  if(mode==='local')return 'admin';
  if(ME.isOwner||ME.canEdit)return 'admin';
  const a=ME.id&&S.access.get(ME.id);
  if(a&&a.disabled)return 'disabled';
  return a&&['admin','write','read'].includes(a.role)?a.role:'none';
}
const isAdmin=()=>role()==='admin';
const canManage=()=>mode==='local'||ME.isOwner||ME.canEdit;
const canWrite=()=>!readOnly&&(role()==='admin'||role()==='write');
const meKey=()=>ME.id||'local';
const STAMPED=['members','projects','tasks'];
async function put(col,id,data,opts){
  if(!(opts&&opts.sys)&&!canWrite()){toast('You have read-only access.');return}
  if(STAMPED.includes(col)){data={...data,updatedBy:meKey(),updatedAt:Date.now()};if(!S[col].has(id)){data.createdBy=meKey();data.createdAt=Date.now()}}
  S[col].set(id,{...data,id});if(col==='updates')upIdx=null;schedule();
  if(!db)return;
  try{await chain(col+'/'+id,()=>db.collection(col).doc(id).set(clean(data)))}catch(e){opts&&opts.sys?sysErr(e):handleErr(e)}
}
async function del(col,id,opts){
  if(!(opts&&opts.sys)&&!canWrite()){toast('You have read-only access.');return}
  S[col].delete(id);schedule();
  if(!db)return;
  try{await chain(col+'/'+id,()=>db.collection(col).doc(id).delete())}catch(e){opts&&opts.sys?sysErr(e):handleErr(e)}
}
/* history: each person appends to their own log document (others can read it, nobody else can change it) */
const HMAX=300;
function logH(e){
  const k=meKey();const cur=(S.history.get(k)&&S.history.get(k).entries)||[];
  const entries=[{...e,t:Date.now()},...cur].slice(0,HMAX);
  S.history.set(k,{id:k,entries});schedule();
  if(db&&ME.id)chain('history/'+k,()=>db.collection('history').doc(k).set({entries})).catch(()=>{});
}
const isLoaded=()=>mode==='local'||(meReady&&mode==='live'&&COLS.every(c=>loaded[c]));
let pfBusy=false;
function wantProfiles(ids){
  if(!U||pfBusy)return;
  const miss=[...new Set(ids)].filter(i=>i&&i!=='local'&&!(i in PF));
  if(!miss.length)return;pfBusy=true;
  U.profiles(miss).then(r=>{for(const k of miss)PF[k]=r&&r[k]?{name:r[k].name,avatarUrl:r[k].avatarUrl}:{name:'',avatarUrl:''};pfBusy=false;schedule()}).catch(()=>{pfBusy=false});
}
function pName(id){if(!id)return 'Someone';if(id==='local')return 'You';const p=PF[id];return (p&&p.name)||(id===ME.id?(ME.name||'You'):'Someone')}
function uav(id,lg){const p=PF[id]||(id===ME.id?{avatarUrl:ME.avatarUrl}:null);return p&&p.avatarUrl?`<img class="uav${lg?' lg':''}" src="${h(p.avatarUrl)}" alt="">`:`<span class="av${lg?' lg':''}">${h(initials(pName(id)))}</span>`}

(async()=>{
  await Promise.resolve();
  let api=null,usr=null;
  try{if(window.claude&&window.claude.use)[api,usr]=await Promise.all([window.claude.use('db'),window.claude.use('user')])}catch(e){}
  U=usr;
  if(U){try{const m=await U.me();ME={id:m.id,name:m.name,isOwner:!!m.isOwner,canEdit:!!m.canEdit,avatarUrl:m.avatarUrl};if(m.id)PF[m.id]={name:m.name,avatarUrl:m.avatarUrl}}catch(e){}}
  meReady=true;
  if(api){
    db=api;mode='live';
    for(const col of COLS){
      try{
        db.collection(col).onSnapshot(snap=>{
          const m=new Map();snap.docs.forEach(d=>{if(d.exists)m.set(d.id,{...d.data(),id:d.id})});
          S[col]=m;loaded[col]=true;if(col==='updates')upIdx=null;schedule();
        },e=>{loaded[col]=true;if(e&&e.code==='revoked')readOnly=true;else toast('Live updates paused. Reload the page to reconnect.');schedule()});
      }catch(e){loaded[col]=true}
    }
  }else mode='local';
  schedule();
})();

/* ---------- UI state ---------- */
const ui={view:'overview',pid:null,mode:'timeline',zoom:'day',collapsed:new Set(),fAssignee:'',fStatus:'',scroll:{},teamFocus:'',hPerson:'',hProject:'',hKind:'',pwShown:new Set(),fuPerson:'',fuProject:'',fuShow:'active',loadBy:'person',loadWeeks:8,loadSel:null};
try{const sv=JSON.parse(localStorage.getItem('rfid-planner-ui')||'{}');if(sv.mode)ui.mode=sv.mode;if(sv.zoom)ui.zoom=sv.zoom;if(Array.isArray(sv.collapsed))ui.collapsed=new Set(sv.collapsed)}catch(e){}
function saveUi(){try{localStorage.setItem('rfid-planner-ui',JSON.stringify({mode:ui.mode,zoom:ui.zoom,collapsed:[...ui.collapsed]}))}catch(e){}}
try{if(window.innerWidth<=760&&!JSON.parse(localStorage.getItem('rfid-planner-ui')||'{}').mode)ui.mode='list'}catch(e){if(window.innerWidth<=760)ui.mode='list'}
let drawer=null;
let raf=0;
function schedule(){loadCache=null;if(raf)return;raf=requestAnimationFrame(()=>{raf=0;render()})}
let toastT=0;
function toast(msg){const t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>t.hidden=true,3800)}

/* ---------- follow-ups frequency ---------- */
const FU_DL=[[1,'Daily'],[7,'Weekly'],[14,'Every 2 weeks'],[21,'Every 3 weeks'],[2,'Every 2 days'],[3,'Every 3 days'],[4,'Every 4 days'],[5,'Every 5 days']];
const FU_FREQ=[[0,'Off'],...FU_DL];
const FU_LEAD=[['off','Off'],[3,'3 days before deadline'],[7,'1 week before deadline'],[14,'2 weeks before deadline'],[30,'1 month before deadline']];
const EVENTS=[['progress','Progress update'],['done','Work completed'],['issue','Blocked / issue'],['delay','Delay expected'],['supplier','Waiting on supplier'],['test','Test / measurement result'],['review','Design review'],['other','Other']];
const evKey=l=>(EVENTS.find(e=>e[1]===l)||['other'])[0];
const EVHEX={progress:'#2747C9',done:'#2E8B57',issue:'#C8323C',delay:'#B7791F',supplier:'#8B3FC7',test:'#0E8A7A',review:'#4A6177',other:'#7A8897'};
const parseLead=v=>v==='off'||v==='start'?'off':+v;
const fuLabel=f=>(FU_FREQ.find(x=>x[0]===+f)||FU_DL.find(x=>x[0]===+f)||[0,+f?`Every ${+f} days`:'Off'])[1];
const leadLabel=l=>(FU_LEAD.find(x=>String(x[0])===String(l==='start'?'off':l))||[7,'1 week before deadline'])[1];
function fuCfg(t,p){
  const inhF=t.fu===''||t.fu==null,inhL=t.fuLead===''||t.fuLead==null,inhD=t.fuDl===''||t.fuDl==null;
  const f=inhF?(p.fuFreq??7):+t.fu;
  let l=inhL?(p.fuLead??7):t.fuLead;l=(l==='off'||l==='start')?'off':+l;
  const dlf=inhD?(p.fuDl??2):+t.fuDl;
  return {f,l,dlf,inh:inhF,inhL,inhD};
}
const dayOf=ts=>{const d=new Date(ts);return Math.round(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/DAY)};
var upIdx=null;
function upsFor(tid){if(!upIdx){upIdx=new Map();for(const u of S.updates.values()){if(!upIdx.has(u.taskId))upIdx.set(u.taskId,[]);upIdx.get(u.taskId).push(u)}for(const a of upIdx.values())a.sort((x,y)=>y.t-x.t)}return upIdx.get(tid)||[]}
function fuState(I,p,ups){
  if(I.status==='done')return {kind:'done'};
  const c=fuCfg(I.t,p);
  const dlStart=c.l==='off'||!c.dlf?null:Math.max(I.s,I.e-c.l);
  const inDL=dlStart!=null&&TODAY>=dlStart;
  const last=ups[0]||null,lastDay=last?dayOf(last.t):null;
  const base={...c,dlStart,mode:inDL?'deadline':'regular',last};
  let freq,next;
  if(inDL){freq=c.dlf;next=lastDay!=null&&lastDay>=dlStart?lastDay+freq:dlStart}
  else{
    freq=c.f;
    if(!freq)return dlStart!=null?{...base,kind:'scheduled',next:dlStart,freq:0}:{...base,kind:'off'};
    next=(lastDay!=null&&lastDay>=I.s?lastDay:I.s)+freq;
    if(dlStart!=null&&next>dlStart)next=dlStart;
    if(TODAY<I.s)return {...base,kind:'scheduled',next,freq};
  }
  const late=TODAY-next;
  if(late<0)return {...base,kind:'ok',next,freq};
  if(late>=freq&&late>0)return {...base,kind:'missed',next,late,freq};
  return {...base,kind:'due',next,late,freq};
}
const BELL='<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .8a3 3 0 0 1 3 3v2.1l1.1 1.6H.9L2 5.9V3.8a3 3 0 0 1 3-3zM3.9 9h2.2" fill="currentColor" stroke="currentColor" stroke-width=".6"/></svg>';
function fuChip(fu){if(!fu)return '';const dm=fu.mode==='deadline'&&fu.kind!=='done'?'<span class="dlm" title="Deadline Mode is on">Deadline mode</span>':'';return `<span class="fwrap">${fuChip0(fu)}${dm}</span>`}
function fuChip0(fu){switch(fu.kind){
  case 'missed':return `<span class="fchip bad">${BELL}Missed · ${fu.late} day${fu.late>1?'s':''}</span>`;
  case 'due':return `<span class="fchip warn">${BELL}Update due${fu.late>0?'':' today'}</span>`;
  case 'ok':return `<span class="fchip ok">Next ${fu.next===TODAY+1?'tomorrow':fmt(fu.next)}</span>`;
  case 'scheduled':return `<span class="fchip">${fu.freq===0?'Deadline mode':'First ask'} ${fmt(fu.next)}</span>`;
  case 'off':return '<span class="fchip off">Off</span>';
  default:return '<span class="fchip ok">Completed</span>'}}
function fuModeText(I,p){const c=fuCfg(I.t,p),f=I.fu;const reg=`How often: ${fuLabel(c.f).toLowerCase()}`;const dl=c.l==='off'?'Deadline mode: off':`Deadline mode: ${fuLabel(c.dlf).toLowerCase()} from ${fmt(f.dlStart)}`;
  return f.mode==='deadline'?`<s class="muted">${reg}</s><br><b class="fwarn">${dl}</b>`:`<b>${reg}</b><br><span class="muted">${dl}</span>`}
function deadlineText(I){return I.e<TODAY?`<span class="slip">${TODAY-I.e} day${TODAY-I.e>1?'s':''} past deadline</span>`:I.e===TODAY?'<span class="slip">Deadline today</span>':`${I.e-TODAY} day${I.e-TODAY>1?'s':''} to deadline (${fmt(I.e)})`}
const evRange=u=>{const a=d2n(u.evFrom);if(a==null)return null;const b=d2n(u.evTo);return {a,b:b!=null&&b>=a?b:a}};
const evTxt=u=>{const r=evRange(u);return r?(r.b>r.a?`${fmt(r.a)} – ${fmt(r.b)}`:fmt(r.a)):''};
function upItem(u){return `<div class="upit"><div class="upit-h"><span class="evchip ev-${evKey(u.event)}">${h(u.event)}</span><span class="as">${h(pName(u.by))} · ${fmtTs(u.t)}${u.progress!=null?' · '+u.progress+'%':''}</span>${evRange(u)?`<span class="evdate">📅 ${evTxt(u)}</span>`:''}${u.editedAt?'<span class="as">· edited</span>':''}${canEditUp(u)?`<button type="button" class="linkbtn" data-action="edit-update" data-id="${u.id}">Edit</button>`:''}</div><div class="upr">${h(u.remarks)}</div></div>`}
function fuCounts(){let due=0,missed=0;for(const p of S.projects.values()){const m=model(p.id);for(const id of m.leaves){const k=m.info.get(id).fu?.kind;if(k==='due')due++;else if(k==='missed')missed++}}return {due,missed}}
function fuFilteredUpdates(){return [...S.updates.values()].filter(u=>(!ui.fuProject||u.pid===ui.fuProject)&&(!ui.fuPerson||(S.tasks.get(u.taskId)||{}).assignee===ui.fuPerson)).sort((a,b)=>b.t-a.t)}
function viewFollowups(){
  const ps=projList(),ms=memberList(),ORD={missed:0,due:1,ok:2,scheduled:3,off:4};
  const rows=[];
  for(const p of ps){if(ui.fuProject&&p.id!==ui.fuProject)continue;const m=model(p.id);for(const id of m.leaves){const I=m.info.get(id);if(!I.fu||I.fu.kind==='done')continue;if(ui.fuPerson&&I.t.assignee!==ui.fuPerson)continue;rows.push({p,I})}}
  const cnt=k=>rows.filter(r=>r.I.fu.kind===k).length;
  const ups=fuFilteredUpdates(),wk=ups.filter(u=>u.t>=Date.now()-7*DAY).length;
  const up7=rows.filter(r=>['ok','scheduled'].includes(r.I.fu.kind)&&r.I.fu.next<=TODAY+7).length;
  const show=ui.fuShow||'active';
  const vis=rows.filter(r=>show==='need'?['due','missed'].includes(r.I.fu.kind):show==='active'?['due','missed','ok'].includes(r.I.fu.kind):true)
    .sort((a,b)=>ORD[a.I.fu.kind]-ORD[b.I.fu.kind]||(a.I.fu.next||0)-(b.I.fu.next||0));
  const groups=new Map();for(const r of vis){if(!groups.has(r.p.id))groups.set(r.p.id,{p:r.p,rows:[]});groups.get(r.p.id).rows.push(r)}
  const opt=(k,v,l)=>`<button class="${(ui[k]||'active')===v?'on':''}" data-action="fu-show" data-v="${v}">${l}</button>`;
  const sections=[...groups.values()].map(g=>{const mi=g.rows.filter(r=>r.I.fu.kind==='missed').length,du=g.rows.filter(r=>r.I.fu.kind==='due').length;
    return `<section class="panel"><div class="panel-h"><h2><span class="mono muted" style="font-size:13px">${h(g.p.code||'')}</span> ${h(g.p.name)}</h2><span class="small">${mi?`<span class="slip">${mi} missed</span> `:''}${du?`<span class="fwarn">${du} due</span> `:''}<span class="muted">${g.rows.length} followed</span></span></div>
    <div class="flist">${g.rows.map(({p,I})=>{const last=I.fu.last;return `<div class="frow ${I.fu.kind}">
      <div>${fuChip(I.fu)}</div>
      <div class="ft"><button class="hlink" data-action="edit-task" data-id="${I.t.id}"><span class="wbs">${I.wbs}</span> ${h(I.t.title)}</button><div class="as">${h(mName(I.t.assignee))} · ${deadlineText(I)} · ${I.prog}% done</div></div>
      <div class="as">${fuModeText(I,p)}</div>
      <div class="fl">${last?`<div class="upit-h"><span class="evchip ev-${evKey(last.event)}">${h(last.event)}</span><span class="as">${h(pName(last.by))} · ${fmtTs(last.t)}</span></div><div class="upr clamp">${h(last.remarks)}</div>`:'<span class="muted small">No updates yet</span>'}</div>
      <div class="factions"><button class="btn ${['due','missed'].includes(I.fu.kind)?'primary':''} w" data-action="add-update" data-id="${I.t.id}">Add update</button></div>
    </div>`}).join('')}</div></section>`}).join('');
  return `<div class="phead"><div><div class="eyebrow">Follow-ups frequency</div><h1 class="ptitle">Follow-ups</h1></div></div>
  <div class="stats">
    <div class="stat ${cnt('missed')?'bad':''}"><b>${cnt('missed')}</b><span>Missed</span></div>
    <div class="stat ${cnt('due')?'warn':''}"><b>${cnt('due')}</b><span>Update due now</span></div>
    <div class="stat"><b>${up7}</b><span>Coming in 7 days</span></div>
    <div class="stat"><b>${wk}</b><span>Updates this week</span></div>
  </div>
  <p class="hint" style="margin:0">Each open task asks its owner for an update at <b>How often to ask</b>. When the deadline gets close, <b>Deadline Mode</b> switches on and asks at the faster <b>Deadline frequency</b> instead, again and again until the task is marked completed. Set defaults in Project details, or per task in the task form.</p>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="Show">${opt('fuShow','need','Needs update')}${opt('fuShow','active','Following now')}${opt('fuShow','all','All open tasks')}</div>
    <select class="sel" id="fuPerson" data-change="fuPerson" aria-label="Filter by owner"><option value="">Everyone</option>${ms.map(x=>`<option value="${x.id}" ${ui.fuPerson===x.id?'selected':''}>${h(x.name)}</option>`).join('')}</select>
    <select class="sel" id="fuProject" data-change="fuProject" aria-label="Filter by project"><option value="">All projects</option>${ps.map(p=>`<option value="${p.id}" ${ui.fuProject===p.id?'selected':''}>${h(p.code||'')} ${h(p.name)}</option>`).join('')}</select>
  </div>
  ${sections||`<section class="panel"><div class="empty-note">${show==='need'?'Nothing needs an update right now.':'No tasks are being followed up yet. Follow-ups start automatically as deadlines get close.'}</div></section>`}
  <section class="panel"><div class="panel-h"><h2>Event &amp; remarks report</h2><button class="btn" data-action="fu-csv"${ups.length?'':' disabled'}>Export CSV</button></div>
    ${ups.length?`<div class="rtable"><div class="rr rh"><span>Logged</span><span>Project</span><span>Task</span><span>Event</span><span>Event date</span><span>Remarks</span><span>Progress</span><span>By</span><span></span></div>
    ${ups.slice(0,250).map(u=>{const t=S.tasks.get(u.taskId),p=S.projects.get(u.pid);return `<div class="rr"><span class="mono small">${fmtTs(u.t)}</span><span class="mono small">${h(p?p.code:'')}</span><span>${t?`<button class="hlink" data-action="edit-task" data-id="${t.id}">${h(t.title)}</button>`:'<span class="muted">Deleted task</span>'}</span><span><span class="evchip ev-${evKey(u.event)}">${h(u.event)}</span></span><span class="mono small">${evTxt(u)||'<span class="muted">—</span>'}</span><span class="upr">${h(u.remarks)}</span><span class="mono small">${u.progress!=null?u.progress+'%':''}</span><span class="small">${h(pName(u.by))}${u.editedAt?'<br><span class="muted">edited</span>':''}</span><span>${canEditUp(u)?`<button class="btn sm" data-action="edit-update" data-id="${u.id}">Edit</button>`:''}</span></div>`}).join('')}</div>`:'<div class="empty-note">No updates logged yet. Every update with its event and remarks appears here.</div>'}
  </section>`;
}
function drUpdate(d){
  const t=S.tasks.get(d.id),m=model(t.projectId),I=m.info.get(d.id),p=S.projects.get(t.projectId)||{};const ups=upsFor(d.id).slice(0,8);
  return `<form id="f" novalidate>${dHead(`${h(p.code||'')} · Task ${I.wbs}`,'Add follow-up update')}
  <div class="dr-b">
    <div class="rollup"><b>${h(t.title)}</b><br>${h(mName(t.assignee))} · ${deadlineText(I)} · ${I.prog}% done<div style="margin-top:6px">${fuChip(I.fu)}</div>${I.fu.kind!=='done'?`<div class="as" style="margin-top:4px">${fuModeText(I,p)}</div>`:''}</div>
    <div class="fld"><label for="u-event">Event</label><select id="u-event">${EVENTS.map(e=>`<option>${e[1]}</option>`).join('')}</select></div>
    <div class="fld"><label for="u-rem">Remarks</label><textarea id="u-rem" maxlength="1000" placeholder="What happened since the last update? Any problem, and what’s the next step?" autofocus></textarea></div>
    <div class="fld"><label for="u-prog">Progress now</label><div class="range"><input type="range" id="u-prog" min="0" max="100" step="5" value="${I.prog}"><output id="uProgOut">${I.prog}%</output></div></div>
    <div class="evbox"><label class="chk"><input type="checkbox" id="u-evt"> <b>Event timeline</b> · place this event on the task’s Gantt bar</label>
      <div id="evFields" hidden>
        <div class="two"><div class="fld"><label for="u-ev-from" class="sub">Event date</label><input type="date" id="u-ev-from" min="${n2d(I.s)}" max="${n2d(I.e)}" value="${n2d(Math.min(Math.max(TODAY,I.s),I.e))}"></div>
        <div class="fld"><label class="chk sub" for="u-ev-hasto"><input type="checkbox" id="u-ev-hasto"> End date</label><input type="date" id="u-ev-to" min="${n2d(I.s)}" max="${n2d(I.e)}" value="" disabled data-end="${n2d(I.e)}" aria-label="Event end date"></div></div>
        <span class="hint">Dates must fall within this task’s timeline, ${fmt(I.s)} – ${fmt(I.e)}. Tick End date for an event that lasts several days: it starts at the task’s end date (${fmt(I.e)}) and you can bring it earlier.</span>
      </div></div>
    <label class="chk"><input type="checkbox" id="u-done"> Mark the task completed (stops follow-ups)</label>
    <div class="err" id="fErr" hidden></div>
    ${ups.length?`<div class="fld"><span class="lab">Earlier updates</span>${ups.map(upItem).join('')}</div>`:''}
  </div>
  <div class="dr-f"><button type="submit" class="btn primary w">Save update</button><button type="button" class="btn" data-action="close-drawer">Cancel</button></div></form>`;
}
function saveUpdate(d){
  if(!canWrite())return formErr('You have read-only access.');
  const t=S.tasks.get(d.id);if(!t)return closeDrawer();
  const event=$('#u-event').value,remarks=$('#u-rem').value.trim();
  if(!remarks)return formErr('Add a remark so the team knows what happened.');
  const done=$('#u-done').checked;let prog=done?100:+$('#u-prog').value;
  const rec={taskId:t.id,pid:t.projectId,t:Date.now(),by:meKey(),event,remarks,progress:prog};
  if($('#u-evt')&&$('#u-evt').checked){const I=model(t.projectId).info.get(t.id);const a=d2n($('#u-ev-from').value),b=$('#u-ev-hasto').checked?d2n($('#u-ev-to').value):null;if($('#u-ev-hasto').checked&&b==null)return formErr('Pick the end date, or untick End date for a one-day event.');
    if(a==null)return formErr('Pick the event date.');
    if(a<I.s||a>I.e)return formErr(`The event date must be within the task’s timeline, ${fmt(I.s)} – ${fmt(I.e)}.`);
    if(b!=null&&(b<a||b>I.e))return formErr(b<a?'The end date is before the event date.':`The end date must be on or before the task ends (${fmt(I.e)}).`);
    rec.evFrom=n2d(a);if(b!=null&&b>a)rec.evTo=n2d(b)}
  put('updates',uid('u'),rec);
  const ch=[event,remarks.length>90?remarks.slice(0,90)+'…':remarks];if(rec.evFrom)ch.push('Event timeline: '+evTxt(rec));
  if(prog!==(+t.progress||0)||done){const st=prog>=100?'done':(t.status==='done'?'active':(t.status==='todo'&&prog>0?'active':t.status||'todo'));put('tasks',t.id,{...clean(t),progress:prog,status:st});ch.push(`Progress: ${+t.progress||0}% → ${prog}%`)}
  logH({act:'followup',kind:'task',id:t.id,pid:t.projectId,title:t.title,code:(S.projects.get(t.projectId)||{}).code||'',ch});
  closeDrawer();toast(prog>=100?'Update saved and task completed':'Update saved');
}
async function fuCsv(){
  let dl=null;try{dl=window.claude&&window.claude.use?await window.claude.use('downloads'):null}catch(e){}
  if(!dl)return toast('Downloads aren’t available in this view.');
  const esc=v=>`"${String(v??'').replace(/"/g,'""')}"`;
  const lines=[['Date','Time','Project code','Project','Task','Owner','Event','Event from','Event to','Remarks','Progress %','Updated by'].map(esc).join(',')];
  for(const u of fuFilteredUpdates()){const t=S.tasks.get(u.taskId),p=S.projects.get(u.pid)||{},d=new Date(u.t);
    lines.push([fmtY(dayOf(u.t)),d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),p.code,p.name,t?t.title:'(deleted task)',t?mName(t.assignee):'',u.event,u.evFrom?fmtY(d2n(u.evFrom)):'',u.evFrom?fmtY(d2n(u.evTo||u.evFrom)):'',u.remarks,u.progress,pName(u.by)].map(esc).join(','))}
  try{await dl.save({filename:`Followups_report_${n2d(TODAY)}.csv`,data:'﻿'+lines.join('\r\n')});toast('Report saved')}catch(e){if(!(e&&e.code==='declined'))toast('Couldn’t save the report. Try again.')}
}

/* ---------- skills, capacity & resource load ---------- */
const WDN=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
var loadCache=null;
const skillList=()=>[...S.skills.values()].sort((a,b)=>(a.order||0)-(b.order||0)||String(a.name).localeCompare(b.name));
const skillName=id=>id==='general'?'General':id==='none'||!id?'No skill set':(S.skills.get(id)||{}).name||'Removed skill';
const holidayList=()=>{const c=S.calendar.get('holidays');return ((c&&c.days)||[]).slice().sort((a,b)=>a.date<b.date?-1:1)};
function memberCap(m){return {hpd:+m.hoursPerDay>0?+m.hoursPerDay:6,wd:Array.isArray(m.workDays)&&m.workDays.length?m.workDays.map(Number):[1,2,3,4,5]}}
const onLeave=(m,n)=>(m.leave||[]).some(r=>{const a=d2n(r.from),b=d2n(r.to)??a;return a!=null&&n>=a&&n<=b});
function isWorkDay(m,n,hol){if(hol.has(n2d(n)))return false;if(!m)return !isWE(n);return memberCap(m).wd.includes(dow(n))&&!onLeave(m,n)}
function taskHours(t,owner){const e=+t.effort;if(!(e>0))return null;return t.effortUnit==='d'?e*(owner?memberCap(owner).hpd:6):e}
function taskDaily(t,I,owner,hol){
  const H=taskHours(t,owner);if(H==null)return null;
  const rem=H*(1-Math.min(100,I.prog||0)/100),out=new Map();if(rem<=0)return out;
  let a=Math.max(I.s,TODAY),b=I.e;if(b<TODAY){a=TODAY;b=Math.max(TODAY,monday(TODAY)+4)}
  const days=[];for(let n=a;n<=b;n++)if(isWorkDay(owner,n,hol))days.push(n);if(!days.length)days.push(a);
  const mode=t.spread||'even';
  if(mode!=='even'){const hpd=owner?memberCap(owner).hpd:6;if(rem<=hpd*days.length+0.01){let r=rem;const seq=mode==='late'?days.slice().reverse():days;for(const n of seq){if(r<=0)break;const x=Math.min(hpd,r);out.set(n,x);r-=x}return out}}
  const per=rem/days.length;for(const n of days)out.set(n,per);return out;
}
function computeLoad(){
  if(loadCache)return loadCache;
  const hol=new Set(holidayList().map(x=>x.date)),W0=monday(TODAY);
  const projs=[...S.projects.values()].filter(p=>p.status!=='done');let maxE=TODAY;
  const models=projs.map(p=>{const m=model(p.id);if(isFinite(m.e))maxE=Math.max(maxE,m.e);return [p,m]});
  const nW=Math.min(52,Math.max(16,Math.ceil((maxE-W0+1)/7)+1)),weeks=[...Array(nW)].map((_,i)=>W0+i*7);
  const blank=()=>({load:weeks.map(()=>0),cap:weeks.map(()=>0),items:weeks.map(()=>[])});
  const people=new Map();
  for(const m of S.members.values()){const P=blank();const c=memberCap(m);weeks.forEach((w,i)=>{let h=0;for(let n=w;n<w+7;n++)if(isWorkDay(m,n,hol))h+=c.hpd;P.cap[i]=h});people.set(m.id,P)}
  const skills=new Map(),missingEffort=[],missingSkill=[],open=new Map();
  const sk=k=>{if(!skills.has(k))skills.set(k,blank());return skills.get(k)};
  for(const [p,m] of models)for(const id of m.leaves){const I=m.info.get(id);if(I.status==='done')continue;const t=I.t;
    if(!t.skill)missingSkill.push({p,I});
    const owner=S.members.get(t.assignee),daily=taskDaily(t,I,owner,hol);
    if(owner){if(!open.has(owner.id))open.set(owner.id,[]);open.get(owner.id).push({id:t.id,s:I.s,e:I.e})}
    if(daily==null){missingEffort.push({p,I});continue}
    const wk=new Map();for(const [n,h] of daily){const w=Math.floor((n-W0)/7);if(w>=0&&w<nW)wk.set(w,(wk.get(w)||0)+h)}
    const S2=sk(t.skill||'none');
    for(const [w,h] of wk){const it={p,I,h};if(owner){const P=people.get(owner.id);P.load[w]+=h;P.items[w].push(it)}S2.load[w]+=h;S2.items[w].push(it)}
  }
  for(const s of skillList())sk(s.id);
  for(const [k,S2] of skills){if(k==='none')continue;for(const m of S.members.values()){if(k!=='general'&&!(m.skills||{})[k])continue;const P=people.get(m.id);P.cap.forEach((c,i)=>S2.cap[i]+=c)}}
  loadCache={W0,weeks,people,skills,missingEffort,missingSkill,hol,open};return loadCache;
}
function previewFor(mid,dr){
  const L=computeLoad(),P=L.people.get(mid);if(!P||dr.s==null||dr.e==null)return null;const m=S.members.get(mid);
  const add=new Map();const daily=+dr.effort>0?taskDaily({effort:dr.effort,effortUnit:dr.effortUnit,spread:dr.spread},{s:dr.s,e:dr.e,prog:dr.prog},m,L.hol):null;
  if(daily)for(const [n,h] of daily){const w=Math.floor((n-L.W0)/7);if(w>=0&&w<L.weeks.length)add.set(w,(add.get(w)||0)+h)}
  const wFrom=Math.max(0,Math.floor((Math.max(dr.s,TODAY)-L.W0)/7)),wTo=Math.min(L.weeks.length-1,Math.floor((Math.max(dr.e,TODAY)-L.W0)/7));
  let peak=-1,pw=null;
  for(let w=wFrom;w<=wTo;w++){const own=P.items[w].filter(x=>x.I.t.id===dr.id).reduce((a,x)=>a+x.h,0);const tot=P.load[w]-own+(add.get(w)||0);const u=P.cap[w]?tot/P.cap[w]:(tot>0?Infinity:0);if(u>peak){peak=u;pw=w}}
  if(pw==null)return null;
  const own=P.items[pw].filter(x=>x.I.t.id===dr.id).reduce((a,x)=>a+x.h,0);
  return {peak,w:pw,week:L.weeks[pw],cap:P.cap[pw],tot:P.load[pw]-own+(add.get(pw)||0),items:P.items[pw].filter(x=>x.I.t.id!==dr.id)};
}
function ownerOver(I){
  if(!I.leaf||I.status==='done'||!I.t.assignee)return false;const L=computeLoad(),P=L.people.get(I.t.assignee);if(!P)return false;
  const a=Math.max(0,Math.floor((Math.max(I.s,TODAY)-L.W0)/7)),b=Math.min(L.weeks.length-1,Math.floor((Math.max(I.e,TODAY)-L.W0)/7));
  for(let w=a;w<=b;w++)if(P.load[w]>P.cap[w]+0.01)return true;return false;
}
const pctTxt=(lo,ca)=>ca<=0?(lo>0?'∞':'—'):Math.round(lo/ca*100)+'%';
const utilCls=(lo,ca)=>ca<=0?(lo>0?'u2':'uz'):lo>ca+0.01?'u2':lo>=ca*0.85?'u1':lo>0?'u0':'ue';
function overloadedNow(){const L=computeLoad();let n=0;for(const P of L.people.values())if(P.load[0]>P.cap[0]+0.01)n++;return n}
function viewLoad(){
  const L=computeLoad(),nW=Math.min(ui.loadWeeks||8,L.weeks.length),by=ui.loadBy||'person',W=L.weeks.slice(0,nW),sel=ui.loadSel;
  const ms=memberList();
  let overWeeks=0;for(const P of L.people.values())for(let i=0;i<nW;i++)if(P.load[i]>P.cap[i]+0.01)overWeeks++;
  const short=[...L.skills.entries()].filter(([k,S2])=>k!=='none'&&S2.load.slice(0,nW).some((lo,i)=>lo>S2.cap[i]+0.01)).map(([k])=>skillName(k));
  const cols=`style="grid-template-columns:minmax(190px,240px) repeat(${nW},minmax(66px,1fr))"`;
  const head=`<div class="lg-row lg-h" ${cols}><span>${by==='person'?'Team member':'Skill'}</span>${W.map(w=>`<span><b class="mono">W${isoWeek(w)}</b><br>${fmt(w)}</span>`).join('')}</div>`;
  const cell=(byk,k,i,lo,ca,label)=>{const on=sel&&sel.by===byk&&sel.k===k&&sel.w===i;return `<button type="button" class="lc ${utilCls(lo,ca)} ${on?'sel':''}" data-action="load-cell" data-by="${byk}" data-k="${k}" data-w="${i}" title="${h(label)} · W${isoWeek(L.weeks[i])}: ${fh(lo)} h booked of ${fh(ca)} h"><b>${pctTxt(lo,ca)}</b><span>${fh(lo)}/${fh(ca)} h</span></button>`};
  let rows='';
  if(by==='person'){
    rows=ms.map(m=>{const P=L.people.get(m.id),sks=Object.entries(m.skills||{}).filter(([k,v])=>v&&S.skills.has(k));
      return `<div class="lg-row" ${cols}><div class="lname">${av(m.id)}<div style="min-width:0"><b>${h(m.name)}</b><div class="as">${memberCap(m).hpd} h/day · ${(()=>{const a=openNow(m.id),w=+m.wip;return w>0?`<span class="${a>w?'slip':''}">${a}/${w} active</span> · `:`${a} active · `})()}${sks.length?sks.map(([k,v])=>h(skillName(k))+(v==='expert'?' ★':'')).join(', '):'no skills set'}</div></div></div>${W.map((w,i)=>cell('person',m.id,i,P.load[i],P.cap[i],m.name)).join('')}</div>`}).join('');
  }else{
    const keys=[...skillList().map(s=>s.id),...(L.skills.has('general')?['general']:[]),...(L.skills.has('none')?['none']:[])];
    rows=keys.map(k=>{const S2=L.skills.get(k)||{load:L.weeks.map(()=>0),cap:L.weeks.map(()=>0)};const who=ms.filter(m=>k==='general'||(m.skills||{})[k]);
      return `<div class="lg-row" ${cols}><div class="lname"><span class="skdot ${k==='none'?'none':''}"></span><div style="min-width:0"><b>${h(skillName(k))}</b><div class="as">${k==='none'?'Tasks without a required skill':who.length?who.map(m=>h(m.name)+((m.skills||{})[k]==='expert'?' ★':'')).join(', '):'<span class="slip">No one has this skill</span>'}</div></div></div>${W.map((w,i)=>k==='none'?`<span class="lc ue"><b>${fh(S2.load[i])} h</b><span>demand</span></span>`:cell('skill',k,i,S2.load[i],S2.cap[i],skillName(k))).join('')}</div>`}).join('');
  }
  let detail='';
  if(sel){const src=sel.by==='person'?L.people.get(sel.k):L.skills.get(sel.k);const w=L.weeks[sel.w];
    if(src&&w!=null){const items=src.items[sel.w].slice().sort((a,b)=>b.h-a.h);const lo=src.load[sel.w],ca=src.cap[sel.w];
      const nm=sel.by==='person'?(S.members.get(sel.k)||{}).name:skillName(sel.k);
      let off='';if(sel.by==='person'){const m=S.members.get(sel.k);const ds=[];for(let n=w;n<w+7;n++){if(L.hol.has(n2d(n)))ds.push(`${WD[dow(n)]} ${fmt(n)} holiday`);else if(m&&onLeave(m,n)&&memberCap(m).wd.includes(dow(n)))ds.push(`${WD[dow(n)]} ${fmt(n)} leave`)}if(ds.length)off=`<div class="as">Not available: ${ds.join(', ')}</div>`}
      detail=`<section class="panel ldetail"><div class="panel-h"><h2>${h(nm||'')} · W${isoWeek(w)} <span class="muted small">${fmt(w)} – ${fmt(w+6)}</span></h2><button type="button" class="icon-btn" data-action="load-cell" data-by="" aria-label="Close details"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
      <div class="pc-row"><span><span class="lc-inline ${utilCls(lo,ca)}">${pctTxt(lo,ca)}</span> ${fh(lo)} h booked of ${fh(ca)} h available${sel.by==='skill'?' (everyone with this skill)':''}</span></div>${off}
      <div class="alist">${items.map(x=>`<button class="aitem" data-action="edit-task" data-id="${x.I.t.id}">${av(x.I.t.assignee)}<span style="min-width:0"><div class="at">${h(x.I.t.title)}</div><div class="as"><span class="mono">${h(x.p.code||'')} ${x.I.wbs}</span> · ${h(skillName(x.I.t.skill))}${sel.by==='skill'?' · '+h(mName(x.I.t.assignee)):''} · ${fmt(x.I.s)} – ${fmt(x.I.e)}</div></span><span class="mono">${Math.round(x.h*10)/10} h</span></button>`).join('')||'<div class="empty-note">Nothing booked this week.</div>'}</div></section>`}}
  const miss=[...L.missingEffort.map(x=>({...x,why:'No effort'})),...L.missingSkill.filter(x=>!L.missingEffort.includes(x)).map(x=>({...x,why:'No skill'}))];
  const seg=(k,v,l)=>`<button class="${(k==='loadBy'?by:String(ui.loadWeeks||8))===String(v)?'on':''}" data-action="load-opt" data-k="${k}" data-v="${v}">${l}</button>`;
  return `<div class="phead"><div><div class="eyebrow">Across all active projects</div><h1 class="ptitle">Resource load</h1></div><div class="actions"><button class="btn ${overWeeks?'primary':''} w" data-action="level">Suggest fixes</button></div></div>
  <div class="stats">
    <div class="stat ${overloadedNow()?'bad':''}"><b>${overloadedNow()}</b><span>Overloaded this week</span></div>
    <div class="stat ${overWeeks?'warn':''}"><b>${overWeeks}</b><span>Overloaded person-weeks</span></div>
    <div class="stat ${short.length?'bad':''}"><b>${short.length}</b><span>Short skills</span></div>
    <div class="stat ${L.missingEffort.length?'warn':''}"><b>${L.missingEffort.length}</b><span>Tasks missing effort</span></div>
  </div>
  ${short.length?`<div class="banner bad"><span><b>Not enough capacity:</b> ${short.map(h).join(', ')}. Switch to “By skill” to see which weeks.</span></div>`:''}
  <div class="toolbar"><div class="seg" role="group" aria-label="View by">${seg('loadBy','person','By person')}${seg('loadBy','skill','By skill')}</div>
    <div class="seg" role="group" aria-label="Weeks">${seg('loadWeeks',4,'4 wks')}${seg('loadWeeks',8,'8 wks')}${seg('loadWeeks',12,'12 wks')}${seg('loadWeeks',16,'16 wks')}</div>
    <div class="legend"><span><i class="u0"></i>Under 85%</span><span><i class="u1"></i>85–100%</span><span><i class="u2"></i>Over 100%</span></div></div>
  <div class="lgrid">${head}${rows||'<div class="empty-note" style="padding:14px">Add team members to see their load.</div>'}</div>
  <p class="hint" style="margin:0">Remaining effort of each open task is spread over its remaining working days, minus leave and holidays. Capacity is each person’s hours per day on their working days. Click a cell to see which tasks fill it.</p>
  ${detail}
  ${miss.length?`<section class="panel"><div class="panel-h"><h2>Fill in to make the load accurate</h2><span class="muted small">${miss.length}</span></div><p class="hint" style="margin:0">Tasks without effort aren’t counted in anyone’s load.</p>
    <div class="alist">${miss.slice(0,20).map(x=>`<button class="aitem" data-action="edit-task" data-id="${x.I.t.id}">${av(x.I.t.assignee)}<span style="min-width:0"><div class="at">${h(x.I.t.title)}</div><div class="as"><span class="mono">${h(x.p.code||'')} ${x.I.wbs}</span> · ${h(mName(x.I.t.assignee))}</div></span><span class="slip small">${x.why}</span></button>`).join('')}</div></section>`:''}`;
}
/* admin: skills & calendar */
function viewSkills(){
  const manage=canManage(),dis=manage?'':' disabled';const L=computeLoad();
  const used=id=>{let t=0;for(const x of S.tasks.values())if(x.skill===id)t++;return t};
  const ppl=id=>memberList().filter(m=>(m.skills||{})[id]);
  return `<div class="phead"><div><h1 class="ptitle">Skills &amp; calendar</h1><div class="psub">The skills your projects need, and company holidays that reduce capacity.</div></div></div>
  ${manage?'':'<div class="banner bad">Only the owner, or an admin shared as Editor, can change skills and holidays.</div>'}
  <section class="panel"><div class="panel-h"><h2>Skills</h2><span class="muted small">${S.skills.size}</span></div>
    <div class="alist">${skillList().map(s=>{const p=ppl(s.id);return `<div class="skrow2"><span class="skdot"></span><div style="min-width:0"><b>${h(s.name)}</b><div class="as">${p.length?p.map(m=>h(m.name)+((m.skills||{})[s.id]==='expert'?' ★':'')).join(', '):'<span class="slip">No one has this skill</span>'} · ${used(s.id)} task${used(s.id)===1?'':'s'}</div></div><div class="actions"><button class="btn" data-action="rename-skill" data-id="${s.id}"${dis}>Rename</button><button class="btn danger" data-action="del-skill" data-id="${s.id}" data-two="Confirm delete"${dis}>Delete</button></div></div>`}).join('')||'<div class="empty-note">No skills yet. Add the skills your projects need, for example Antenna design, RF hardware, Firmware, Mould design.</div>'}</div>
    <form id="skillForm" class="addrow" novalidate><input type="text" id="newSkill" placeholder="New skill, e.g. Antenna design" maxlength="60" aria-label="New skill"${dis}><button type="submit" class="btn primary"${dis}>Add skill</button></form>
    <p class="hint" style="margin:0">Set each person’s skills and level (Expert or Can assist) in their Team profile.</p>
  </section>
  <section class="panel"><div class="panel-h"><h2>Company holidays</h2><span class="muted small">${holidayList().filter(x=>x.date>=n2d(TODAY)).length} upcoming</span></div>
    <div class="alist">${holidayList().map((x,i)=>`<div class="skrow2"><span class="mono small">${WD[dow(d2n(x.date))]} ${fmtY(d2n(x.date))}</span><div style="min-width:0">${h(x.name||'Holiday')}</div><div class="actions"><button class="btn danger" data-action="del-hol" data-v="${x.date}" data-two="Remove"${dis}>Remove</button></div></div>`).join('')||'<div class="empty-note">No holidays added.</div>'}</div>
    <form id="holForm" class="addrow" novalidate><input type="date" id="holDate" aria-label="Holiday date"${dis}><input type="text" id="holName" placeholder="e.g. Diwali" maxlength="60" aria-label="Holiday name"${dis}><button type="submit" class="btn primary"${dis}>Add holiday</button></form>
  </section>`;
}
function wireSkills(){
  const f=$('#skillForm');if(f)f.addEventListener('submit',ev=>{ev.preventDefault();const n=$('#newSkill').value.trim();if(!n)return;
    if(skillList().some(s=>s.name.toLowerCase()===n.toLowerCase()))return toast('That skill already exists.');
    put('skills',uid('s'),{name:n,order:Date.now()},{sys:true});logH({act:'changed',kind:'settings',title:`added the skill “${n}”`});toast('Skill added')});
  const g=$('#holForm');if(g)g.addEventListener('submit',ev=>{ev.preventDefault();const d=$('#holDate').value,n=$('#holName').value.trim();if(!d)return toast('Pick a date for the holiday.');
    const days=holidayList().filter(x=>x.date!==d);days.push({date:d,name:n||'Holiday'});put('calendar','holidays',{days},{sys:true});logH({act:'changed',kind:'settings',title:`added the holiday ${n||'Holiday'} on ${fmtY(d2n(d))}`});toast('Holiday added')});
}
function drSkill(d){const s=S.skills.get(d.id)||{name:''};return `<form id="f" novalidate>${dHead('Skills','Rename skill')}<div class="dr-b"><div class="fld"><label for="sk-name">Skill name</label><input type="text" id="sk-name" value="${h(s.name)}" maxlength="60" autofocus></div><div class="err" id="fErr" hidden></div></div><div class="dr-f"><button type="submit" class="btn primary">Save</button><button type="button" class="btn" data-action="close-drawer">Cancel</button></div></form>`}
function saveSkill(d){const n=$('#sk-name').value.trim();if(!n)return formErr('Enter a name.');if(skillList().some(s=>s.id!==d.id&&s.name.toLowerCase()===n.toLowerCase()))return formErr('Another skill already has this name.');const s=S.skills.get(d.id);put('skills',d.id,{...clean(s),name:n},{sys:true});logH({act:'changed',kind:'settings',title:`renamed the skill “${s.name}” to “${n}”`});closeDrawer();toast('Skill renamed')}
function deleteSkill(id){const s=S.skills.get(id);if(!s||!canManage())return;
  for(const m of S.members.values())if((m.skills||{})[id]){const sk={...m.skills};delete sk[id];put('members',m.id,{...clean(m),skills:sk})}
  for(const t of S.tasks.values())if(t.skill===id)put('tasks',t.id,{...clean(t),skill:''});
  del('skills',id,{sys:true});logH({act:'changed',kind:'settings',title:`deleted the skill “${s.name}”`});toast('Skill deleted. Tasks that needed it now show “No skill”.')}
/* task form: skill-aware owner picker */
function wireOwnerPicker(){
  const fsk=$('#f-skill');if(!fsk||!drawer||drawer.type!=='task')return;
  const tk=drawer.id?S.tasks.get(drawer.id):drawer.draft,sel=$('#f-assignee');sel.dataset.v=tk.assignee||'';
  const vals=()=>({sk:fsk.value,ov:!!($('#f-override')&&$('#f-override').checked),s:d2n($('#f-start').value),e:d2n($('#f-end').value),eff:+$('#f-effort').value,unit:$('#f-eunit').value,spread:$('#f-spread').value,prog:+$('#f-progress').value||0});
  const lvl=(m,sk)=>sk==='general'?'any':(m.skills||{})[sk]||'';
  const pv=(m,v)=>v.s!=null&&v.e!=null?previewFor(m.id,{id:drawer.id,s:v.s,e:Math.max(v.s,v.e),prog:v.prog,effort:v.eff,effortUnit:v.unit,spread:v.spread}):null;
  const label=(m,v)=>{const p=pv(m,v),l=lvl(m,v.sk),pc=p?(isFinite(p.peak)?Math.round(p.peak*100)+'%':'no capacity'):'';return `${m.name}${l==='expert'?' · Expert':l==='assist'?' · Can assist':''}${pc?' · '+pc:''}${p&&p.peak>1?' ⚠ overloaded':''}`};
  const build=()=>{const v=vals(),cur=sel.dataset.v,ms=memberList();
    const has=ms.filter(m=>v.sk&&lvl(m,v.sk)).sort((a,b)=>(lvl(b,v.sk)==='expert')-(lvl(a,v.sk)==='expert')||((pv(a,v)||{}).peak||0)-((pv(b,v)||{}).peak||0));
    const others=ms.filter(m=>!has.includes(m)&&(v.ov||m.id===cur));
    let html='<option value="">Unassigned</option>';
    if(!v.sk)html+='<option value="" disabled>Choose the required skill first</option>';
    else html+=`<optgroup label="${v.sk==='general'?'Team':'Has this skill'}">${has.map(m=>`<option value="${m.id}">${h(label(m,v))}</option>`).join('')||'<option value="" disabled>No one has this skill yet</option>'}</optgroup>`;
    if(others.length)html+=`<optgroup label="Without this skill${v.ov?' (admin override)':''}">${others.map(m=>`<option value="${m.id}">${h(label(m,v))}</option>`).join('')}</optgroup>`;
    sel.innerHTML=html;sel.value=[...sel.options].some(o=>o.value===cur&&!o.disabled)?cur:'';
    // effort hint
    const owner=S.members.get(sel.value),eh=$('#effHint');
    if(v.eff>0&&v.s!=null&&v.e!=null&&v.e>=v.s){const L=computeLoad();const H=taskHours({effort:v.eff,effortUnit:v.unit},owner);let n=0;for(let d=v.s;d<=v.e;d++)if(isWorkDay(owner,d,L.hol))n++;n=Math.max(1,n);const per=H/n,hpd=owner?memberCap(owner).hpd:6;
      eh.innerHTML=v.spread==='even'||H>hpd*n?`${fh(H)} h of work over ${n} working day${n>1?'s':''} ≈ <b>${fh(per)} h per day</b>${owner?` (${h(owner.name)} works ${hpd} h/day)`:''}.${per>hpd+0.01?' <span class="slip">That’s more than one person can do in a day.</span>':''}`:`${fh(H)} h of work, booked at ${hpd} h/day ${v.spread==='early'?'from the start date':'in the last days before the end date'}: about ${Math.ceil(H/hpd)} working day${Math.ceil(H/hpd)>1?'s':''} of the ${n}.`}
    else eh.textContent=v.eff>0?'':'Effort is the actual work time the task needs, not its calendar length.';
    // warning
    const w=$('#ownWarn'),m=S.members.get(sel.value);w.innerHTML='';
    if(m&&v.sk&&v.sk!=='general'&&!lvl(m,v.sk))w.innerHTML=`<div class="alert"><span><b>${h(m.name)}</b> doesn’t have the skill “${h(skillName(v.sk))}”. Saving marks this task “Assigned outside skill”.</span></div>`;
    const p=m?pv(m,v):null;
    if(p&&p.peak>1)w.innerHTML+=`<div class="alert"><span><b>Overload:</b> with this task ${h(m.name)} is at <b>${isFinite(p.peak)?Math.round(p.peak*100)+'%':'no capacity (leave or holiday)'}</b> in W${isoWeek(p.week)} (${fmt(p.week)}): ${Math.round(p.tot)} h booked of ${p.cap} h.${p.items.length?` Already booked that week: ${p.items.slice(0,4).map(x=>`${h(x.p.code||'')} ${h(x.I.t.title)} (${Math.round(x.h)} h)`).join(', ')}${p.items.length>4?'…':''}.`:''}</span></div>`;
    if(m&&+m.wip>0&&v.s!=null&&v.e!=null){const c=concurrent(m.id,v.s,Math.max(v.s,v.e),drawer.id)+1;if(c>+m.wip)w.innerHTML+=`<div class="alert"><span><b>Too many at once:</b> ${h(m.name)} would have ${c} tasks running at the same time (limit ${m.wip}).</span></div>`}
    if(p&&p.peak>1){}else if(p&&p.peak>=0.85)w.innerHTML+=`<div class="hint">${h(m.name)} would be at ${Math.round(p.peak*100)}% in W${isoWeek(p.week)}, close to full.</div>`;
  };
  sel.addEventListener('change',()=>{sel.dataset.v=sel.value;build()});
  ['#f-skill','#f-override','#f-start','#f-end','#f-eunit','#f-spread','#f-progress'].forEach(q=>{const el=$(q);if(el)el.addEventListener('change',build)});
  const ef=$('#f-effort');if(ef)ef.addEventListener('input',build);
  build();
}

/* ---------- phase 3: priority, WIP limits, levelling ---------- */
const fh=x=>{x=+x||0;return x<10?Math.round(x*10)/10:Math.round(x)};
const SPREAD=[['even','Even across the task dates'],['early','As early as possible'],['late','Just before the deadline']];
const projRank=p=>+p.rank>0?+p.rank:99;
function openNow(mid){const L=computeLoad();return (L.open.get(mid)||[]).filter(x=>x.s<=TODAY&&x.e>=TODAY).length}
function concurrent(mid,s,e,exclude){const L=computeLoad(),list=(L.open.get(mid)||[]).filter(x=>x.id!==exclude);let mx=0;
  for(let n=Math.max(s,TODAY);n<=e;n++){if(isWE(n))continue;let c=0;for(const x of list)if(x.s<=n&&x.e>=n)c++;if(c>mx)mx=c}return mx}
function planLevel(){
  const L=computeLoad(),H=Math.min(L.weeks.length,16);
  const info=new Map();for(const p of S.projects.values()){if(p.status==='done')continue;const m=model(p.id);for(const id of m.leaves)info.set(id,{p,m,I:m.info.get(id)})}
  const moved=new Map(),props=[];
  const dist=(t,I,owner,s,e)=>{const d=taskDaily(t,{s,e,prog:I.prog},owner,L.hol)||new Map(),w=new Map();for(const [n,h] of d){const k=Math.floor((n-L.W0)/7);if(k>=0&&k<L.weeks.length)w.set(k,(w.get(k)||0)+h)}return w};
  const limitEnd=x=>{const {m,I,p}=x;let lim=Infinity;for(const id of [I.t.id,...I.anc])for(const sid of (m.succ.get(id)||[])){const mv=moved.get(sid);lim=Math.min(lim,(mv?mv.s:m.info.get(sid).s)-1)}
    if(!isFinite(lim)){const tg=d2n(p.target);lim=tg!=null?Math.max(tg,I.e):m.e}return lim};
  let left=0;
  for(const [mid,P0] of L.people){const owner=S.members.get(mid);const P={load:P0.load.slice(),cap:P0.cap};
    for(let w=0;w<H;w++){let guard=0;
      while(P.load[w]>P.cap[w]+0.01&&guard++<12){
        const cands=P0.items[w].map(it=>info.get(it.I.t.id)).filter(x=>x&&!moved.has(x.I.t.id)&&x.I.s>TODAY&&!(x.I.prog>0))
          .sort((a,b)=>projRank(b.p)-projRank(a.p)||((limitEnd(b)-b.I.e)-(limitEnd(a)-a.I.e)));
        let ok=false;
        for(const x of cands){const I=x.I,t=I.t,lim=limitEnd(x);if(lim-I.e<1)continue;
          const old=dist(t,I,owner,I.s,I.e);let best=null;
          for(let k=1;k<=Math.min(lim-I.e,120);k++){const ns=I.s+k,ne=I.e+k;if(isWE(ns))continue;if(ne>lim)break;
            const nw=dist(t,I,owner,ns,ne),tmp=P.load.slice();for(const [kk,h] of old)tmp[kk]-=h;for(const [kk,h] of nw)tmp[kk]+=h;
            const worse=[...nw.keys()].some(kk=>kk!==w&&tmp[kk]>P.cap[kk]+0.01&&tmp[kk]>P.load[kk]+0.01);if(worse)continue;
            if(tmp[w]<P.load[w]-0.01){best={ns,ne,tmp};if(tmp[w]<=P.cap[w]+0.01)break}}
          if(best){const before=P.load[w];P.load=best.tmp;moved.set(t.id,{s:best.ns,e:best.ne});props.push({...x,mid,w,s:best.ns,e:best.ne,before,after:P.load[w],cap:P.cap[w]});ok=true;break}}
        if(!ok)break}
      if(P.load[w]>P.cap[w]+0.01)left++}}
  return {props,left,L};
}
function drLevel(d){
  if(!d.plan){d.plan=planLevel();d.pick=new Set(d.plan.props.map(x=>x.I.t.id))}
  const {props,left,L}=d.plan;
  return `${dHead('Resource load','Suggested fixes')}
  <div class="dr-b">
    <p style="margin:0">${props.length?`Moving these ${props.length} task${props.length>1?'s':''} later, within their slack, reduces overload without delaying any linked task or going past the project target. Tasks from lower-priority projects move first. Untick any you want to keep.`:'No task can be moved to reduce the overload. Overloaded tasks have either started already or have no slack before the next linked task or the project target.'}</p>
    <div>${props.map(x=>`<label class="mv lvl"><input type="checkbox" data-lvl="${x.I.t.id}" ${d.pick.has(x.I.t.id)?'checked':''}><span class="wbs">${h(x.p.code||'')} ${x.I.wbs}</span><span>${h(x.I.t.title)}</span><span class="d"><s>${fmt(x.I.s)} – ${fmt(x.I.e)}</s> → <b>${fmt(x.s)} – ${fmt(x.e)}</b> (+${x.s-x.I.s}d) · ${h(mName(x.mid))} W${isoWeek(L.weeks[x.w])}: ${pctTxt(x.before,x.cap)} → ${pctTxt(x.after,x.cap)}${projRank(x.p)<99?` · project P${projRank(x.p)}`:''}</span></label>`).join('')}</div>
    ${left?`<div class="alert"><span><b>${left} overloaded person-week${left>1?'s':''} remain${left>1?'':'s'}</b> that moving tasks can’t fix. Consider reassigning to someone else with the skill, reducing effort, extending the deadline or adding help.</span></div>`:''}
  </div>
  <div class="dr-f">${props.length?`<button type="button" class="btn primary w" data-action="apply-level">Move ${d.pick.size} task${d.pick.size===1?'':'s'}</button>`:''}<button type="button" class="btn" data-action="close-drawer">${props.length?'Cancel':'Close'}</button></div>`;
}
function applyLevel(){
  const d=drawer;if(!d||!d.plan||!canWrite())return;const sel=d.plan.props.filter(x=>d.pick.has(x.I.t.id));if(!sel.length)return;closeDrawer();
  for(const x of sel){const t=S.tasks.get(x.I.t.id);if(t)put('tasks',t.id,{...clean(t),start:n2d(x.s),end:n2d(x.e)})}
  logH({act:'moved',kind:'bulk',title:`Levelled resource load: moved ${sel.length} task${sel.length>1?'s':''}`,ch:sel.map(x=>`${x.p.code||''} ${x.I.wbs} ${x.I.t.title}: ${fmt(x.s)} – ${fmt(x.e)}`)});
  toast(`Moved ${sel.length} task${sel.length>1?'s':''}`);
}

/* ---------- model ---------- */
const memberList=()=>[...S.members.values()].sort((a,b)=>(a.order||0)-(b.order||0)||String(a.name).localeCompare(b.name));
const projList=()=>{const r={active:0,planning:1,hold:2,done:3};return [...S.projects.values()].sort((a,b)=>(r[a.status]??1)-(r[b.status]??1)||projRank(a)-projRank(b)||(a.order||0)-(b.order||0))};
const mColor=id=>{const m=S.members.get(id);return m?`var(--m${(m.hue||0)%8})`:'var(--ink-3)'};
const av=(id,lg)=>{const m=S.members.get(id);return `<span class="av${lg?' lg':''}" style="--mc:${mColor(id)}" title="${h(m?m.name:'Unassigned')}">${m?h(initials(m.name)):'–'}</span>`};
const mName=id=>{const m=S.members.get(id);return m?m.name:'Unassigned'};

function model(pid){
  const PJ=S.projects.get(pid)||{};
  const list=[...S.tasks.values()].filter(t=>t.projectId===pid);
  const byId=new Map(list.map(t=>[t.id,t]));
  const kids=new Map();
  for(const t of list){const p=byId.has(t.parentId)&&t.parentId!==t.id?t.parentId:'';if(!kids.has(p))kids.set(p,[]);kids.get(p).push(t)}
  for(const a of kids.values())a.sort((x,y)=>(x.order||0)-(y.order||0)||String(x.title).localeCompare(y.title));
  const info=new Map(),flat=[];
  (function walk(p,prefix,depth,anc){(kids.get(p)||[]).forEach((t,i)=>{if(info.has(t.id))return;const w=prefix?prefix+'.'+(i+1):String(i+1);const ch=kids.get(t.id)||[];info.set(t.id,{t,wbs:w,depth,kids:ch,anc,leaf:!ch.length});flat.push(t.id);walk(t.id,w,depth+1,[...anc,t.id])})})('','',0,[]);
  const clampP=v=>Math.min(100,Math.max(0,+v||0));
  for(const id of flat){const I=info.get(id);I.par=I.kids.length>0;const os=d2n(I.t.start),oe=d2n(I.t.end);
    I.leaf=!I.par||(os!=null&&oe!=null&&oe>=os);
    if(I.leaf){I.s=os??TODAY;I.e=Math.max(I.s,oe??I.s);I.dur=Math.max(1,workdays(I.s,I.e));I.prog=clampP(I.t.progress);I.pw=I.dur*I.prog;
      I.status=I.prog>=100?'done':(I.t.status&&I.t.status!=='done'?I.t.status:(I.prog>0?'active':'todo'))}}
  const aggSt=st=>!st.length?'todo':st.every(x=>x==='done')?'done':st.includes('blocked')?'blocked':(st.includes('active')||st.includes('done'))?'active':'todo';
  for(const id of flat){const I=info.get(id);if(!I.par)continue;
    const desc=flat.filter(x=>x!==id&&info.get(x).anc.includes(id)&&info.get(x).leaf).map(x=>info.get(x));
    let rs=Infinity,re=-Infinity,rd=0,rpw=0;for(const D of desc){rs=Math.min(rs,D.s);re=Math.max(re,D.e);rd+=D.dur;rpw+=D.pw}
    if(!desc.length){rs=re=TODAY}
    I.rs=rs;I.re=re;I.rdur=rd;I.rpw=rpw;I.rprog=rd?Math.round(rpw/rd):0;I.rstatus=aggSt(desc.map(D=>D.status));I.ropen=desc.filter(D=>D.status!=='done').length;
    if(!I.leaf){I.s=rs;I.e=re;I.dur=rd||1;I.pw=rpw;I.prog=I.rprog;I.status=I.rstatus}
    else if(desc.length){I.ps=I.s;I.pe=I.e;I.early=Math.max(0,I.s-rs);I.late=Math.max(0,re-I.e);I.outside=I.early>0||I.late>0}}
  for(const id of flat){const I=info.get(id);
    I.deps=(I.t.deps||[]).filter(d=>info.has(d)&&d!==id);
    I.over=I.leaf&&I.e<TODAY&&I.prog<100;
    I.fu=I.leaf?fuState(I,PJ,upsFor(id)):null;
  }
  const conflicts=[],succ=new Map();
  for(const id of flat){const I=info.get(id);for(const d of I.deps){const P=info.get(d);if(!succ.has(d))succ.set(d,[]);succ.get(d).push(id);if(I.s<=P.e){conflicts.push({id,d});I.conflict=true}}}
  // series vs parallel (leaves)
  let series=0,parallel=0;
  for(const id of flat){const I=info.get(id);if(!I.leaf)continue;
    const chainIds=[id,...I.anc];const linked=chainIds.some(x=>info.get(x).deps.length||succ.has(x));
    I.linked=linked;linked?series++:parallel++}
  const leaves=flat.filter(id=>info.get(id).leaf);
  let s=Infinity,e=-Infinity,dur=0,pw=0;
  for(const id of leaves){const I=info.get(id);s=Math.min(s,I.s);e=Math.max(e,I.e);dur+=I.dur;pw+=I.pw}
  return {pid,info,flat,kids,conflicts,succ,s,e,prog:dur?Math.round(pw/dur):0,leaves,
    done:leaves.filter(id=>info.get(id).status==='done').length,
    over:leaves.filter(id=>info.get(id).over).length,series,parallel};
}
function effPreds(m,id){const I=m.info.get(id);const out=[...I.deps];for(const a of I.anc)out.push(...m.info.get(a).deps);return out}
function blockedReason(m,tid,pid){
  if(tid===pid)return 'this task';
  const T=m.info.get(tid),P=m.info.get(pid);
  if(!T)return '';
  if(T.anc.includes(pid))return 'parent of this task';
  if(P.anc.includes(tid))return 'subtask of this task';
  const edges=id=>{const I=m.info.get(id);return [...effPreds(m,id),...I.kids.map(c=>c.id)]};
  const seen=new Set(),st=[pid];
  while(st.length){const x=st.pop();if(seen.has(x))continue;seen.add(x);for(const y of edges(x))st.push(y)}
  for(const x of seen){if(x===pid)continue;if(x===tid||T.anc.includes(x)||m.info.get(x).anc.includes(tid))return 'would create a loop'}
  return '';
}
function planResolve(pid){
  const m=model(pid);const leaves=m.leaves;
  const st=new Map(),en=new Map();
  leaves.forEach(id=>{const I=m.info.get(id);st.set(id,I.s);en.set(id,I.e)});
  const effE=id=>{const I=m.info.get(id);if(I.leaf)return en.get(id);let e=-Infinity;for(const c of I.kids)e=Math.max(e,effE(c.id));return e};
  for(let pass=0;pass<300;pass++){let changed=false;
    for(const id of leaves){let mx=-Infinity;for(const d of effPreds(m,id))mx=Math.max(mx,effE(d));
      if(isFinite(mx)&&st.get(id)<=mx){const ns=nextWork(mx);const sh=ns-st.get(id);st.set(id,ns);en.set(id,en.get(id)+sh);changed=true}}
    if(!changed)break}
  return leaves.filter(id=>st.get(id)!==m.info.get(id).s).map(id=>({id,I:m.info.get(id),s:st.get(id),e:en.get(id)}));
}

/* ---------- render ---------- */
function render(){renderRail();renderMain()}
function renderRail(){
  const ps=projList();const r=role();
  const brand=`<div class="brand">
    <div class="mark">${MARK}</div>
    <div><div class="brand-name">RFID R&amp;D Planner</div>
    <div class="brand-sub"><span class="dot ${mode==='live'?'live':''}"></span>${mode==='live'?'Shared · live':mode==='local'?'Local preview':'Connecting…'}</div></div>
  </div>`;
  const me=meReady?`<div class="me">${uav(meKey())}<div style="min-width:0"><div class="me-n">${h(pName(meKey()))}</div><div class="me-r">${mode==='local'?'Preview mode':ROLE[r]}${myCreds()&&!gateState()?' · '+h(myCreds().loginId):''}</div></div>${!gateState()?`<button class="icon-btn" data-action="sign-out" title="Sign out" aria-label="Sign out"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M5.5 2H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.5M9 4.5 11.5 7 9 9.5M11.5 7H5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`:''}</div>`:'';
  if(gateState()){$('#rail').innerHTML=brand+me;return}
  const pend=isAdmin()?S.requests.size:0;
  $('#rail').innerHTML=`${brand}${me}
  <nav class="nav">
    <button class="nav-btn ${ui.view==='overview'?'on':''}" data-action="go" data-view="overview">Overview</button>
    ${(()=>{const c=fuCounts(),n=c.due+c.missed;return `<button class="nav-btn ${ui.view==='followups'?'on':''}" data-action="go" data-view="followups">Follow-ups ${n?`<span class="badge">${n}</span>`:''}</button>`})()}
    ${(()=>{const n=S.members.size?overloadedNow():0;return `<button class="nav-btn ${ui.view==='load'?'on':''}" data-action="go" data-view="load">Resource load ${n?`<span class="badge">${n}</span>`:''}</button>`})()}
    <button class="nav-btn ${ui.view==='history'?'on':''}" data-action="go" data-view="history">History</button>
    ${isAdmin()?`<button class="nav-btn ${ui.view==='admin'?'on':''}" data-action="go" data-view="admin">Admin settings ${pend?`<span class="badge">${pend}</span>`:''}</button>`:''}
  </nav>
  <div class="rail-sec"><span>Projects</span><button class="icon-btn w" data-action="new-project" aria-label="New project" title="New project"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
  <div class="plist">${ps.map(p=>{const m=model(p.id);return `<button class="pitem ${ui.view==='project'&&ui.pid===p.id?'on':''}" data-action="open-project" data-id="${p.id}">
      <span class="pcode">${h(p.code||'')}${projRank(p)<99?` · P${projRank(p)}`:''}</span><span class="count">${m.prog}%</span><span class="pname">${h(p.name)}</span><span class="pmeter"><i style="width:${m.prog}%"></i></span></button>`}).join('')||'<p class="muted small" style="margin:0 10px">No projects yet.</p>'}</div>`;
}
function renderMain(){
  const main=$('#main');
  document.body.classList.toggle('ro',!canWrite());
  const g=$('#gantt');
  if(g&&ui.pid)ui.scroll[ui.pid+ui.zoom]={l:g.scrollLeft,t:g.scrollTop};
  if(!isLoaded()){main.innerHTML='<div class="loading">Loading your planner…</div>';return}
  const ids=[...S.access.keys(),...S.requests.keys(),...S.history.keys()];
  for(const c of STAMPED)for(const x of S[c].values()){if(x.updatedBy)ids.push(x.updatedBy);if(x.createdBy)ids.push(x.createdBy)}
  for(const d of S.history.values())for(const e of (d.entries||[]))if(e.who)ids.push(e.who);
  for(const u of S.updates.values())ids.push(u.by);
  wantProfiles(ids);
  const gs=gateState();if(gs){if(drawer)closeDrawer();if(!(gs==='login'&&$('#loginForm'))){main.innerHTML=viewGate(gs);wireGate()}return}
  if(ui.view==='project'&&!S.projects.has(ui.pid))ui.view='overview';
  if(ui.view==='team'||ui.view==='access'){ui.adminTab=ui.view;ui.view='admin'}
  if(ui.view==='admin'&&!isAdmin())ui.view='overview';
  if(ui.view==='admin'&&ui.adminTab==='email'&&emailDirty&&$('#emailForm'))return;
  if(ui.view==='project')main.innerHTML=viewProject();
  else if(ui.view==='history')main.innerHTML=viewHistory();
  else if(ui.view==='followups')main.innerHTML=viewFollowups();
  else if(ui.view==='load')main.innerHTML=viewLoad();
  else if(ui.view==='admin'){main.innerHTML=viewAdmin();if(ui.adminTab==='access')wireAccess();if(ui.adminTab==='email')wireEmail();if(ui.adminTab==='skills')wireSkills()}
  else main.innerHTML=viewOverview();
  const g2=$('#gantt');
  if(g2){const sv=ui.scroll[ui.pid+ui.zoom];
    if(sv){g2.scrollLeft=sv.l;g2.scrollTop=sv.t}
    else{g2.scrollLeft=Math.max(0,(+g2.dataset.todayx||0)-g2.clientWidth*0.25);ui.scroll[ui.pid+ui.zoom]={l:g2.scrollLeft,t:0}}
    g2.addEventListener('scroll',()=>{ui.scroll[ui.pid+ui.zoom]={l:g2.scrollLeft,t:g2.scrollTop}},{passive:true});
  }
}
const hasExamples=()=>[...S.members.values(),...S.projects.values(),...S.tasks.values()].some(x=>x.example);
function exampleBanner(){return hasExamples()?`<div class="banner"><span><b>Example data is loaded.</b> Explore it, then remove it when you start adding your own projects.</span><span class="spacer"></span><button class="btn danger w" data-action="remove-examples" data-two="Remove all example data">Remove examples</button></div>`:''}
function roBanner(){if(mode==='live'&&isAdmin()&&!myCreds()&&ME.id)return `<div class="banner"><span><b>Set your own login ID and password</b> so this account also asks for them when the planner opens.</span><span class="spacer"></span><button class="btn primary" data-action="set-login" data-id="${ME.id}">Set my login</button></div>`;return !canWrite()&&mode==='live'?`<div class="banner">You have <b>read-only</b> access. You can view every project, timeline and the history. Ask an admin if you need to make changes.</div>`:''}

function viewOverview(){
  const ps=projList();
  const head=`<div class="phead"><div><div class="eyebrow">${WD[dow(TODAY)]} ${fmtY(TODAY)} · Week ${isoWeek(TODAY)}</div><h1 class="ptitle">Overview</h1></div>
    <div class="actions"><button class="btn w" data-action="new-member">Add team member</button><button class="btn primary w" data-action="new-project">New project</button></div></div>`;
  if(!ps.length&&!S.members.size){
    return `${roBanner()}<section class="hero">
      <div class="eyebrow">Getting started</div>
      <h1>Plan every R&amp;D project down to the last subtask, and see who waits on whom.</h1>
      <p>Break projects into tasks and subtasks, give each one an owner and dates, and link tasks that must finish before others can start. Tasks without links run in parallel. Everyone on your team sees the same live schedule on desktop or phone.</p>
      <div class="steps">
        <div class="step"><b>01</b><h3>Add your team</h3><p class="muted">Name, role, and a colour that marks their bars on the timeline.</p></div>
        <div class="step"><b>02</b><h3>Create a project</h3><p class="muted">Give it a code and a target date so slips show up early.</p></div>
        <div class="step"><b>03</b><h3>Build the task tree</h3><p class="muted">Nest subtasks, set dates, and tick “depends on” to chain work in series.</p></div>
      </div>
      <div class="actions"><button class="btn primary w" data-action="new-member">Add team member</button><button class="btn w" data-action="new-project">New project</button><button class="btn w" data-action="load-example">Load example project</button></div>
      <p class="hint">The example adds a UHF reader project and a tag qualification project with five sample team members, all labelled “Example” so you can remove them in one step.</p>
    </section>`;
  }
  const MM=new Map(ps.map(p=>[p.id,model(p.id)]));
  let open=0,over=0,conf=0;const overL=[],soonL=[],confL=[];
  for(const p of ps){const m=MM.get(p.id);conf+=m.conflicts.length;
    for(const id of m.leaves){const I=m.info.get(id);if(I.status==='done')continue;open++;
      if(I.over){over++;overL.push({p,I})}else if(I.e<=TODAY+7)soonL.push({p,I})}
    for(const c of m.conflicts)confL.push({p,I:m.info.get(c.id),P:m.info.get(c.d)});
  }
  overL.sort((a,b)=>a.I.e-b.I.e);soonL.sort((a,b)=>a.I.e-b.I.e);
  const item=(p,I,sub,bad)=>`<button class="aitem" data-action="edit-task" data-id="${I.t.id}">${av(I.t.assignee)}<span style="min-width:0"><div class="at">${h(I.t.title)}</div><div class="as"><span class="mono">${h(p.code||'')} ${I.wbs}</span> · ${h(mName(I.t.assignee))}</div></span><span class="date ${bad?'bad':''}">${sub}</span></button>`;
  const active=ps.filter(p=>p.status!=='done').length;
  return `${roBanner()}${head}${exampleBanner()}
  <div class="stats">
    <div class="stat"><b>${active}</b><span>Active projects</span></div>
    <div class="stat"><b>${open}</b><span>Open tasks</span></div>
    <div class="stat ${over?'bad':''}"><b>${over}</b><span>Overdue</span></div>
    <div class="stat ${soonL.length?'warn':''}"><b>${soonL.length}</b><span>Due in 7 days</span></div>
    <div class="stat ${conf?'bad':''}"><b>${conf}</b><span>Link conflicts</span></div>
    ${(()=>{const c=fuCounts(),n=c.due+c.missed;return `<button type="button" class="stat statbtn ${c.missed?'bad':n?'warn':''}" data-action="go" data-view="followups"><b>${n}</b><span>Follow-ups due</span></button>`})()}
  </div>
  <div class="pcards">${ps.map(p=>{const m=MM.get(p.id);const tgt=d2n(p.target);const slip=tgt&&isFinite(m.e)&&m.e>tgt?m.e-tgt:0;
    return `<button class="pcard" data-action="open-project" data-id="${p.id}">
      <div class="pc-top"><span class="eyebrow"><span class="mono">${h(p.code||'')}</span>${projRank(p)<99?`<span class="prk">P${projRank(p)}</span>`:''}${p.example?'<span class="ex">Example</span>':''}</span><span class="chip st-${p.status||'planning'}">${PSTATUS[p.status]||'Planning'}</span></div>
      <h3>${h(p.name)}</h3>
      <div class="meter"><i style="width:${m.prog}%"></i></div>
      <div class="pc-row"><span class="mono">${m.prog}% · ${m.done}/${m.leaves.length} tasks</span><span title="Drafted Timeline Detected range">${isFinite(m.s)?'Detected '+fmt(m.s)+' → '+fmt(m.e):'No tasks yet'}</span></div>
      <div class="pc-row"><span>${p.owner?av(p.owner)+' ':''}${m.over?`<span class="slip">${m.over} overdue</span>`:''}${m.conflicts.length?` <span class="slip">· ${m.conflicts.length} conflict${m.conflicts.length>1?'s':''}</span>`:''}</span>
      ${tgt?(slip?`<span class="slip">Forecast ${slip} day${slip>1?'s':''} past target</span>`:`<span class="ontrack">On track for ${fmt(tgt)}</span>`):''}</div>
    </button>`}).join('')}</div>
  <div class="grid2">
    <section class="panel"><div class="panel-h"><h2>Overdue</h2><span class="muted small">${overL.length}</span></div>
      <div class="alist">${overL.slice(0,8).map(x=>item(x.p,x.I,'due '+fmt(x.I.e),true)).join('')||'<div class="empty-note">Nothing overdue.</div>'}</div></section>
    <section class="panel"><div class="panel-h"><h2>Due in the next 7 days</h2><span class="muted small">${soonL.length}</span></div>
      <div class="alist">${soonL.slice(0,8).map(x=>item(x.p,x.I,(x.I.e===TODAY?'today':fmt(x.I.e)))).join('')||'<div class="empty-note">No deadlines this week.</div>'}</div></section>
    <section class="panel"><div class="panel-h"><h2>Link conflicts</h2><span class="muted small">${confL.length}</span></div>
      <div class="alist">${confL.slice(0,8).map(x=>item(x.p,x.I,'waits on '+x.P.wbs,true)).join('')||'<div class="empty-note">Every linked task starts after its predecessors finish.</div>'}</div></section>
  </div>
  ${heatmap(MM)}`;
}
function heatmap(MM){
  const ms=memberList();if(!ms.length)return '';
  const w0=monday(TODAY),weeks=[0,1,2,3,4,5].map(i=>w0+i*7);
  const rows=[...ms.map(m=>({id:m.id,name:m.name})),{id:'',name:'Unassigned'}];
  const counts=new Map(rows.map(r=>[r.id,weeks.map(()=>0)]));
  for(const m of MM.values())for(const id of m.leaves){const I=m.info.get(id);if(I.status==='done')continue;const k=S.members.has(I.t.assignee)?I.t.assignee:'';weeks.forEach((w,i)=>{if(I.s<=w+4&&I.e>=w)counts.get(k)[i]++})}
  const lv=c=>c===0?'l0':c<=2?'l1':c<=4?'l2':'l3';
  const shown=rows.filter(r=>r.id||counts.get('').some(x=>x));
  return `<section class="panel"><div class="panel-h"><h2>Open tasks per week</h2><div class="legend"><span><i class="l1"></i>1–2 tasks</span><span><i class="l2"></i>3–4</span><span><i class="l3"></i>5+ overloaded</span></div></div>
  <p class="hint" style="margin:0">Open tasks per person that overlap each working week. Use it to spot who can take parallel work.</p>
  <div class="heat"><table><thead><tr><th>Member</th>${weeks.map(w=>`<th><span class="mono">W${isoWeek(w)}</span><br>${fmt(w)}</th>`).join('')}</tr></thead>
  <tbody>${shown.map(r=>`<tr><td class="nm">${r.id?av(r.id):av('')}${h(r.name)}</td>${counts.get(r.id).map(c=>`<td class="c ${lv(c)}">${c||''}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
}

function visibleRows(m){
  const rows=[];
  let keep=null;
  if(ui.fAssignee||ui.fStatus){keep=new Set();
    for(const id of m.flat){const I=m.info.get(id);
      const okA=!ui.fAssignee||(ui.fAssignee==='_none'?!S.members.has(I.t.assignee):I.t.assignee===ui.fAssignee);
      const okS=!ui.fStatus||(ui.fStatus==='over'?I.over:ui.fStatus==='conflict'?I.conflict:I.status===ui.fStatus);
      if(okA&&okS&&(I.leaf||ui.fStatus==='conflict')){keep.add(id);I.anc.forEach(a=>keep.add(a))}}}
  for(const id of m.flat){const I=m.info.get(id);if(keep&&!keep.has(id))continue;if(I.anc.some(a=>ui.collapsed.has(a)))continue;rows.push(id)}
  return rows;
}
function viewProject(){
  const p=S.projects.get(ui.pid);const m=model(p.id);const rows=visibleRows(m);
  const tgt=d2n(p.target);const slip=tgt&&isFinite(m.e)&&m.e>tgt?m.e-tgt:0;
  const ms=memberList();
  const body=!m.flat.length?`<section class="hero"><h1 style="font-size:22px">Start the task tree for ${h(p.name)}</h1><p>Add top-level work packages first (for example Hardware, Firmware, Validation), then open each one to add subtasks with owners and dates.</p><div class="actions"><button class="btn primary w" data-action="new-task">Add first task</button></div></section>`
    :!rows.length?`<div class="panel"><div class="empty-note">No tasks match these filters.</div></div>`
    :(ui.mode==='timeline'?gantt(m,rows,p):listView(m,rows));
  return `${roBanner()}
  <div class="phead"><div style="min-width:0">
    <div class="eyebrow"><span class="mono">${h(p.code||'')}</span>${projRank(p)<99?`<span class="prk">P${projRank(p)}</span>`:''}<span class="chip st-${p.status||'planning'}">${PSTATUS[p.status]||'Planning'}</span>${p.example?'<span class="ex">Example</span>':''}</div>
    <h1 class="ptitle">${h(p.name)}</h1>
    <div class="psub"><span title="Calculated from the earliest task start to the latest task end">Drafted Timeline Detected range: <b>${isFinite(m.s)?`${fmtY(m.s)} → ${fmtY(m.e)}`:'no tasks yet'}</b></span>${tgt?`<span>Target ${fmtY(tgt)}</span>`:''}${p.owner?`<span>Lead: ${h(mName(p.owner))}</span>`:''}${slip?`<span class="slip">Forecast ${slip} day${slip>1?'s':''} past target</span>`:''}</div>
  </div>
  <div class="actions">${m.conflicts.length?`<button class="btn warn" data-action="resolve">Fix ${m.conflicts.length} link conflict${m.conflicts.length>1?'s':''}</button>`:''}<button class="btn" data-action="export"${m.flat.length?'':' disabled'}><svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5v8M3.8 6.5 7 9.7l3.2-3.2M2 12.5h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Export Gantt</button><button class="btn" data-action="edit-project">Project details</button><button class="btn primary w" data-action="new-task">Add task</button></div></div>
  ${p.example?exampleBanner():''}
  <div class="stats">
    <div class="stat"><b>${m.prog}%</b><span>Complete</span></div>
    <div class="stat"><b>${m.done}/${m.leaves.length}</b><span>Tasks done</span></div>
    <div class="stat ${m.over?'bad':''}"><b>${m.over}</b><span>Overdue</span></div>
    <div class="stat ${m.conflicts.length?'bad':''}"><b>${m.conflicts.length}</b><span>Conflicts</span></div>
    <div class="stat"><b>${m.series}</b><span>Linked (series)</span></div>
    <div class="stat"><b>${m.parallel}</b><span>Independent (parallel)</span></div>
  </div>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="View"><button class="${ui.mode==='timeline'?'on':''}" data-action="set-mode" data-v="timeline">Timeline</button><button class="${ui.mode==='list'?'on':''}" data-action="set-mode" data-v="list">List</button></div>
    ${ui.mode==='timeline'?`<div class="seg" role="group" aria-label="Zoom"><button class="${ui.zoom==='day'?'on':''}" data-action="set-zoom" data-v="day">Days</button><button class="${ui.zoom==='week'?'on':''}" data-action="set-zoom" data-v="week">Weeks</button></div><button class="btn" data-action="jump-today">Today</button>`:''}
    <select class="sel" id="fAssignee" data-change="fAssignee" aria-label="Filter by person"><option value="">Everyone</option>${ms.map(x=>`<option value="${x.id}" ${ui.fAssignee===x.id?'selected':''}>${h(x.name)}</option>`).join('')}<option value="_none" ${ui.fAssignee==='_none'?'selected':''}>Unassigned</option></select>
    <select class="sel" id="fStatus" data-change="fStatus" aria-label="Filter by status"><option value="">All statuses</option>${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${ui.fStatus===k?'selected':''}>${v}</option>`).join('')}<option value="over" ${ui.fStatus==='over'?'selected':''}>Overdue</option><option value="conflict" ${ui.fStatus==='conflict'?'selected':''}>Link conflicts</option></select>
    <span class="spacer"></span>
    <button class="btn" data-action="expand-all">Expand all</button><button class="btn" data-action="collapse-all">Collapse all</button>
  </div>
  ${body}`;
}
function flags(I){return `${I.outside?`<span class="flag warn" title="Subtasks run outside this task’s dates (${fmt(I.s)} – ${fmt(I.e)})">⇥</span>`:''}${I.leaf&&I.par&&I.status==='done'&&I.ropen?`<span class="flag warn" title="Marked done but ${I.ropen} subtask(s) still open">✓</span>`:''}${ownerOver(I)?'<span class="flag warn" title="Owner is overloaded during this task (see Resource load)">%</span>':''}${I.leaf&&I.t.outsideSkill?'<span class="flag warn" title="Assigned outside skill">S</span>':''}${I.fu&&I.fu.kind==='missed'?`<span class="flag" title="Follow-up missed">${BELL}</span>`:I.fu&&I.fu.kind==='due'?`<span class="flag warn" title="Follow-up update due">${BELL}</span>`:''}${I.conflict?'<span class="flag" title="Starts before a linked task finishes">!</span>':''}${I.over?'<span class="flag warn" title="Past end date">⏱</span>':''}`}
const SHORTST={todo:'To do',active:'Active',blocked:'Blocked',done:'Done'};
function nameCell(I,cls){
  const id=I.t.id;
  return `${!I.par?'<span class="caret-sp"></span>':`<button class="caret ${ui.collapsed.has(id)?'':'open'}" data-action="toggle" data-id="${id}" aria-label="${ui.collapsed.has(id)?'Expand':'Collapse'} ${h(I.t.title)}">${chevron}</button>`}
  <span class="wbs">${I.wbs}</span><button class="tname" data-action="edit-task" data-id="${id}">${h(I.t.title)}</button>${flags(I)}`;
}
function gantt(m,rows,p){
  const dw=ui.zoom==='week'?11:30, RH=window.innerWidth<=760?40:38;
  let s0=isFinite(m.s)?Math.min(m.s,TODAY):TODAY, e0=isFinite(m.e)?Math.max(m.e,TODAY):TODAY+30;
  for(const id of rows){const R=m.info.get(id);if(R.ps!=null){s0=Math.min(s0,R.ps);e0=Math.max(e0,R.pe)}}
  const tgt=d2n(p.target);if(tgt)e0=Math.max(e0,tgt);
  s0=monday(s0-7);e0=e0+21;e0=monday(e0)+6;
  const days=e0-s0+1,W=days*dw,H=rows.length*RH;
  const x=n=>(n-s0)*dw;
  let weeks='';for(let n=s0;n<=e0;n+=7)weeks+=`<div class="g-w" style="width:${7*dw}px"><b>W${isoWeek(n)}</b>${ui.zoom==='day'?fmt(n):''}</div>`;
  let dayRow='',we='';
  for(let n=s0;n<=e0;n++){if(ui.zoom==='day')dayRow+=`<div class="g-d ${isWE(n)?'we':''} ${n===TODAY?'td':''}" style="width:${dw}px">${WD[dow(n)][0]}<b>${new Date(n*DAY).getUTCDate()}</b></div>`;if(dow(n)===6)we+=`<div class="g-we" style="left:${x(n)}px;width:${2*dw}px"></div>`}
  const idx=new Map(rows.map((id,i)=>[id,i]));
  const bars=rows.map((id,i)=>{const I=m.info.get(id);const PL=!I.leaf&&I.ps!=null,bs=PL?I.ps:I.s,be=PL?I.pe:I.e;const left=x(bs),wid=Math.max((be-bs+1)*dw-2,6);
    const lbl=I.leaf?`${h(I.t.title)}`:`${I.prog}%`;const out=!I.leaf||wid<Math.min(220,I.t.title.length*6.5+20);
    const stTxt=STATUS[I.status]+(I.over&&I.status!=='done'?', overdue':'');
    const tip=PL?`${I.wbs} ${I.t.title} · planned ${fmt(I.ps)} – ${fmt(I.pe)} · subtasks ${fmt(I.s)} – ${fmt(I.e)} · ${I.prog}%`:`${I.wbs} ${I.t.title} · ${fmt(I.s)} – ${fmt(I.e)} · ${I.dur} working day${I.dur>1?'s':''} · ${I.prog}% · ${stTxt}${I.leaf?' · '+mName(I.t.assignee):''}`;
    const bar=`<button class="bar ${I.leaf?'':'sum'} ${PL?'plan':''} ${PL&&I.outside?'pout':''} ${I.leaf?'bs-'+I.status:''} ${I.status==='done'?'done':''} ${I.conflict?'conflict':''} ${I.over?'over':''}" style="left:${left}px;width:${wid}px;--mc:${mColor(I.t.assignee)}" data-action="edit-task" data-id="${id}" title="${h(tip)}" aria-label="${h(tip)}"><span class="fill" style="width:${I.prog}%"></span><span class="lbl ${out?'out':''}">${I.status==='done'?'✓ ':I.status==='blocked'?'⛔ ':''}${I.leaf&&!out?lbl:(I.leaf?lbl+' · '+I.prog+'% · '+SHORTST[I.status]:PL?`${I.prog}% · planned`:`${I.prog}% · ${SHORTST[I.status]}`)}</span></button>`;
    let marks='';
    if(I.leaf&&I.par&&I.rs!=null){const segs=[[I.rs,I.re,'']];if(I.late)segs.push([Math.max(I.e+1,I.rs),I.re,'bad']);if(I.early)segs.push([I.rs,Math.min(I.s-1,I.re),'bad']);for(const [a,b,c2] of segs)marks+=`<span class="sub-span ${c2}" style="left:${x(a)}px;width:${Math.max((b-a+1)*dw-2,4)}px" title="Subtasks run ${fmt(I.rs)} – ${fmt(I.re)} · ${I.rprog}% done${c2?' · outside this task’s dates':''}"></span>`}
    if(I.leaf&&I.fu&&I.fu.dlStart!=null&&I.fu.kind!=='done'){const z0=Math.max(I.fu.dlStart,s0);if(z0<=I.e)marks+=`<span class="dl-zone ${I.fu.mode==='deadline'?'on':''}" style="left:${x(z0)}px;width:${Math.max((I.e-z0+1)*dw-2,4)}px" title="Deadline mode from ${fmt(I.fu.dlStart)}: ${h(fuLabel(I.fu.dlf).toLowerCase())}"></span>`}
    if(I.leaf){for(const u of upsFor(id)){const r=evRange(u);if(r){if(r.b<s0||r.a>e0)continue;const tip=h(`Event ${evTxt(u)} · ${u.event} · ${pName(u.by)}: ${u.remarks}`);marks+=r.b>r.a?`<span class="ev-seg ev-${evKey(u.event)}" style="left:${x(r.a)+1}px;width:${Math.max((r.b-r.a+1)*dw-3,6)}px" title="${tip}"></span>`:`<span class="ev-pin ev-${evKey(u.event)}" style="left:${x(r.a)+dw/2-5}px" title="${tip}"></span>`;continue}
      const n=dayOf(u.t);if(n<s0||n>e0)continue;marks+=`<span class="fu-dot ev-${evKey(u.event)}" style="left:${x(n)+dw/2-3}px" title="${h(fmt(n)+' · '+u.event+' · '+pName(u.by)+': '+u.remarks)}"></span>`}
      const f=I.fu;if(f&&['due','missed','ok','scheduled'].includes(f.kind)&&f.next>=s0&&f.next<=e0)marks+=`<span class="fu-next ${f.kind}" style="left:${x(f.next)+dw/2-5}px" title="${h((f.kind==='missed'?'Follow-up missed, was due ':f.kind==='due'?'Follow-up due ':'Next follow-up ')+fmt(f.next))}"></span>`}
    return `<div class="g-row ${I.par?'par':''}"><div class="g-name" style="--dep:${I.depth}">${nameCell(I)}<span class="gst s-${I.over&&I.status!=='done'?'late':I.status}" title="${h(I.leaf?STATUS[I.status]+(I.over&&I.status!=='done'?' · overdue':''):'From subtasks: '+STATUS[I.status])}">${I.over&&I.status!=='done'?'Overdue':SHORTST[I.status]}</span>${I.leaf?av(I.t.assignee):''}</div><div class="g-lane" style="width:${W}px">${bar}${marks}</div></div>`}).join('');
  let links='';
  for(const id of rows){const I=m.info.get(id);for(const d of I.deps){if(!idx.has(d))continue;const P=m.info.get(d);
    const x1=x(P.e+1)-2,y1=idx.get(d)*RH+RH/2,x2=x(I.s),y2=idx.get(id)*RH+RH/2;const bad=I.s<=P.e;
    let path;if(x2-x1>=14)path=`M${x1} ${y1}H${x1+7}V${y2}H${x2-1}`;else{const ym=y2+(y2>y1?-RH/2:RH/2);path=`M${x1} ${y1}H${x1+7}V${ym}H${x2-9}V${y2}H${x2-1}`}
    links+=`<path d="${path}" class="${bad?'bad':''}" marker-end="url(#${bad?'ahb':'ah'})"/>`}}
  return `<div class="gantt" id="gantt" data-todayx="${x(TODAY)}">
   <div style="width:calc(var(--namew) + ${W}px)">
    <div class="g-head"><div class="g-corner">Task</div><div class="g-scale" style="width:${W}px"><div class="g-weeks">${weeks}</div>${ui.zoom==='day'?`<div class="g-days">${dayRow}</div>`:''}</div></div>
    <div class="g-body" style="height:${H}px">
      <div class="g-bg" style="left:var(--namew);width:${W}px">${we}${tgt?`<div class="g-target" style="left:${x(tgt+1)}px"><span>Target</span></div>`:''}<div class="g-today" style="left:${x(TODAY)+dw/2-1}px" title="Today"></div></div>
      <svg class="g-links" style="left:var(--namew)" width="${W}" height="${H}" aria-hidden="true"><defs>
        <marker id="ah" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7z" class="ah"/></marker>
        <marker id="ahb" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7z" class="ah bad"/></marker></defs>${links}</svg>
      ${bars}
    </div>
   </div></div>
   <p class="hint" style="margin:-8px 0 0">Arrows link a task to the work it waits on (finish → start). Red dashed arrows start before their predecessor finishes. Dots under a bar are logged updates; pins and coloured segments are Event timeline entries; diamonds mark the next follow-up (orange due, red missed); the striped band above a bar is its Deadline Mode window; a parent task with its own dates has its own bar; the thin line under it shows the dates its subtasks cover (red where they run outside the parent’s dates). The chip next to each name and the bar style show the current status (outlined = to do, filled = active, red stripes = blocked, ✓ = done). Tap any bar or name to edit.</p>`;
}
function listView(m,rows){
  return `<div class="lt"><div class="lr lh"><span>Task</span><span class="c-h">Owner</span><span class="c-h">Start</span><span class="c-h">End</span><span class="c-h">Days</span><span class="c-h">Progress</span><span class="c-h">Status</span><span class="c-h">Follow-up</span><span class="c-h">Waits on</span></div>
  ${rows.map(id=>{const I=m.info.get(id);const deps=I.deps.map(d=>{const P=m.info.get(d);return `<span class="depchip ${I.s<=P.e?'bad':''}" title="${h(P.t.title)}">${P.wbs}</span>`}).join('');
    return `<div class="lr ${I.par?'par':''}" data-action="edit-task" data-id="${id}" style="--dep:${I.depth}">
      <div class="lcell-t">${nameCell(I)}</div>
      <div class="who c-h">${I.leaf?av(I.t.assignee)+`<span>${h(mName(I.t.assignee))}</span>`:''}</div>
      <span class="date c-h">${fmt(I.s)}</span><span class="date c-h ${I.over?'bad':''}">${fmt(I.e)}</span>
      <span class="date c-h">${I.dur}</span>
      <div class="prog c-h"><i><b style="width:${I.prog}%"></b></i>${I.prog}%</div>
      <span class="c-h"><span class="chip st-${I.status}">${STATUS[I.status]}</span></span>
      <span class="c-h">${I.leaf?fuChip(I.fu):''}</span>
      <div class="deps c-h">${deps||(I.leaf&&!I.linked?'<span class="muted small">Parallel</span>':'')}</div>
      <div class="meta-m">${I.leaf?`<span>${h(mName(I.t.assignee))}</span>`:''}<span class="mono ${I.over?'slip':''}">${fmt(I.s)} – ${fmt(I.e)}</span><span class="mono">${I.prog}%</span><span class="chip st-${I.status}">${STATUS[I.status]}</span>${I.leaf&&I.fu&&I.fu.kind!=='done'?fuChip(I.fu):''}${deps?`<span>waits on ${deps}</span>`:''}</div>
    </div>`}).join('')}</div>`;
}
function viewTeam(){
  const ms=memberList();const ps=projList();const MM=new Map(ps.map(p=>[p.id,model(p.id)]));
  const per=new Map(ms.map(x=>[x.id,[]]));
  for(const p of ps){const m=MM.get(p.id);for(const id of m.leaves){const I=m.info.get(id);if(per.has(I.t.assignee)&&I.status!=='done')per.get(I.t.assignee).push({p,I})}}
  return `${roBanner()}<div class="phead"><div><div class="eyebrow">${ms.length} member${ms.length===1?'':'s'}</div><h1 class="ptitle">Team</h1></div><div class="actions"><button class="btn primary w" data-action="new-member">Add team member</button></div></div>
  ${ms.length?heatmap(MM):'<section class="panel"><div class="empty-note">Add the people on your R&amp;D team. Each person gets a colour that marks their tasks on every timeline.</div></section>'}
  <div class="mcards">${ms.map(x=>{const L=per.get(x.id).sort((a,b)=>a.I.e-b.I.e);const ov=L.filter(t=>t.I.over).length;
    return `<section class="mcard"><div class="mc-top">${av(x.id,true)}<div style="min-width:0"><h3>${h(x.name)}${x.example?' <span class="ex">Example</span>':''}</h3><div class="muted small">${h(x.role||'Team member')}</div><div class="small ${x.email?'':'slip'}">${x.email?h(x.email):'No email ID yet'}</div></div><span class="spacer"></span><button class="btn" data-action="edit-member" data-id="${x.id}">Edit</button></div>
      <div class="skchips">${Object.entries(x.skills||{}).filter(([k,v])=>v&&S.skills.has(k)).map(([k,v])=>`<span class="skchip ${v}">${h(skillName(k))}${v==='expert'?' ★':''}</span>`).join('')||'<span class="muted small">No skills set</span>'}<span class="muted small">· ${memberCap(x).hpd} h/day</span></div>${userLine(x.id)}<div class="pc-row"><span>${L.length} open task${L.length===1?'':'s'}</span>${ov?`<span class="slip">${ov} overdue</span>`:''}</div>
      <div class="alist">${L.slice(0,10).map(({p,I})=>`<button class="aitem" data-action="edit-task" data-id="${I.t.id}"><span class="mono small muted">${h(p.code||'')}</span><span style="min-width:0"><div class="at">${h(I.t.title)}</div><div class="as">${I.wbs} · ${I.prog}% · ${STATUS[I.status]}</div></span><span class="date ${I.over?'bad':''}">${fmt(I.e)}</span></button>`).join('')||'<div class="empty-note">No open tasks.</div>'}</div>
    </section>`}).join('')}</div>`;
}

/* ---------- login ID + password (set by admins, checked on top of the claude.ai account) ---------- */
const b64e=u=>btoa(String.fromCharCode(...u));
const b64d=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function hashPw(pw,salt,iter){const enc=new TextEncoder();const key=await crypto.subtle.importKey('raw',enc.encode(pw),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:b64d(salt),iterations:iter,hash:'SHA-256'},key,256);return b64e(new Uint8Array(bits))}
const myCreds=()=>ME.id?S.creds.get(ME.id):null;
let authMem=null,fails=0,lockUntil=0;
const SK=()=>'rfid-auth-'+ME.id;
function sessionOk(c){if(authMem===c.setAt)return true;for(const k of ['sessionStorage','localStorage']){try{const v=JSON.parse(window[k].getItem(SK())||'null');if(v&&v.setAt===c.setAt&&v.exp>Date.now())return true}catch(e){}}return false}
function startSession(c,keep){authMem=c.setAt;try{(keep?localStorage:sessionStorage).setItem(SK(),JSON.stringify({setAt:c.setAt,exp:Date.now()+(keep?7*DAY:12*3600e3)}))}catch(e){}}
function signOut(){fetch('/api/auth/logout',{method:'POST'}).finally(()=>{location.href='/login'});return;authMem=null;try{sessionStorage.removeItem(SK());localStorage.removeItem(SK())}catch(e){}closeDrawer();toast('Signed out');render()}
function gateState(){
  if(mode!=='live')return null;
  return role()==='disabled'?'disabled':null;
  if(!ME.id)return 'signedout';
  if(role()==='disabled')return 'disabled';
  if(role()==='none')return S.requests.get(ME.id)?'pending':'request';
  const c=myCreds();if(!c)return isAdmin()?null:'nologin';
  return sessionOk(c)?null:'login';
}
async function doLogin(){
  const c=myCreds();if(!c)return;const err=$('#lErr');
  if(Date.now()<lockUntil){err.textContent=`Too many attempts. Try again in ${Math.ceil((lockUntil-Date.now())/1000)} seconds.`;err.hidden=false;return}
  const id=$('#l-id').value.trim(),pw=$('#l-pw').value,btn=$('#lBtn');
  if(!id||!pw){err.textContent='Enter your login ID and password.';err.hidden=false;return}
  btn.disabled=true;btn.textContent='Checking…';
  let ok=false;try{ok=id.toLowerCase()===c.loginKey&&await hashPw(pw,c.salt,c.iter)===c.hash}catch(e){}
  btn.disabled=false;btn.textContent='Sign in';
  if(ok){fails=0;startSession(c,$('#l-keep').checked);toast('Signed in');render()}
  else{fails++;if(fails>=5){lockUntil=Date.now()+30000;fails=0}err.textContent='Login ID or password is incorrect.';err.hidden=false;$('#l-pw').value='';$('#l-pw').focus()}
}
function wireGate(){
  const f=$('#reqForm');if(f)f.addEventListener('submit',ev=>{ev.preventDefault();requestAccess()});
  const l=$('#loginForm');if(l){l.addEventListener('submit',ev=>{ev.preventDefault();doLogin()});const i=$('#l-id');if(i&&!i.value)i.focus()}
  const t=$('#l-show');if(t)t.addEventListener('click',()=>{const p=$('#l-pw');p.type=p.type==='password'?'text':'password';t.textContent=p.type==='password'?'Show':'Hide'});
}
const accRole=uid=>uid===ME.id&&isAdmin()?'admin':((S.access.get(uid)||{}).role||'none');
const suggestId=n=>String(n||'').toLowerCase().replace(/[^a-z0-9]+/g,'.').replace(/^\.+|\.+$/g,'').slice(0,24);
function genPw(){const A='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';for(;;){const r=crypto.getRandomValues(new Uint32Array(12));const p=[...r].map(x=>A[x%A.length]).join('');if(/\d/.test(p)&&/[a-z]/.test(p)&&/[A-Z]/.test(p))return p}}
function drCred(d){
  const c=S.creds.get(d.uid);const nm=pName(d.uid);
  return `<form id="f" novalidate>${dHead('Users &amp; access',`Login for ${h(nm)}`)}
  <div class="dr-b">
    <div class="who-row">${uav(d.uid,true)}<div style="min-width:0"><div class="me-n">${h(nm)}</div><div class="me-r">${ROLE[accRole(d.uid)]}${c?' · Login ID '+h(c.loginId):''}</div></div></div>
    <div class="fld"><label for="c-id">Login ID</label><input type="text" id="c-id" value="${h(c?c.loginId:suggestId(nm))}" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="32" autofocus></div>
    <span class="hint">3–32 characters: letters, digits, dots, dashes or underscores. Not case-sensitive.</span>
    <div class="fld"><label for="c-pw">Password</label><div class="codebox"><input type="text" id="c-pw" value="${h((S.pwvault.get(d.uid)||{}).pw||'')}" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64"><button type="button" class="btn" data-action="gen-pw">Generate</button></div></div>
    <span class="hint">At least 8 characters. Admins can see it later on the Users &amp; access page. Give it to ${h(nm)} privately. Saving signs them out so they use the new details.</span>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary">${c?'Save login':'Create login'}</button>${c?`<span class="spacer"></span><button type="button" class="btn danger" data-action="remove-login" data-id="${d.uid}" data-two="Confirm remove">Remove login</button>`:'<button type="button" class="btn" data-action="close-drawer">Cancel</button>'}</div></form>`;
}
function loginLine(u){
  const c=S.creds.get(u);if(!c)return '<span class="slip">No login yet</span>';
  if(!canManage())return `Login ID <span class="mono">${h(c.loginId)}</span>`;
  const v=S.pwvault.get(u);return loginBits(u,c.loginId,v&&v.pw);
}
function dropLogin(u){if(S.creds.has(u))del('creds',u,{sys:true});if(S.pwvault.has(u))del('pwvault',u,{sys:true})}
function userLine(mid){
  const accs=[...S.access.values()].filter(a=>a.memberId===mid);
  if(!accs.length)return `<div class="uline muted small">No user login linked yet${isAdmin()?'. When they request access, link the request to this member.':''}</div>`;
  return accs.map(a=>`<div class="uline">${uav(a.id)}<span><b>${h(pName(a.id))}</b> · ${ROLE[accRole(a.id)]}${isAdmin()&&S.creds.get(a.id)?' · <span class="mono">'+h(S.creds.get(a.id).loginId)+'</span>':isAdmin()?' · <span class="slip">no login</span>':''}</span>${isAdmin()?`<button class="btn" data-action="set-login" data-id="${a.id}">Login</button>`:''}</div>`).join('');
}
async function saveCred(d){
  if(!isAdmin())return;
  const loginId=$('#c-id').value.trim(),pw=$('#c-pw').value;
  if(!/^[A-Za-z0-9._-]{3,32}$/.test(loginId))return formErr('Login ID must be 3–32 letters, digits, dots, dashes or underscores.');
  const key=loginId.toLowerCase();
  if(loginTaken(key,d.uid,null))return formErr(`Login ID “${loginId}” is already used by someone else.`);
  if(pw.length<8)return formErr('The password needs at least 8 characters.');
  const salt=b64e(crypto.getRandomValues(new Uint8Array(16))),iter=150000;
  let hash;try{hash=await hashPw(pw,salt,iter)}catch(e){return formErr('This browser couldn’t secure the password. Try a different browser.')}
  const had=S.creds.has(d.uid);const rec={loginId,loginKey:key,salt,hash,iter,setAt:Date.now(),setBy:meKey()};
  if(d.uid===ME.id)startSession(rec,false);
  put('creds',d.uid,rec,{sys:true});
  put('pwvault',d.uid,{pw,setAt:rec.setAt},{sys:true});
  logH({act:had?'reset':'login',kind:'access',who:d.uid,ch:['Login ID: '+loginId]});
  closeDrawer();toast(had?'New password saved':'Login created');
}

/* ---------- logins prepared for team members who haven't joined yet + enable/disable ---------- */
function loginBits(key,id,pw){
  const shown=ui.pwShown.has(key);
  return `Login ID <span class="mono">${h(id)}</span> · Password ${pw?`<span class="mono pw">${shown?h(pw):'••••••••'}</span> <button type="button" class="linkbtn" data-action="pw-toggle" data-id="${h(key)}">${shown?'Hide':'Show'}</button> <button type="button" class="linkbtn" data-action="pw-copy" data-id="${h(key)}">Copy</button>`:'<span class="muted">set before passwords were viewable, edit the login to see it</span>'}`;
}
function memberLoginLine(mid){const ml=S.memberlogin.get(mid);if(!ml)return '<span class="muted">No login yet</span>';return loginBits('m:'+mid,ml.loginId,ml.pw)+'<div class="as">Activates when they join</div>'}
function pwFor(key){if(key.startsWith('m:')){const ml=S.memberlogin.get(key.slice(2));return ml&&ml.pw}const v=S.pwvault.get(key);return v&&v.pw}
function loginTaken(key,exceptUid,exceptMid){return [...S.creds.values()].some(c=>c.id!==exceptUid&&c.loginKey===key)||[...S.memberlogin.values()].some(x=>x.id!==exceptMid&&x.loginKey===key)}
async function applyMemberSetup(u,mid){
  const m=S.members.get(mid),ml=S.memberlogin.get(mid);
  if(ml&&!S.creds.has(u)){
    const salt=b64e(crypto.getRandomValues(new Uint8Array(16))),iter=150000;
    try{const hash=await hashPw(ml.pw,salt,iter);const rec={loginId:ml.loginId,loginKey:ml.loginKey,salt,hash,iter,setAt:Date.now(),setBy:meKey()};
      put('creds',u,rec,{sys:true});put('pwvault',u,{pw:ml.pw,setAt:rec.setAt},{sys:true});del('memberlogin',mid,{sys:true});
      logH({act:'login',kind:'access',who:u,ch:['Login ID: '+ml.loginId,'Prepared for '+(m?m.name:'team member')]})}catch(e){}
  }
  const a=S.access.get(u);
  if(m&&m.accessDisabled&&a&&!a.disabled)put('access',u,{...clean(a),disabled:true},{sys:true});
}
function drMCred(d){
  const m=S.members.get(d.mid)||{name:'Team member'};const c=S.memberlogin.get(d.mid);
  return `<form id="f" novalidate>${dHead('Users &amp; access',`Login for ${h(m.name)}`)}
  <div class="dr-b">
    <div class="who-row">${av(d.mid,true)}<div style="min-width:0"><div class="me-n">${h(m.name)}</div><div class="me-r">${h(m.role||'Team member')} · not joined yet</div></div></div>
    <p class="hint" style="margin:0">Saving creates ${h(m.name)}’s account straight away, with the account type chosen for them. They sign in at this planner’s address with this login ID and password.</p>
    <div class="fld"><label for="c-id">Login ID</label><input type="text" id="c-id" value="${h(c?c.loginId:suggestId(m.name))}" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="32" autofocus></div>
    <span class="hint">3–32 characters: letters, digits, dots, dashes or underscores. Not case-sensitive.</span>
    <div class="fld"><label for="c-pw">Password</label><div class="codebox"><input type="text" id="c-pw" value="${h(c?c.pw:'')}" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64"><button type="button" class="btn" data-action="gen-pw">Generate</button></div></div>
    <span class="hint">At least 8 characters. Admins can see it later on this page. Give it to ${h(m.name)} privately.</span>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary">${c?'Save login':'Create login'}</button>${c?`<span class="spacer"></span><button type="button" class="btn danger" data-action="remove-mlogin" data-id="${d.mid}" data-two="Confirm remove">Remove login</button>`:'<button type="button" class="btn" data-action="close-drawer">Cancel</button>'}</div></form>`;
}
async function saveMemberCred(d){
  if(!canManage())return formErr('Only the owner, or an admin shared as Editor, can set logins.');
  const loginId=$('#c-id').value.trim(),pw=$('#c-pw').value,m=S.members.get(d.mid);
  if(!/^[A-Za-z0-9._-]{3,32}$/.test(loginId))return formErr('Login ID must be 3–32 letters, digits, dots, dashes or underscores.');
  const key=loginId.toLowerCase();
  if(loginTaken(key,null,d.mid))return formErr(`Login ID “${loginId}” is already used by someone else.`);
  if(pw.length<8)return formErr('The password needs at least 8 characters.');
  const had=S.memberlogin.has(d.mid);
  put('memberlogin',d.mid,{loginId,loginKey:key,pw,setAt:Date.now(),setBy:meKey()},{sys:true});
  logH({act:'edited',kind:'member',id:d.mid,title:m?m.name:'',ch:[(had?'Login updated':'Login prepared')+' · ID '+loginId]});
  closeDrawer();toast(had?'Login saved':`Login ready for ${m?m.name:'them'}`);
}

/* ---------- sign-in gate, access admin, history ---------- */
const MARK='<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="7" width="6" height="6" rx="1.2" fill="currentColor"/><path d="M12 6.5a5 5 0 0 1 0 7M14.6 4a8.6 8.6 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
function fmtTs(t){if(!t)return '';const d=new Date(t);const n=Math.round(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/DAY);return (n===TODAY?'Today':n===TODAY-1?'Yesterday':fmt(n))+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
function viewGate(gs){
  const who=`<div class="who-row">${uav(ME.id,true)}<div style="min-width:0"><div class="me-n">${h(pName(ME.id))}</div><div class="me-r">claude.ai account</div></div></div>`;
  let inner,eb='Sign in';
  if(gs==='signedout')inner=`<p>Sign in to your claude.ai account, then open this link again.</p>`;
  else if(gs==='pending')inner=`${who}<div class="rollup"><b>Request sent ${fmtTs(S.requests.get(ME.id).at)}.</b><br>An admin will approve it, choose your access level and give you a login ID and password. This page updates by itself.</div>`;
  else if(gs==='request'){eb='Request access';inner=`${who}<p>You don’t have access to this planner yet. Send a request and an admin will set up your login.</p>
    <form id="reqForm" class="gate-form" novalidate>
      <div class="fld"><label for="r-member">Which team member are you?</label><select id="r-member"><option value="">I’m not on the team list yet</option>${memberList().map(m=>`<option value="${m.id}">${h(m.name)}${m.role?' · '+h(m.role):''}</option>`).join('')}</select></div>
      <div class="fld"><label for="r-note">Note for the admin (optional)</label><input type="text" id="r-note" maxlength="140" placeholder="e.g. Joining the firmware team"></div>
      <button type="submit" class="btn primary">Request access</button>
    </form>`}
  else if(gs==='disabled')inner=`${who}<div class="rollup"><b>Your account is disabled.</b><br>An admin has switched off your access to this planner. Contact your R&amp;D manager to turn it back on.</div>`;
  else if(gs==='nologin')inner=`${who}<div class="rollup"><b>You’re approved with ${ROLE[role()].toLowerCase()} access.</b><br>Your admin still needs to create your login ID and password. This page updates by itself once they do.</div>`;
  else inner=`<form id="loginForm" class="gate-form" novalidate>
      <div class="fld"><label for="l-id">Login ID</label><input type="text" id="l-id" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32"></div>
      <div class="fld"><label for="l-pw">Password</label><div class="codebox"><input type="password" id="l-pw" autocomplete="current-password" maxlength="64"><button type="button" class="btn" id="l-show">Show</button></div></div>
      <label class="chk"><input type="checkbox" id="l-keep"> Keep me signed in on this device for 7 days</label>
      <div class="err" id="lErr" role="alert" hidden></div>
      <button type="submit" class="btn primary" id="lBtn">Sign in</button>
      ${isAdmin()?`<div class="rollup"><b>Forgot your password?</b> You’re an admin on this claude.ai account, so you can clear your login and set a new one.<div style="margin-top:8px"><button type="button" class="btn danger" data-action="admin-reset-own" data-two="Confirm: clear my login">Clear my login</button></div></div>`:'<p class="hint">Forgot your password? Ask an admin to set a new one.</p>'}
    </form>`;
  return `<section class="gate"><div class="gate-card"><div class="mark lg">${MARK}</div><div><div class="eyebrow">${eb}</div><h1>RFID R&amp;D Planner</h1></div>${inner}</div></section>`;
}
async function requestAccess(){
  if(!db||!ME.id)return;
  const data={memberId:$('#r-member').value,note:$('#r-note').value.trim().slice(0,140),at:Date.now()};
  S.requests.set(ME.id,{...data,id:ME.id});schedule();
  try{await db.collection('requests').doc(ME.id).set(data)}
  catch(e){S.requests.delete(ME.id);schedule();toast('Your sharing level can’t send requests. Ask the owner to add you from the Access page.')}
}
function viewAccess(){
  const reqs=[...S.requests.values()].sort((a,b)=>(a.at||0)-(b.at||0));
  const manage=canManage(),dis=manage?'':' disabled';
  const accs=[...S.access.values()];
  if(ME.id&&!S.access.has(ME.id))accs.push({id:ME.id,memberId:'',role:'admin',self:true});
  const linkedTo=a=>a.memberId&&S.members.has(a.memberId)?a.memberId:'';
  const byMember=new Map();for(const a of accs){const m=linkedTo(a);if(m){if(!byMember.has(m))byMember.set(m,[]);byMember.get(m).push(a)}}
  const unlinked=accs.filter(a=>!linkedTo(a));
  const memOpts=(sel,allowNew)=>`${allowNew?`<option value="_new" ${!sel?'selected':''}>Add as a new team member</option>`:''}<option value="">Not linked to a team member</option>${memberList().map(m=>`<option value="${m.id}" ${sel===m.id?'selected':''}>${h(m.name)}</option>`).join('')}`;
  const roleOpts=sel=>['admin','write','read'].map(r=>`<option value="${r}" ${sel===r?'selected':''}>${ROLE[r]}</option>`).join('');
  const isShareAdmin=u=>u===ME.id&&(ME.isOwner||ME.canEdit);
  const typeCell=a=>isShareAdmin(a.id)?`<span><span class="rtag adm">Admin</span> <span class="muted small">${ME.isOwner?'owner':'editor'}</span></span>`:`<select class="sel" id="ac-r-${a.id}" data-acc="role" data-uid="${a.id}" aria-label="Account type for ${h(pName(a.id))}"${dis}>${roleOpts(a.role)}</select>`;
  const acctCell=a=>`<div class="pn">${uav(a.id)}<div style="min-width:0"><b>${h(pName(a.id))}${a.id===ME.id?' (you)':''}</b>${a.grantedAt?`<div class="as">Approved ${fmtTs(a.grantedAt)}</div>`:''}</div></div>`;
  const actCell=a=>`<div class="actions"><button class="btn" data-action="set-login" data-id="${a.id}"${dis}>${S.creds.get(a.id)?'Edit login':'Set login'}</button>${isShareAdmin(a.id)?'':`<button class="btn danger" data-action="revoke" data-id="${a.id}" data-two="Confirm remove"${dis}>Remove</button>`}</div>`;
  const togCell=(u,mid,on,fixed)=>fixed?'<span class="muted small">Always on</span>':`<button type="button" class="tog ${on?'on':''}" role="switch" aria-checked="${on}" data-action="toggle-enabled" ${u?`data-uid="${u}"`:`data-mid="${mid}"`}${dis}><i></i>${on?'Enabled':'Disabled'}</button>`;
  const memCell=m=>`<div class="tm"><b>${h(m.name)}</b><div class="as">${h(m.role||'Team member')}${m.email?' · '+h(m.email):''}</div></div>`;
  const linkChoices=unlinked.filter(a=>!isShareAdmin(a.id)||true);
  const rows=memberList().map(m=>{const list=byMember.get(m.id)||[];
    if(!list.length)return `<div class="trow${m.accessDisabled?' off':''}">${memCell(m)}<div>${linkChoices.length?`<select class="sel" id="lk-${m.id}" data-link="${m.id}" aria-label="Link an account to ${h(m.name)}"${dis}><option value="">Not signed up · link an account…</option>${linkChoices.map(a=>`<option value="${a.id}">${h(pName(a.id))}${a.id===ME.id?' (you)':''}</option>`).join('')}</select>`:'<span class="muted small">Not signed up yet</span>'}</div><div><select class="sel" id="mt-${m.id}" data-mtype="${m.id}" aria-label="Account type for ${h(m.name)}"${dis}>${roleOpts(m.accessType||'write')}</select><div class="as">Applies when they join</div></div><div class="lg-l">${memberLoginLine(m.id)}</div>${togCell(null,m.id,!m.accessDisabled)}<div class="actions"><button class="btn" data-action="set-mlogin" data-id="${m.id}"${dis}>${S.memberlogin.has(m.id)?'Edit login':'Set login'}</button></div></div>`;
    return list.map(a=>`<div class="trow${a.disabled?' off':''}">${memCell(m)}${acctCell(a)}${typeCell(a)}<div class="lg-l">${loginLine(a.id)}</div>${togCell(a.id,null,!a.disabled,isShareAdmin(a.id))}${actCell(a)}</div>`).join('')}).join('');
  const other=unlinked.map(a=>`<div class="trow${a.disabled?' off':''}"><div><select class="sel" id="ac-m-${a.id}" data-acc="memberId" data-uid="${a.id}" aria-label="Team member for ${h(pName(a.id))}"${dis}>${memOpts('')}</select></div>${acctCell(a)}${typeCell(a)}<div class="lg-l">${loginLine(a.id)}</div>${togCell(a.id,null,!a.disabled,isShareAdmin(a.id))}${actCell(a)}</div>`).join('');
  return `<div class="phead"><div><div class="eyebrow">Settings</div><h1 class="ptitle">Users &amp; access</h1></div></div>
  ${manage?'':`<div class="banner bad">You’re an Admin in this planner, but the owner also needs to share the page with you as <b>Editor</b> (Share menu) before you can approve people, change account types or see passwords.</div>`}
  <section class="panel"><h2>Account types</h2>
    <div class="roles">
      <div><span class="rtag adm">Admin</span><p>Everything, including this page: approves people, sets account types, logins and passwords.</p></div>
      <div><span class="rtag">Read &amp; write</span><p>Adds and edits projects, tasks and team members. Every change is signed with their name in History.</p></div>
      <div><span class="rtag read">Read only</span><p>Sees every project, timeline and the history. All edit controls are hidden. The server refuses any change they try to save.</p></div>
    </div>
    <p class="hint" style="margin:0">Every team member can have an account. Pick their account type, then press <b>Set login</b> on their row to create their login ID and password. Use the switch to disable an account at once.</p>
  </section>
  <section class="panel sa-hide"><div class="panel-h"><h2>Waiting for approval</h2><span class="muted small">${reqs.length}</span></div>
    <div>${reqs.map(r=>`<div class="arow"><div class="pn">${uav(r.id)}<div style="min-width:0"><b>${h(pName(r.id))}</b><div class="as">Asked ${fmtTs(r.at)}${r.note?' · “'+h(r.note)+'”':''}</div></div></div>
      <select class="sel" id="rq-m-${r.id}" aria-label="Team member"${dis}>${memOpts(r.memberId,true)}</select>
      <select class="sel" id="rq-r-${r.id}" aria-label="Account type"${dis}>${roleOpts((S.members.get(r.memberId)||{}).accessType||'write')}</select>
      <div class="actions"><button class="btn primary" data-action="approve" data-id="${r.id}"${dis}>Approve</button><button class="btn danger" data-action="decline" data-id="${r.id}" data-two="Confirm"${dis}>Decline</button></div></div>`).join('')||'<div class="empty-note">No requests right now.</div>'}</div>
  </section>
  <section class="panel"><div class="panel-h"><h2>Team accounts</h2>${manage?`<button type="button" class="btn" data-action="pw-all">${ui.pwShown.size?'Hide passwords':'Show all passwords'}</button>`:''}</div>
    <div class="ttable">
      <div class="trow th"><span>Team member</span><span>User account</span><span>Account type</span><span>Login</span><span>Status</span><span></span></div>
      ${rows||'<div class="empty-note">No team members yet. Add them on the Team page, or approve a request as a new team member.</div>'}
      ${other?`<div class="tsub">Accounts not linked to a team member</div>${other}`:''}
    </div>
    ${manage?`<div class="fld sa-hide" style="margin-top:6px"><label for="pSearch">Add someone from your organization</label><input type="search" id="pSearch" placeholder="Search by name" autocomplete="off"></div><div id="pResults" class="sres"></div>`:''}
  </section>`;
}
function wireAccess(){
  const s=$('#pSearch');if(!s||!U)return;
  const run=async()=>{const res=await U.search(s.value.trim());const box=$('#pResults');if(!box)return;
    const rows=res.filter(p=>p.id&&!S.access.has(p.id)&&p.id!==ME.id);
    rows.forEach(p=>{PF[p.id]={name:p.name,avatarUrl:p.avatarUrl}});
    box.innerHTML=rows.map(p=>`<div class="arow"><div class="pn">${uav(p.id)}<div style="min-width:0"><b>${h(p.name)}</b>${p.guest?'<div class="as">Outside your organization</div>':''}</div></div><span></span><span></span><div class="actions"><button class="btn primary" data-action="grant" data-id="${p.id}" data-role="write">Add · Read &amp; write</button><button class="btn" data-action="grant" data-id="${p.id}" data-role="read">Add · Read only</button></div></div>`).join('')||(s.value.trim()?'<div class="empty-note">No one found. People must be in your organization, or invited to this page by the owner.</div>':'')};
  s.addEventListener('input',run);s.addEventListener('focus',run);
}
async function grant(uid,r,memberId){
  if(!isAdmin())return;
  await put('access',uid,{role:r,memberId:memberId||'',grantedBy:meKey(),grantedAt:Date.now()},{sys:true});
  if(S.requests.has(uid))await del('requests',uid,{sys:true});
  logH({act:'granted',kind:'access',who:uid,ch:[ROLE[r]+(memberId?' · '+mName(memberId):'')]});
  toast(`${pName(uid)} now has ${ROLE[r].toLowerCase()} access`);
}
async function updateAccess(uid,field,val){
  if(!isAdmin())return;const a=S.access.get(uid)||{role:'write',grantedAt:Date.now(),grantedBy:meKey()};
  const before=a[field];
  await put('access',uid,{...clean(a),[field]:val},{sys:true});
  if(field==='role'&&val==='admin'&&uid!==ME.id){logH({act:'changed',kind:'access',who:uid,ch:[`${ROLE[before]||'—'} → ${ROLE[val]}`]});toast(`${pName(uid)} is now an Admin`);return}
  logH({act:'changed',kind:'access',who:uid,ch:[field==='role'?`${ROLE[before]||'—'} → ${ROLE[val]}`:`Linked to ${val?mName(val):'no team member'}`]});
  toast('Access updated');
}
function allHist(){const out=[];for(const [k,d] of S.history)for(const e of (d.entries||[]))out.push({...e,by:k});return out.sort((a,b)=>b.t-a.t)}
const HV={created:'added',edited:'edited',deleted:'deleted',moved:'rescheduled',followup:'logged a follow-up on'};
function hSentence(e){
  const live=e.kind==='task'&&S.tasks.has(e.id);
  const T=e.title?(live?`<button class="hlink" data-action="edit-task" data-id="${e.id}">${h(e.title)}</button>`:`<b>${h(e.title)}</b>`):'';
  const code=e.code?` <span class="mono muted">${h(e.code)}</span>`:'';
  switch(e.kind){
    case 'task':return `${HV[e.act]||e.act} task ${T}${code}`;
    case 'project':return `${HV[e.act]||e.act} project ${T}${code}`;
    case 'member':return `${HV[e.act]||e.act} team member ${T}`;
    case 'access':{const w=`<b>${h(pName(e.who))}</b>`;return e.act==='granted'?`gave ${w} access`:e.act==='revoked'?`removed access for ${w}`:e.act==='declined'?`declined the request from ${w}`:e.act==='disabled'?`disabled the account of ${w}`:e.act==='enabled'?`enabled the account of ${w}`:e.act==='login'?`created a login for ${w}`:e.act==='reset'?`set a new password for ${w}`:e.act==='unlogin'?`removed the login for ${w}`:`changed access for ${w}`}
    default:return `${h(e.title||'')}${code}`;
  }
}
function hItem(e,compact){return `<div class="hitem">${uav(e.by)}<div style="min-width:0"><div class="ht"><b>${h(pName(e.by))}</b> ${hSentence(e)}</div>${(e.ch&&e.ch.length)?`<div class="hc">${e.ch.slice(0,compact?6:12).map(c=>`<span>${h(c)}</span>`).join('')}${e.ch.length>(compact?6:12)?`<span>+${e.ch.length-(compact?6:12)} more</span>`:''}</div>`:''}</div><span class="htime">${compact?fmtTs(e.t):new Date(e.t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div>`}
function viewHistory(){
  let L=allHist();const people=[...S.history.keys()].filter(k=>(S.history.get(k).entries||[]).length);
  if(ui.hPerson)L=L.filter(e=>e.by===ui.hPerson);
  if(ui.hProject)L=L.filter(e=>e.pid===ui.hProject||(e.kind==='project'&&e.id===ui.hProject));
  if(ui.hKind)L=L.filter(e=>ui.hKind==='other'?!['task','project'].includes(e.kind):e.kind===ui.hKind);
  const total=L.length;L=L.slice(0,250);
  let html='',last='';
  for(const e of L){const d=new Date(e.t);const n=Math.round(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/DAY);const lab=n===TODAY?'Today':n===TODAY-1?'Yesterday':`${WD[dow(n)]} ${fmtY(n)}`;
    if(lab!==last){html+=`<div class="hday">${lab}</div>`;last=lab}html+=hItem(e)}
  return `<div class="phead"><div><div class="eyebrow">${total} change${total===1?'':'s'}</div><h1 class="ptitle">History</h1></div></div>
  <div class="toolbar">
    <select class="sel" id="hPerson" data-change="hPerson" aria-label="Filter by person"><option value="">Everyone</option>${people.map(k=>`<option value="${h(k)}" ${ui.hPerson===k?'selected':''}>${h(pName(k))}</option>`).join('')}</select>
    <select class="sel" id="hProject" data-change="hProject" aria-label="Filter by project"><option value="">All projects</option>${projList().map(p=>`<option value="${p.id}" ${ui.hProject===p.id?'selected':''}>${h(p.code||'')} ${h(p.name)}</option>`).join('')}</select>
    <select class="sel" id="hKind" data-change="hKind" aria-label="Filter by type"><option value="">All changes</option><option value="task" ${ui.hKind==='task'?'selected':''}>Tasks</option><option value="project" ${ui.hKind==='project'?'selected':''}>Projects</option><option value="member" ${ui.hKind==='member'?'selected':''}>Team</option><option value="other" ${ui.hKind==='other'?'selected':''}>Access &amp; bulk changes</option></select>
  </div>
  <section class="panel">${html||'<div class="empty-note">No changes recorded yet. Every task, project and team edit will appear here with who made it and when.</div>'}</section>`;
}
/* change summaries for the history log */
function dLab(s){return s?fmt(d2n(s)):''}
function diffFields(rows){const ch=[];for(const [l,a,b] of rows)if(String(a??'')!==String(b??''))ch.push(`${l}: ${a===''||a==null?'—':a} → ${b===''||b==null?'—':b}`);return ch}
function depNames(m,ids){return (ids||[]).map(x=>m.info.get(x)?m.info.get(x).wbs:null).filter(Boolean).sort().join(', ')}
function diffTask(a,b,m){
  const ch=diffFields([['Name',a.title,b.title],['Owner',a.assignee?mName(a.assignee):'',b.assignee?mName(b.assignee):''],['Start',dLab(a.start),dLab(b.start)],['End',dLab(a.end),dLab(b.end)],['Progress',(+a.progress||0)+'%',(+b.progress||0)+'%'],['Status',STATUS[a.status]||'',STATUS[b.status]||''],['Priority',PRIO[a.priority||'normal'],PRIO[b.priority||'normal']],['Waits on',depNames(m,a.deps),depNames(m,b.deps)]]);
  const fd=x=>x.fu===''||x.fu==null?'Project default':fuLabel(x.fu),ld=x=>x.fuLead===''||x.fuLead==null?'Project default':leadLabel(x.fuLead);
  const dd=x=>x.fuDl===''||x.fuDl==null?'Project default':fuLabel(x.fuDl);
  if(fd(a)!==fd(b))ch.push(`How often to ask: ${fd(a)} → ${fd(b)}`);if(ld(a)!==ld(b))ch.push(`Deadline mode: ${ld(a)} → ${ld(b)}`);if(dd(a)!==dd(b))ch.push(`Deadline frequency: ${dd(a)} → ${dd(b)}`);
  const ef=x=>+x.effort>0?`${x.effort} ${x.effortUnit==='d'?'days':'h'}`:'';
  ch.push(...diffFields([['Skill',a.skill?skillName(a.skill):'',b.skill?skillName(b.skill):''],['Effort',ef(a),ef(b)],['Effort spread',a.spread&&a.spread!=='even'?(SPREAD.find(x=>x[0]===a.spread)||['',''])[1]:'Even',b.spread&&b.spread!=='even'?(SPREAD.find(x=>x[0]===b.spread)||['',''])[1]:'Even']]));if(!a.outsideSkill&&b.outsideSkill)ch.push('Assigned outside skill');
  if((a.notes||'')!==(b.notes||''))ch.push('Notes updated');return ch}
function diffProject(a,b){return diffFields([['Name',a.name,b.name],['Code',a.code,b.code],['Lead',a.owner?mName(a.owner):'',b.owner?mName(b.owner):''],['Status',PSTATUS[a.status]||'',PSTATUS[b.status]||''],['Start',dLab(a.start),dLab(b.start)],['Target',dLab(a.target),dLab(b.target)]]).concat((a.description||'')!==(b.description||'')?['Description updated']:[])}

function taskHist(t){
  const hs=allHist().filter(e=>e.kind==='task'&&e.id===t.id).slice(0,8);
  const meta=[t.createdBy?`Added by ${h(pName(t.createdBy))} · ${fmtTs(t.createdAt)}`:'',t.updatedBy&&t.updatedAt!==t.createdAt?`Last edited by ${h(pName(t.updatedBy))} · ${fmtTs(t.updatedAt)}`:''].filter(Boolean).join('<br>');
  return `<div class="fld"><span class="lab">History</span>${meta?`<div class="hint">${meta}</div>`:''}<div>${hs.map(e=>hItem(e,true)).join('')||'<div class="hint">No recorded changes yet.</div>'}</div></div>`;
}

/* ---------- Gantt export (PDF / PNG), drawn on canvas in print colours ---------- */
const XC={m:['#2747C9','#0E8A7A','#C2410C','#8B3FC7','#B7791F','#C2185B','#2E7D32','#4A6177'],none:'#8A96A3',ink:'#152030',ink2:'#47576A',ink3:'#7A8897',line:'#CBD3DC',line2:'#E6EAEF',head:'#F2F4F7',we:'#F3F5F8',par:'#F7F8FA',today:'#D9480F',bad:'#C8323C',accent:'#2747C9'};
const xHex=id=>{const m=S.members.get(id);return m?XC.m[(m.hue||0)%8]:XC.none};
function xMix(hex,a){const n=parseInt(hex.slice(1),16),r=n>>16,g=n>>8&255,b=n&255,f=c=>Math.round(c*a+255*(1-a));return `rgb(${f(r)},${f(g)},${f(b)})`}
const XF=(w,s)=>`${w} ${s}px "IBM Plex Sans", Arial, sans-serif`, XM=s=>`${s}px "IBM Plex Mono", Menlo, monospace`;
function xFit(c,t,w){t=String(t||'');if(c.measureText(t).width<=w)return t;while(t.length&&c.measureText(t+'…').width>w)t=t.slice(0,-1);return t+'…'}
function xRR(c,x,y,w,h,r){c.beginPath();if(c.roundRect)c.roundRect(x,y,w,h,r);else c.rect(x,y,w,h)}
function ganttLayout(pid,scope){
  const p=S.projects.get(pid),m=model(pid);
  const rows=scope==='view'?visibleRows(m):m.flat.slice();
  const tgt=d2n(p.target);
  let s0=isFinite(m.s)?m.s:TODAY,e0=isFinite(m.e)?m.e:TODAY+28;if(tgt)e0=Math.max(e0,tgt);
  for(const id of m.flat){const R=m.info.get(id);if(R.ps!=null){s0=Math.min(s0,R.ps);e0=Math.max(e0,R.pe)}}
  s0=monday(s0);e0=monday(e0)+13;
  const days=e0-s0+1,C=[['WBS',44],['Task',290],['Owner',116],['Skill',104],['Start',58],['End',58],['Days',40],['Effort',56],['%',56],['Status',74],['Follow-up',118]];
  const T=C.reduce((a,c)=>a+c[1],0),dw=Math.max(5,Math.min(26,Math.round(1500/days*10)/10)),PAD=28;
  const W=Math.round(PAD*2+T+days*dw),RH=26,HEAD=152,SCALE=40,FOOT=34;
  const pageH=Math.round(W/Math.SQRT2),perPage=Math.max(6,Math.floor((pageH-HEAD-SCALE-FOOT-10)/RH));
  return {p,m,rows,tgt,s0,e0,days,C,T,dw,PAD,W,RH,HEAD,SCALE,FOOT,pageH,perPage};
}
function ganttPages(L){const out=[];for(let i=0;i<L.rows.length;i+=L.perPage)out.push(L.rows.slice(i,i+L.perPage));return out.length?out:[[]]}
function drawGanttPage(L,ids,o){
  const {p,m,PAD,W,RH,HEAD,SCALE,FOOT,T,dw,s0,e0,tgt}=L;
  const H=o.height||Math.round(HEAD+SCALE+ids.length*RH+FOOT+10),sc=o.scale||2;
  const cv=document.createElement('canvas');cv.width=Math.round(W*sc);cv.height=Math.round(H*sc);
  const c=cv.getContext('2d');c.scale(sc,sc);c.textBaseline='middle';
  c.fillStyle='#FFFFFF';c.fillRect(0,0,W,H);
  // title block
  const fuK=k=>m.leaves.filter(id=>(m.info.get(id).fu||{}).kind===k).length;
  const upsP=[...S.updates.values()].filter(u=>u.pid===p.id);
  const ovOwners=new Set(m.leaves.map(id=>m.info.get(id)).filter(I=>ownerOver(I)).map(I=>I.t.assignee)).size;
  c.fillStyle=XC.accent;c.fillRect(0,0,6,H);
  c.fillStyle=XC.ink3;c.font=XF(600,11);
  c.fillText([p.code||'','GANTT CHART',projRank(p)<99?'P'+projRank(p)+' PRIORITY':'',(PSTATUS[p.status]||'Planning').toUpperCase()].filter(Boolean).join('   ·   '),PAD,24);
  c.textAlign='right';c.fillText(`Exported ${fmtY(TODAY)} by ${pName(meKey())}`,W-PAD-74,24);c.textAlign='left';
  c.fillStyle=XC.ink;c.font=XF(700,24);c.fillText(xFit(c,p.name,W-PAD*2-90),PAD,52);
  const slip=tgt&&isFinite(m.e)&&m.e>tgt?m.e-tgt:0;
  const sub=[isFinite(m.s)?`Drafted Timeline Detected range: ${fmtY(m.s)} → ${fmtY(m.e)}`:'',tgt?`Target ${fmtY(tgt)}`:'',p.owner?`Lead: ${mName(p.owner)}`:'',slip?`Forecast ${slip} days past target`:(tgt&&isFinite(m.e)?'On track for target':'')].filter(Boolean).join('    ·    ');
  c.fillStyle=slip?XC.bad:XC.ink2;c.font=XF(400,12);c.fillText(sub,PAD,76);
  // progress ring
  {const rx=W-PAD-32,ry=50,rr=26;c.lineWidth=7;c.strokeStyle=XC.line2;c.beginPath();c.arc(rx,ry,rr,0,Math.PI*2);c.stroke();
   c.strokeStyle=m.prog>=100?'#2E8B57':XC.accent;c.lineCap='round';c.beginPath();c.arc(rx,ry,rr,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(0.001,m.prog/100));c.stroke();c.lineCap='butt';
   c.fillStyle=XC.ink;c.font=XF(700,14);c.textAlign='center';c.fillText(m.prog+'%',rx,ry+1);c.font=XF(600,8);c.fillStyle=XC.ink3;c.fillText('DONE',rx,ry+40);c.textAlign='left'}
  // KPI pills
  {const kp=[[`${m.done}/${m.leaves.length}`,'tasks done',XC.ink],[m.over,'overdue',m.over?XC.bad:XC.ink],[m.conflicts.length,'link conflicts',m.conflicts.length?XC.bad:XC.ink],[fuK('missed'),'follow-ups missed',fuK('missed')?XC.bad:XC.ink],[fuK('due'),'updates due',fuK('due')?'#B7791F':XC.ink],[upsP.length,'updates logged',XC.ink],[ovOwners,'owners overloaded',ovOwners?'#B7791F':XC.ink],[m.series+' / '+m.parallel,'series / parallel',XC.ink]];
   let kx=PAD;const ky=102;
   for(const [v,l,col] of kp){c.font=XF(700,14);const vw=c.measureText(String(v)).width;c.font=XF(400,10.5);const lw=c.measureText(l).width;const bw=vw+lw+28;if(kx+bw>W-PAD)break;
     c.fillStyle=XC.head;xRR(c,kx,ky-12,bw,24,12);c.fill();c.fillStyle=col;c.font=XF(700,14);c.fillText(String(v),kx+11,ky+1);c.fillStyle=XC.ink2;c.font=XF(400,10.5);c.fillText(l,kx+17+vw,ky+1);kx+=bw+8}}
  // legend
  let x=PAD;const ly=134;c.font=XF(400,11);
  const owners=[...new Set(L.rows.map(id=>m.info.get(id)).filter(I=>I.leaf).map(I=>I.t.assignee||''))];
  for(const a of owners){c.fillStyle=xMix(xHex(a),.3);xRR(c,x,ly-5,14,10,2);c.fill();c.strokeStyle=xHex(a);c.lineWidth=1;c.stroke();c.fillStyle=XC.ink2;const nm=a&&S.members.has(a)?mName(a):'Unassigned';c.fillText(nm,x+19,ly);x+=19+c.measureText(nm).width+16}
  const leg=(draw,label)=>{if(x+40+c.measureText(label).width>W-PAD)return;draw(x);c.fillStyle=XC.ink2;c.font=XF(400,11);c.fillText(label,x+26,ly);x+=26+c.measureText(label).width+16};
  leg(x0=>{c.strokeStyle=XC.ink3;c.lineWidth=1.3;c.beginPath();c.moveTo(x0,ly);c.lineTo(x0+16,ly);c.stroke();c.fillStyle=XC.ink3;c.beginPath();c.moveTo(x0+20,ly);c.lineTo(x0+14,ly-4);c.lineTo(x0+14,ly+4);c.fill()},'Waits on');
  leg(x0=>{c.fillStyle=XC.today;c.fillRect(x0+8,ly-7,2,14)},'Today');
  if(tgt)leg(x0=>{c.strokeStyle=XC.ink3;c.setLineDash([3,3]);c.beginPath();c.moveTo(x0+9,ly-7);c.lineTo(x0+9,ly+7);c.stroke();c.setLineDash([])},'Target');
  leg(x0=>{c.fillStyle=XC.ink2;c.fillRect(x0,ly-2,20,5)},'Summary');
  leg(x0=>{c.fillStyle=xMix(XC.accent,.3);c.fillRect(x0,ly-6,20,8);c.fillStyle=XC.accent;c.fillRect(x0,ly+4,14,2.5)},'Parent bar · its subtasks’ span');
  leg(x0=>{c.fillStyle=XC.accent;c.beginPath();c.arc(x0+10,ly,3,0,7);c.fill()},'Update logged');
  leg(x0=>{c.fillStyle='#C8323C';c.beginPath();c.moveTo(x0+5,ly+3);c.lineTo(x0+1,ly-4);c.lineTo(x0+9,ly-4);c.closePath();c.fill();xRR(c,x0+11,ly-3,10,5,2.5);c.fill()},'Event timeline');
  leg(x0=>{const cx=x0+10;c.fillStyle='#B7791F';c.beginPath();c.moveTo(cx,ly-4.5);c.lineTo(cx+4.5,ly);c.lineTo(cx,ly+4.5);c.lineTo(cx-4.5,ly);c.closePath();c.fill()},'Next follow-up');
  leg(x0=>{c.strokeStyle='#B7791F';c.lineWidth=2.2;c.setLineDash([4,3]);c.beginPath();c.moveTo(x0,ly);c.lineTo(x0+20,ly);c.stroke();c.setLineDash([])},'Deadline mode');
  for(const [ch,col,lab] of [['!',XC.bad,'Link conflict'],['%','#B7791F','Owner overloaded'],['S','#B7791F','Outside skill']])leg(x0=>{c.fillStyle=col;c.beginPath();c.arc(x0+10,ly,6,0,7);c.fill();c.fillStyle='#fff';c.font=XF(700,8.5);c.textAlign='center';c.fillText(ch,x0+10,ly+.5);c.textAlign='left';c.font=XF(400,11)},lab);
  // header band
  const y0=HEAD,gx=PAD+T,by=y0+SCALE,bodyH=ids.length*RH;
  c.fillStyle=XC.head;c.fillRect(PAD,y0,W-PAD*2,SCALE);
  c.fillStyle=XC.ink3;c.font=XF(600,10.5);let cx=PAD;
  for(const [lab,w] of L.C){c.fillText(lab.toUpperCase(),cx+6,y0+SCALE-12);cx+=w}
  const X=n=>gx+(n-s0)*dw;
  // months + weeks
  c.save();c.beginPath();c.rect(gx,y0,W-PAD-gx,SCALE+bodyH);c.clip();
  for(let n=s0;n<=e0;n++){if(isWE(n)){c.fillStyle=XC.we;c.fillRect(X(n),by,dw,bodyH)}}
  let mStart=s0;
  for(let n=s0;n<=e0+1;n++){const d=new Date(n*DAY);if(n===e0+1||(d.getUTCDate()===1&&n!==s0)){const md=new Date(mStart*DAY);c.fillStyle=XC.ink;c.font=XF(600,11);const lab=MON[md.getUTCMonth()]+' '+md.getUTCFullYear();const w=X(n)-X(mStart);if(w>30)c.fillText(xFit(c,lab,w-8),X(mStart)+5,y0+11);c.strokeStyle=XC.line;c.lineWidth=1;c.beginPath();c.moveTo(X(n)+.5,y0);c.lineTo(X(n)+.5,y0+20);c.stroke();mStart=n}}
  c.font=XM(10);
  for(let n=s0;n<=e0;n+=7){c.strokeStyle=XC.line2;c.lineWidth=1;c.beginPath();c.moveTo(X(n)+.5,y0+20);c.lineTo(X(n)+.5,by+bodyH);c.stroke();
    c.fillStyle=XC.ink2;const lab=dw*7>=62?`W${isoWeek(n)} ${new Date(n*DAY).getUTCDate()}`:dw*7>=28?`W${isoWeek(n)}`:'';if(lab)c.fillText(lab,X(n)+4,y0+30)}
  c.restore();
  c.strokeStyle=XC.line;c.lineWidth=1;c.beginPath();c.moveTo(PAD,y0+20.5);c.lineTo(PAD,y0+20.5);c.moveTo(gx,y0+20.5);c.lineTo(W-PAD,y0+20.5);c.stroke();
  // rows
  const idx=new Map(ids.map((id,i)=>[id,i]));
  ids.forEach((id,i)=>{const I=m.info.get(id),y=by+i*RH,mid=y+RH/2;
    if(I.par){c.fillStyle=XC.par;c.fillRect(PAD,y,T,RH)}
    c.strokeStyle=XC.line2;c.lineWidth=1;c.beginPath();c.moveTo(PAD,y+RH-.5);c.lineTo(W-PAD,y+RH-.5);c.stroke();
    const cols=L.C.map(cc=>cc[1]),cellX=[];{let cx0=PAD;for(const w of cols){cellX.push(cx0);cx0+=w}}
    c.fillStyle=XC.ink3;c.font=XM(10.5);c.fillText(I.wbs,cellX[0]+6,mid);
    const fl=[];if(I.outside)fl.push(['⇥',XC.bad]);if(I.conflict)fl.push(['!',XC.bad]);if(ownerOver(I))fl.push(['%','#B7791F']);if(I.leaf&&I.t.outsideSkill)fl.push(['S','#B7791F']);
    const ind=I.depth*12;c.fillStyle=I.over?XC.bad:XC.ink;c.font=XF(I.par?600:400,12);const tt=xFit(c,I.t.title,cols[1]-14-ind-fl.length*15);c.fillText(tt,cellX[1]+6+ind,mid);
    {let fx=cellX[1]+8+ind+c.measureText(tt).width;for(const [ch,col] of fl){c.fillStyle=col;c.beginPath();c.arc(fx+6,mid,6,0,7);c.fill();c.fillStyle='#fff';c.font=XF(700,8.5);c.textAlign='center';c.fillText(ch,fx+6,mid+.5);c.textAlign='left';fx+=15}}
    if(I.leaf){if(I.t.assignee&&S.members.has(I.t.assignee)){c.fillStyle=xHex(I.t.assignee);c.beginPath();c.arc(cellX[2]+10,mid,4,0,7);c.fill()}c.fillStyle=XC.ink2;c.font=XF(400,11.5);c.fillText(xFit(c,mName(I.t.assignee),cols[2]-24),cellX[2]+19,mid);
      c.font=XF(400,11);c.fillStyle=I.t.skill?XC.ink2:XC.ink3;c.fillText(xFit(c,I.t.skill?skillName(I.t.skill):'—',cols[3]-10),cellX[3]+6,mid)}
    c.font=XM(10.5);c.fillStyle=XC.ink2;c.fillText(fmt(I.s),cellX[4]+6,mid);c.fillStyle=I.over?XC.bad:XC.ink2;c.fillText(fmt(I.e),cellX[5]+6,mid);c.fillStyle=XC.ink2;c.fillText(String(I.dur),cellX[6]+6,mid);
    {let et='';if(I.leaf)et=+I.t.effort>0?`${fh(I.t.effort)} ${I.t.effortUnit==='d'?'d':'h'}`:'—';else{let hs=0;for(const k of m.leaves){const K=m.info.get(k);if(K.anc.includes(I.t.id)){const hh=taskHours(K.t,S.members.get(K.t.assignee));if(hh)hs+=hh}}et=hs?fh(hs)+' h':''}
     c.fillStyle=et==='—'?XC.ink3:XC.ink2;c.fillText(et,cellX[7]+6,mid)}
    {const bw2=cols[8]-16;c.fillStyle=XC.line2;c.fillRect(cellX[8]+6,mid+5,bw2,3);c.fillStyle=I.status==='done'?'#2E8B57':XC.accent;c.fillRect(cellX[8]+6,mid+5,bw2*I.prog/100,3);c.fillStyle=XC.ink2;c.font=XM(10);c.fillText(I.prog+'%',cellX[8]+6,mid-3)}
    if(I.leaf&&I.fu){const f=I.fu,map={missed:[`Missed ${f.late}d`,XC.bad,'#FFFFFF'],due:['Update due','#B7791F','#FFFFFF'],ok:[`Next ${fmt(f.next)}`,'#E3F1E8','#256B43'],scheduled:[`From ${fmt(f.next)}`,'#EEF1F4','#47576A'],off:['No follow-ups','#F3F5F7','#7A8897'],done:['Completed','#E3F1E8','#256B43']};
      const [txt,bg,fg]=map[f.kind]||map.off;const lab=txt+(f.mode==='deadline'&&!['done','off'].includes(f.kind)?' · DL':'');c.font=XF(600,9.5);
      const tw=Math.min(cols[10]-12,c.measureText(lab).width+14);c.fillStyle=bg;xRR(c,cellX[10]+6,mid-8,tw,16,8);c.fill();c.fillStyle=fg;c.fillText(xFit(c,lab,tw-12),cellX[10]+13,mid+.5)}
    {const lateS=I.over&&I.status!=='done',SC={todo:['#EEF1F4','#47576A'],active:['#E1E7FB','#2747C9'],blocked:['#C8323C','#FFFFFF'],done:['#E3F1E8','#256B43'],late:['#FBE3E4','#C8323C']}[lateS?'late':I.status];c.font=XF(600,9.5);const lab2=lateS?'Overdue':SHORTST[I.status];const tw2=Math.min(cols[9]-12,c.measureText(lab2).width+14);c.fillStyle=SC[0];xRR(c,cellX[9]+6,mid-8,tw2,16,8);c.fill();c.fillStyle=SC[1];c.fillText(lab2,cellX[9]+13,mid+.5)}
    // bar
    const PL=!I.leaf&&I.ps!=null,bx=X(PL?I.ps:I.s),bw=Math.max(((PL?I.pe:I.e)-(PL?I.ps:I.s)+1)*dw-1,3);
    if(I.leaf){const col=xHex(I.t.assignee);c.globalAlpha=I.status==='done'?.6:1;
      c.fillStyle=xMix(col,.22);xRR(c,bx,y+6,bw,RH-12,3);c.fill();
      if(I.prog){c.save();xRR(c,bx,y+6,bw,RH-12,3);c.clip();c.fillStyle=xMix(col,.62);c.fillRect(bx,y+6,bw*I.prog/100,RH-12);c.restore()}
      if(I.status==='blocked'){c.save();xRR(c,bx,y+6,bw,RH-12,3);c.clip();c.strokeStyle='rgba(200,50,60,.55)';c.lineWidth=2;for(let k=-RH;k<bw;k+=7){c.beginPath();c.moveTo(bx+k,y+RH-6);c.lineTo(bx+k+RH-12,y+6);c.stroke()}c.restore()}
      c.strokeStyle=I.conflict||I.status==='blocked'?XC.bad:col;c.lineWidth=I.conflict||I.status==='blocked'?1.8:1;if(I.status==='todo'&&!I.prog)c.setLineDash([4,2]);xRR(c,bx,y+6,bw,RH-12,3);c.stroke();c.setLineDash([]);
      if(I.status==='done'&&bw>14){c.fillStyle='#256B43';c.font=XF(700,11);c.textAlign='right';c.fillText('✓',bx+bw-4,mid+.5);c.textAlign='left'}
      if(I.over){c.fillStyle=XC.bad;c.fillRect(bx+bw-3,y+6,3,RH-12)}
      c.globalAlpha=1;
      if(bw>34){c.fillStyle=XC.ink;c.font=XF(500,10);c.fillText(I.prog+'%',bx+5,mid)}
      if(I.fu&&I.fu.dlStart!=null&&I.fu.kind!=='done'){const z0=Math.max(I.fu.dlStart,s0);if(z0<=I.e){c.strokeStyle='#B7791F';c.lineWidth=2.2;c.setLineDash([4,3]);c.beginPath();c.moveTo(X(z0),y+3);c.lineTo(X(I.e+1)-1,y+3);c.stroke();c.setLineDash([])}}
      if(I.par&&I.rs!=null){const sx=X(I.rs),sw=Math.max((I.re-I.rs+1)*dw-1,3);c.fillStyle=XC.accent;c.fillRect(sx,y+RH-6.5,sw,2.5);c.fillStyle=XC.bad;if(I.late){const a=X(Math.max(I.e+1,I.rs));c.fillRect(a,y+RH-6.5,X(I.re+1)-1-a,2.5)}if(I.early){const b2=X(Math.min(I.s,I.re+1));c.fillRect(sx,y+RH-6.5,b2-sx,2.5)}}
      for(const u of upsFor(id)){const col2=EVHEX[evKey(u.event)],r=evRange(u);
        if(r){if(r.b<s0||r.a>e0)continue;c.fillStyle=col2;if(r.b>r.a){xRR(c,X(r.a)+1,y+2,Math.max((r.b-r.a+1)*dw-2,4),5,2.5);c.fill()}else{const px=X(r.a)+dw/2;c.beginPath();c.moveTo(px,y+9);c.lineTo(px-4.5,y+2);c.lineTo(px+4.5,y+2);c.closePath();c.fill()}continue}
        const n=dayOf(u.t);if(n<s0||n>e0)continue;c.fillStyle=col2;c.beginPath();c.arc(X(n)+dw/2,y+RH-3.5,2.6,0,7);c.fill()}
      const f=I.fu;if(f&&['due','missed','ok','scheduled'].includes(f.kind)&&f.next>=s0&&f.next<=e0){const cx=X(f.next)+dw/2,cy=y+RH-4.5,col=f.kind==='missed'?XC.bad:f.kind==='due'?'#B7791F':null;
        c.fillStyle=col||'#FFFFFF';c.strokeStyle=col||XC.ink3;c.lineWidth=1.2;c.beginPath();c.moveTo(cx,cy-4);c.lineTo(cx+4,cy);c.lineTo(cx,cy+4);c.lineTo(cx-4,cy);c.closePath();c.fill();c.stroke()}}
    else if(PL){c.fillStyle='#FFFFFF';c.fillRect(bx,y+6,bw,9);c.fillStyle=xMix(XC.accent,.45);c.fillRect(bx,y+6,bw*I.prog/100,9);c.strokeStyle=I.outside?XC.bad:XC.ink2;c.lineWidth=1.6;c.strokeRect(bx+.5,y+6.5,bw-1,8);
      const sx=X(I.s),sw=Math.max((I.e-I.s+1)*dw-1,3);c.fillStyle=XC.accent;c.fillRect(sx,y+18,sw,3);c.fillStyle=XC.bad;if(I.late){const a=X(Math.max(I.pe+1,I.s));c.fillRect(a,y+18,X(I.e+1)-1-a,3)}if(I.early){const b2=X(Math.min(I.ps,I.e+1));c.fillRect(sx,y+18,b2-sx,3)}}
    else{
      c.fillStyle=XC.ink2;c.fillRect(bx,y+9,bw,7);c.fillStyle=XC.accent;c.fillRect(bx,y+9,bw*I.prog/100,7);
      c.fillStyle=XC.ink2;c.beginPath();c.moveTo(bx,y+16);c.lineTo(bx+6,y+16);c.lineTo(bx,y+21);c.fill();c.beginPath();c.moveTo(bx+bw,y+16);c.lineTo(bx+bw-6,y+16);c.lineTo(bx+bw,y+21);c.fill()}
  });
  // dependency arrows
  for(const id of ids){const I=m.info.get(id);for(const d of I.deps){if(!idx.has(d))continue;const P=m.info.get(d),bad=I.s<=P.e;
    const x1=X(P.e+1)-1,y1=by+idx.get(d)*RH+RH/2,x2=X(I.s),y2=by+idx.get(id)*RH+RH/2;
    c.strokeStyle=bad?XC.bad:XC.ink3;c.fillStyle=c.strokeStyle;c.lineWidth=1.1;c.setLineDash(bad?[4,3]:[]);c.beginPath();c.moveTo(x1,y1);
    if(x2-x1>=12){c.lineTo(x1+6,y1);c.lineTo(x1+6,y2);c.lineTo(x2-1,y2)}else{const ym=y2+(y2>y1?-RH/2:RH/2);c.lineTo(x1+6,y1);c.lineTo(x1+6,ym);c.lineTo(x2-8,ym);c.lineTo(x2-8,y2);c.lineTo(x2-1,y2)}
    c.stroke();c.setLineDash([]);c.beginPath();c.moveTo(x2,y2);c.lineTo(x2-6,y2-3.5);c.lineTo(x2-6,y2+3.5);c.fill()}}
  // today + target
  if(TODAY>=s0&&TODAY<=e0){c.fillStyle=XC.today;c.fillRect(X(TODAY)+dw/2-1,y0+20,2,SCALE-20+bodyH)}
  if(tgt&&tgt>=s0&&tgt<=e0){c.strokeStyle=XC.ink3;c.lineWidth=1.5;c.setLineDash([5,4]);c.beginPath();c.moveTo(X(tgt+1),y0+20);c.lineTo(X(tgt+1),by+bodyH);c.stroke();c.setLineDash([])}
  // frame
  c.strokeStyle=XC.line;c.lineWidth=1;c.strokeRect(PAD+.5,y0+.5,W-PAD*2-1,SCALE+bodyH-1);c.beginPath();c.moveTo(gx+.5,y0);c.lineTo(gx+.5,by+bodyH);c.moveTo(PAD,by+.5);c.lineTo(W-PAD,by+.5);c.stroke();
  if(!ids.length){c.fillStyle=XC.ink3;c.font=XF(400,13);c.fillText('No tasks to show.',PAD+10,by+20)}
  // footer
  c.fillStyle=XC.ink3;c.font=XF(400,10.5);c.fillText('RFID R&D Planner',PAD,H-16);
  c.textAlign='right';c.fillText(o.pages>1?`Page ${o.page} of ${o.pages}`:'',W-PAD,H-16);c.textAlign='left';
  return cv;
}
function drawSummaryPage(L,o){
  const {p,m,PAD,W}=L,sc=o.scale||2,ORD={missed:0,due:1,ok:2,scheduled:3};
  const fu=m.leaves.map(id=>m.info.get(id)).filter(I=>I.fu&&ORD[I.fu.kind]!=null).sort((a,b)=>ORD[a.fu.kind]-ORD[b.fu.kind]||(a.fu.next||0)-(b.fu.next||0));
  const ups=[...S.updates.values()].filter(u=>u.pid===p.id).sort((a,b)=>b.t-a.t);
  const owners=[...new Set(m.leaves.map(id=>m.info.get(id).t.assignee).filter(a=>S.members.has(a)))];
  const LD=computeLoad(),nW=Math.min(8,LD.weeks.length),RH=24,SEC=58;
  let fuN=fu.length,upN=ups.length;
  const fixed=86+SEC*3+owners.length*30+34+40;
  if(o.height){let room=Math.max(4,Math.floor((o.height-fixed)/RH));if(fuN+upN>room){fuN=Math.min(fuN,Math.max(2,Math.ceil(room/2)));upN=Math.min(upN,Math.max(0,room-fuN));if(fuN+upN<room)fuN=Math.min(fu.length,room-upN)}}
  const H=o.height||Math.round(fixed+(fuN+upN)*RH+(fu.length>fuN?18:0)+(ups.length>upN?18:0));
  const cv=document.createElement('canvas');cv.width=Math.round(W*sc);cv.height=Math.round(H*sc);const c=cv.getContext('2d');c.scale(sc,sc);c.textBaseline='middle';
  c.fillStyle='#FFFFFF';c.fillRect(0,0,W,H);c.fillStyle=XC.accent;c.fillRect(0,0,6,H);
  c.fillStyle=XC.ink3;c.font=XF(600,11);c.fillText(`${p.code||''}   FOLLOW-UPS · UPDATES · TEAM LOAD`.trim(),PAD,24);
  c.fillStyle=XC.ink;c.font=XF(700,22);c.fillText(xFit(c,p.name,W-PAD*2),PAD,52);
  let y=86;const IW=W-PAD*2;
  const sect=(t,sub)=>{c.fillStyle=XC.ink;c.font=XF(700,15);c.fillText(t,PAD,y+12);if(sub){c.fillStyle=XC.ink3;c.font=XF(400,11);c.fillText(sub,PAD+c.measureText(t).width+12,y+12);c.font=XF(700,15)}y+=30};
  const thead=(cols)=>{c.fillStyle=XC.head;c.fillRect(PAD,y,IW,22);c.fillStyle=XC.ink3;c.font=XF(600,10);let x=PAD;for(const [l,w] of cols){c.fillText(l.toUpperCase(),x+8,y+11);x+=w}y+=22};
  const chip=(x,yy,txt,bg,fg,maxw)=>{c.font=XF(600,9.5);const tw=Math.min(maxw,c.measureText(txt).width+14);c.fillStyle=bg;xRR(c,x,yy-8,tw,16,8);c.fill();c.fillStyle=fg;c.fillText(xFit(c,txt,tw-12),x+7,yy+.5)};
  const line=()=>{c.strokeStyle=XC.line2;c.lineWidth=1;c.beginPath();c.moveTo(PAD,y+RH-.5);c.lineTo(W-PAD,y+RH-.5);c.stroke()};
  // 1. follow-up status
  sect('Follow-up status',`${fu.filter(I=>I.fu.kind==='missed').length} missed · ${fu.filter(I=>I.fu.kind==='due').length} due · ${fu.length} being followed`);
  const fc=[['Status',120],['Task',IW*0.28],['Owner',IW*0.12],['Deadline',IW*0.12],['Asking',IW*0.14],['Last update',0]];fc[5][1]=IW-fc.slice(0,5).reduce((a,x)=>a+x[1],0);
  thead(fc);
  const FCH={missed:f=>[`Missed ${f.late}d`,XC.bad,'#FFFFFF'],due:()=>['Update due','#B7791F','#FFFFFF'],ok:f=>[`Next ${fmt(f.next)}`,'#E3F1E8','#256B43'],scheduled:f=>[`From ${fmt(f.next)}`,'#EEF1F4','#47576A']};
  for(const I of fu.slice(0,fuN)){const f=I.fu,mid=y+RH/2;let x=PAD;const [t1,b1,g1]=FCH[f.kind](f);chip(x+6,mid,t1+(f.mode==='deadline'?' · DL':''),b1,g1,fc[0][1]-10);x+=fc[0][1];
    c.fillStyle=XC.ink;c.font=XF(500,11.5);c.fillText(xFit(c,`${I.wbs}  ${I.t.title}`,fc[1][1]-12),x+8,mid);x+=fc[1][1];
    c.fillStyle=XC.ink2;c.font=XF(400,11);c.fillText(xFit(c,mName(I.t.assignee),fc[2][1]-12),x+8,mid);x+=fc[2][1];
    c.fillStyle=I.e<TODAY?XC.bad:XC.ink2;c.font=XM(10.5);c.fillText(`${fmt(I.e)}${I.e<TODAY?` (${TODAY-I.e}d late)`:` (${I.e-TODAY}d)`}`,x+8,mid);x+=fc[3][1];
    c.fillStyle=XC.ink2;c.font=XF(400,11);c.fillText(xFit(c,fuLabel(f.freq||f.f||0)+(f.mode==='deadline'?' (deadline mode)':''),fc[4][1]-12),x+8,mid);x+=fc[4][1];
    const lu=f.last;if(lu){const k=evKey(lu.event);chip(x+6,mid,lu.event,EVHEX[k],'#FFFFFF',130);c.font=XF(600,9.5);const cw=Math.min(130,c.measureText(lu.event).width+14);c.fillStyle=XC.ink2;c.font=XF(400,11);c.fillText(xFit(c,`${lu.remarks} — ${pName(lu.by)}, ${fmtTs(lu.t)}`,fc[5][1]-cw-22),x+cw+14,mid)}
    else{c.fillStyle=XC.ink3;c.font=XF(400,11);c.fillText('No updates yet',x+8,mid)}
    line();y+=RH}
  if(!fu.length){c.fillStyle=XC.ink3;c.font=XF(400,12);c.fillText('No open tasks are being followed up.',PAD+8,y+RH/2);y+=RH}
  if(fu.length>fuN){c.fillStyle=XC.ink3;c.font=XF(400,11);c.fillText(`+ ${fu.length-fuN} more in the planner’s Follow-ups tab`,PAD+8,y+9);y+=18}
  y+=SEC-30;
  // 2. event & remarks log
  sect('Event & remarks log',`${ups.length} update${ups.length===1?'':'s'} logged`);
  const uc=[['Date',118],['Task',IW*0.24],['Event',150],['Remarks',0],['Progress',70],['By',IW*0.12]];uc[3][1]=IW-uc.reduce((a,x)=>a+x[1],0);
  thead(uc);
  for(const u of ups.slice(0,upN)){const t=S.tasks.get(u.taskId),I=t?m.info.get(t.id):null,mid=y+RH/2;let x=PAD;
    c.fillStyle=XC.ink2;c.font=XM(10.5);c.fillText(fmtTs(u.t),x+8,mid);x+=uc[0][1];
    c.fillStyle=XC.ink;c.font=XF(500,11.5);c.fillText(xFit(c,t?`${I?I.wbs+'  ':''}${t.title}`:'Deleted task',uc[1][1]-12),x+8,mid);x+=uc[1][1];
    chip(x+6,mid,u.event,EVHEX[evKey(u.event)],'#FFFFFF',uc[2][1]-12);x+=uc[2][1];
    c.fillStyle=XC.ink2;c.font=XF(400,11);c.fillText(xFit(c,(evRange(u)?`[${evTxt(u)}] `:'')+u.remarks,uc[3][1]-14),x+8,mid);x+=uc[3][1];
    c.font=XM(10.5);c.fillText(u.progress!=null?u.progress+'%':'',x+8,mid);x+=uc[4][1];
    c.font=XF(400,11);c.fillText(xFit(c,pName(u.by),uc[5][1]-12),x+8,mid);line();y+=RH}
  if(!ups.length){c.fillStyle=XC.ink3;c.font=XF(400,12);c.fillText('No updates logged yet.',PAD+8,y+RH/2);y+=RH}
  if(ups.length>upN){c.fillStyle=XC.ink3;c.font=XF(400,11);c.fillText(`+ ${ups.length-upN} older update${ups.length-upN>1?'s':''} in the planner`,PAD+8,y+9);y+=18}
  y+=SEC-30;
  // 3. team load
  sect('Team load, all projects',`next ${nW} weeks · % of each person’s available hours`);
  const nameW=Math.min(260,IW*0.24),cw=Math.min(110,(IW-nameW)/nW);
  c.fillStyle=XC.head;c.fillRect(PAD,y,nameW+cw*nW,22);c.fillStyle=XC.ink3;c.font=XF(600,10);c.fillText('TEAM MEMBER',PAD+8,y+11);
  for(let i=0;i<nW;i++){c.textAlign='center';c.fillText(`W${isoWeek(LD.weeks[i])} · ${fmt(LD.weeks[i])}`,PAD+nameW+cw*i+cw/2,y+11);c.textAlign='left'}y+=24;
  for(const a of owners){const P=LD.people.get(a),mm=S.members.get(a),mid=y+13;c.fillStyle=xHex(a);c.beginPath();c.arc(PAD+10,mid,5,0,7);c.fill();c.fillStyle=XC.ink;c.font=XF(500,11.5);c.fillText(xFit(c,mm.name,nameW-60),PAD+20,mid);c.fillStyle=XC.ink3;c.font=XF(400,10);c.textAlign='right';c.fillText(`${memberCap(mm).hpd} h/day`,PAD+nameW-8,mid);c.textAlign='left';
    for(let i=0;i<nW;i++){const lo=P?P.load[i]:0,ca=P?P.cap[i]:0,u=ca>0?lo/ca:(lo>0?9:0);const bg=ca<=0&&!lo?'#EEF1F4':u>1.0001?'#D9535B':u>=0.85?'#EBC57A':lo>0?'#BFE3CC':'#F3F5F7';
      const cx2=PAD+nameW+cw*i+2;c.fillStyle=bg;xRR(c,cx2,y+2,cw-4,22,5);c.fill();c.fillStyle=u>1.0001?'#FFFFFF':XC.ink;c.font=XM(10.5);c.textAlign='center';c.fillText(ca<=0?(lo>0?'∞':'off'):`${Math.round(u*100)}% · ${fh(lo)}h`,cx2+(cw-4)/2,y+13.5);c.textAlign='left'}
    y+=30}
  if(!owners.length){c.fillStyle=XC.ink3;c.font=XF(400,12);c.fillText('No owners assigned in this project.',PAD+8,y+12);y+=26}
  c.fillStyle=XC.ink3;c.font=XF(400,10.5);c.fillText('RFID R&D Planner',PAD,H-16);c.textAlign='right';c.fillText(o.pages>1?`Page ${o.page} of ${o.pages}`:'',W-PAD,H-16);c.textAlign='left';
  return cv;
}
let jspdfP=null;
function loadJsPDF(){if(window.jspdf)return Promise.resolve();return jspdfP||(jspdfP=new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';s.onload=()=>res();s.onerror=()=>{jspdfP=null;rej(new Error('load'))};document.head.appendChild(s)}))}
function drExport(d){
  const p=S.projects.get(d.pid);const opt=(k,v,l)=>`<button type="button" class="${d[k]===v?'on':''}" data-action="exp-opt" data-k="${k}" data-v="${v}">${l}</button>`;
  return `${dHead(h(p.code||'Project'),'Export Gantt chart')}
  <div class="dr-b">
    <div class="fld"><span class="lab">Format</span><div class="seg wide">${opt('fmt','pdf','PDF · A3 landscape')}${opt('fmt','png','PNG image')}</div>
      <span class="hint">${d.fmt==='pdf'?'Best for printing and email. Long projects continue onto extra pages with the header repeated; the last page has follow-up status, the event &amp; remarks log and team load.':'One tall, high-resolution image with the chart, follow-up status, event &amp; remarks log and team load. Good for slides and chat.'}</span></div>
    <div class="fld"><span class="lab">Tasks</span><div class="seg wide">${opt('scope','all','All tasks')}${opt('scope','view','As shown on screen')}</div>
      <span class="hint">“As shown on screen” keeps your current filters and collapsed groups.</span></div>
    <div class="fld"><span class="lab">Preview${d.fmt==='pdf'?' · first and last page':''}</span><div class="exprev" id="expPrev"><span class="muted small">Drawing preview…</span></div><span class="hint" id="expInfo"></span></div>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="button" class="btn primary" data-action="do-export" id="expBtn">Download ${d.fmt.toUpperCase()}</button><button type="button" class="btn" data-action="close-drawer">Cancel</button></div>`;
}
async function drawExportPreview(d){
  try{if(document.fonts&&document.fonts.ready)await document.fonts.ready}catch(e){}
  if(drawer!==d)return;
  const L=ganttLayout(d.pid,d.scope),pages=ganttPages(L);
  const cv=d.fmt==='pdf'?drawGanttPage(L,pages[0],{page:1,pages:pages.length+1,height:L.pageH,scale:1}):drawGanttPage(L,L.rows,{page:1,pages:1,scale:1});
  const cvS=drawSummaryPage(L,d.fmt==='pdf'?{page:pages.length+1,pages:pages.length+1,height:L.pageH,scale:1}:{scale:1,pages:1,page:1});
  const box=$('#expPrev');if(!box)return;box.innerHTML='';box.appendChild(cv);cvS.style.marginTop='8px';cvS.style.borderTop='1px solid #CBD3DC';box.appendChild(cvS);
  const info=$('#expInfo');if(info)info.textContent=`${L.rows.length} task row${L.rows.length===1?'':'s'} · ${fmt(L.s0)} – ${fmt(L.e0)}${d.fmt==='pdf'?` · ${pages.length} chart page${pages.length>1?'s':''} + follow-ups &amp; team load page`:' · chart + follow-ups &amp; team load below'}`;
}
async function doExport(){
  const d=drawer;if(!d||d.type!=='export')return;const btn=$('#expBtn');btn.disabled=true;btn.textContent='Preparing…';
  try{
    let dl=null;try{dl=window.claude&&window.claude.use?await window.claude.use('downloads'):null}catch(e){}
    if(!dl)return formErr('Downloads aren’t available in this view. Open the planner on claude.ai to export.');
    try{if(document.fonts&&document.fonts.ready)await document.fonts.ready}catch(e){}
    const L=ganttLayout(d.pid,d.scope);let blob,ext;
    if(d.fmt==='png'){const tall=L.HEAD+L.SCALE+L.rows.length*L.RH;const sc=Math.min(2,15000/tall,15000/L.W);const cv1=drawGanttPage(L,L.rows,{page:1,pages:1,scale:sc}),cv2=drawSummaryPage(L,{scale:sc,pages:1,page:1});const cv=document.createElement('canvas');cv.width=cv1.width;cv.height=cv1.height+cv2.height;const cx=cv.getContext('2d');cx.drawImage(cv1,0,0);cx.drawImage(cv2,0,cv1.height);blob=await new Promise(r=>cv.toBlob(r,'image/png'));ext='png'}
    else{await loadJsPDF();const {jsPDF}=window.jspdf;const pages=ganttPages(L);const pdf=new jsPDF({orientation:'landscape',unit:'mm',format:'a3',compress:true});
      const sc=Math.min(2.2,9000/L.W);
      const tot=pages.length+1;pages.forEach((ids,i)=>{if(i)pdf.addPage('a3','landscape');const cv=drawGanttPage(L,ids,{page:i+1,pages:tot,height:L.pageH,scale:sc});pdf.addImage(cv.toDataURL('image/jpeg',0.92),'JPEG',0,0,420,297)});
      pdf.addPage('a3','landscape');{const cv=drawSummaryPage(L,{page:tot,pages:tot,height:L.pageH,scale:sc});pdf.addImage(cv.toDataURL('image/jpeg',0.92),'JPEG',0,0,420,297)}
      pdf.setProperties({title:`${L.p.code||''} ${L.p.name} – Gantt chart`.trim(),creator:'RFID R&D Planner'});
      blob=pdf.output('blob');ext='pdf'}
    const base=`${L.p.code?L.p.code+'_':''}${L.p.name}`.replace(/[^\w\- ]+/g,'').trim().replace(/\s+/g,'_').slice(0,80)||'project';
    await dl.save({filename:`${base}_Gantt_${n2d(TODAY)}.${ext}`,data:blob});
    toast('Gantt chart saved');closeDrawer();
  }catch(e){
    if(e&&e.code==='declined'){}
    else if(e&&e.code==='rate_limited')formErr('A save prompt is already open. Finish or close it first.');
    else if(e&&e.message==='load')formErr('Couldn’t load the PDF tool. Check your connection, or export as PNG.');
    else formErr('Couldn’t create the file. Try again.');
  }finally{const b=$('#expBtn');if(b&&drawer===d){b.disabled=false;b.textContent='Download '+d.fmt.toUpperCase()}}
}

/* ---------- admin settings: Team · Users & access · Email ---------- */
const PLANNER_URL=location.origin;
let emailDirty=false;
const SMTP_PRESETS={gmail:['smtp.gmail.com',587,'starttls'],m365:['smtp.office365.com',587,'starttls'],zoho:['smtp.zoho.in',465,'ssl']};
function viewAdmin(){
  const t=ui.adminTab||'team',pend=canManage()?S.requests.size:0;
  const tab=(k,l,b)=>`<button type="button" class="atab ${t===k?'on':''}" role="tab" aria-selected="${t===k}" data-action="admin-tab" data-v="${k}">${l}${b?` <span class="badge">${b}</span>`:''}</button>`;
  const body=t==='access'?viewAccess():t==='email'?viewEmail():t==='skills'?viewSkills():viewTeam();
  return `<div class="adm"><div class="phead"><div><div class="eyebrow">Admin</div><h1 class="ptitle">Admin settings</h1></div></div>
  <div class="atabs" role="tablist">${tab('team','Team')}${tab('skills','Skills &amp; calendar')}${tab('access','Users &amp; access',pend)}${tab('email','Email')}</div>
  <div class="apane">${body}</div></div>`;
}
function viewEmail(){
  const e=S.settings.get('email')||{},pw=(S.settings.get('emailpw')||{}).pw||'';
  const manage=canManage(),dis=manage?'':' disabled';
  const ms=memberList(),missing=ms.filter(m=>!m.email);
  const ready=!!(e.fromEmail&&e.host&&pw);
  const ck=(id,on,label)=>`<label class="chk"><input type="checkbox" id="${id}" ${on?'checked':''}${dis}> ${label}</label>`;
  return `<div class="phead"><div style="min-width:0"><h1 class="ptitle">Email</h1><div class="psub">The application’s own email account for sending follow-ups to the team.</div></div><span class="chip ${ready?'st-done':'st-todo'}">${ready?'Account saved':'Not set up'}</span></div>
  ${manage?'':'<div class="banner bad">Only the owner, or an admin shared as Editor, can change email settings.</div>'}
  <div class="banner"><span><b>The server sends follow-up emails</b> once a day at the sending time below, when emails are switched on and the sender account is saved.</span></div>
  <form id="emailForm" class="estack" novalidate>
  <section class="panel"><h2>Sender account</h2>
    <div class="two">
      <div class="fld"><label for="e-name">Sender name</label><input type="text" id="e-name" value="${h(e.senderName||'RFID R&D Planner')}" maxlength="80"${dis}></div>
      <div class="fld"><label for="e-from">Sender email ID</label><input type="email" id="e-from" value="${h(e.fromEmail||'')}" placeholder="planner@yourcompany.com" autocomplete="off" autocapitalize="none" spellcheck="false"${dis}></div>
    </div>
    <div class="two">
      <div class="fld"><label for="e-user">Login username</label><input type="text" id="e-user" value="${h(e.user||'')}" placeholder="Usually the sender email ID" autocomplete="off" autocapitalize="none" spellcheck="false"${dis}></div>
      <div class="fld"><label for="e-pw">Password</label><div class="codebox"><input type="password" id="e-pw" value="${h(pw)}" autocomplete="new-password" placeholder="App password"${dis}><button type="button" class="btn" id="e-show">Show</button></div></div>
    </div>
    <div class="fld"><span class="lab">Mail server</span>
      <div class="presets"><span class="muted small">Fill in for:</span><button type="button" class="linkbtn" data-preset="gmail"${dis}>Gmail / Google Workspace</button><button type="button" class="linkbtn" data-preset="m365"${dis}>Microsoft 365 / Outlook</button><button type="button" class="linkbtn" data-preset="zoho"${dis}>Zoho Mail</button></div>
      <div class="srv"><input type="text" id="e-host" value="${h(e.host||'')}" placeholder="SMTP server, e.g. smtp.gmail.com" aria-label="SMTP server" autocomplete="off" autocapitalize="none" spellcheck="false"${dis}>
      <input type="text" id="e-port" value="${h(e.port||'')}" placeholder="Port" aria-label="Port" inputmode="numeric" maxlength="5"${dis}>
      <select id="e-sec" aria-label="Security"${dis}>${[['starttls','STARTTLS'],['ssl','SSL / TLS'],['none','None']].map(([v,l])=>`<option value="${v}" ${(e.security||'starttls')===v?'selected':''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="fld"><label for="e-reply">Reply-to email ID (optional)</label><input type="email" id="e-reply" value="${h(e.replyTo||'')}" placeholder="Where replies should go, e.g. your own email" autocomplete="off" autocapitalize="none" spellcheck="false"${dis}></div>
    <p class="hint" style="margin:0">Gmail, Google Workspace and Microsoft 365 need an <b>app password</b> for this, not the account’s normal password. Only admins can see these settings.</p>
  </section>
  <section class="panel"><h2>Follow-up emails</h2>
    ${ck('e-on',e.enabled!==false,'Send follow-up emails when an update is due or missed')}
    ${ck('e-owner',e.toOwner!==false,'Email the task owner')}
    ${ck('e-lead',e.toLead!==false,'Email the project lead a summary of their project')}
    <div class="two">
      <div class="fld"><label for="e-time">Daily sending time (IST)</label><input type="time" id="e-time" value="${h(e.sendTime||'09:00')}"${dis}></div>
      <div class="fld"><label for="e-link">Planner address in emails</label><input type="url" id="e-link" value="${h(e.link||PLANNER_URL)}" autocomplete="off" spellcheck="false"${dis}></div>
    </div>
    <p class="hint" style="margin:0">One email per follow-up cycle. Reminders for a task stop once it gets an update or is marked completed.</p>
  </section>
  <section class="panel"><div class="panel-h"><h2>Team email IDs</h2><span class="muted small">${ms.length-missing.length} of ${ms.length} set</span></div>
    ${missing.length?`<p class="hint" style="margin:0">These people won’t get follow-up emails until they have an email ID:</p><div class="alist">${missing.map(m=>`<button type="button" class="aitem" data-action="edit-member" data-id="${m.id}">${av(m.id)}<span style="min-width:0"><div class="at">${h(m.name)}</div><div class="as">${h(m.role||'Team member')}</div></span><span class="slip small">Add email ID</span></button>`).join('')}</div>`:'<div class="empty-note">Every team member has an email ID.</div>'}
  </section>
  <div class="err" id="eErr" hidden></div>
  ${manage?`<div class="actions"><button type="submit" class="btn primary">Save email settings</button>${e.updatedAt?`<span class="muted small" style="align-self:center">Last saved ${fmtTs(e.updatedAt)} by ${h(pName(e.updatedBy))}</span>`:''}</div>`:''}
  </form>`;
}
function wireEmail(){
  const f=$('#emailForm');if(!f)return;
  f.addEventListener('input',()=>{emailDirty=true});f.addEventListener('change',()=>{emailDirty=true});
  f.addEventListener('submit',ev=>{ev.preventDefault();saveEmail()});
  const sh=$('#e-show');sh.addEventListener('click',()=>{const p=$('#e-pw');p.type=p.type==='password'?'text':'password';sh.textContent=p.type==='password'?'Show':'Hide'});
  f.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>{const [hst,pt,sc]=SMTP_PRESETS[b.dataset.preset];$('#e-host').value=hst;$('#e-port').value=pt;$('#e-sec').value=sc;if(!$('#e-user').value)$('#e-user').value=$('#e-from').value;emailDirty=true}));
  $('#e-port').addEventListener('input',e=>{e.target.value=e.target.value.replace(/\D/g,'').slice(0,5)});
}
function saveEmail(){
  if(!canManage())return;
  const err=m=>{const x=$('#eErr');x.textContent=m;x.hidden=false;x.scrollIntoView({block:'nearest'})};
  const v=id=>$('#'+id).value.trim(),em=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const from=v('e-from').toLowerCase(),reply=v('e-reply').toLowerCase(),host=v('e-host'),port=v('e-port'),pw=$('#e-pw').value;
  if(from&&!em.test(from))return err('The sender email ID doesn’t look right.');
  if(reply&&!em.test(reply))return err('The reply-to email ID doesn’t look right.');
  if(port&&(+port<1||+port>65535))return err('The port must be a number between 1 and 65535.');
  if(host&&!/^[A-Za-z0-9.-]+$/.test(host))return err('The SMTP server should look like smtp.example.com.');
  const old=S.settings.get('email')||{},oldPw=(S.settings.get('emailpw')||{}).pw||'';
  const rec={senderName:v('e-name')||'RFID R&D Planner',fromEmail:from,user:v('e-user')||from,host,port:port?+port:'',security:$('#e-sec').value,replyTo:reply,
    enabled:$('#e-on').checked,toOwner:$('#e-owner').checked,toLead:$('#e-lead').checked,sendTime:$('#e-time').value||'09:00',link:v('e-link')||PLANNER_URL,updatedAt:Date.now(),updatedBy:meKey()};
  const ch=diffFields([['Sender',old.fromEmail||'',rec.fromEmail],['Server',old.host?`${old.host}:${old.port}`:'',rec.host?`${rec.host}:${rec.port}`:''],['Sending time',old.sendTime||'',rec.sendTime],['Emails',old.enabled===false?'Off':'On',rec.enabled?'On':'Off']]);
  if(pw!==oldPw)ch.push('Password changed');
  put('settings','email',rec,{sys:true});
  if(pw!==oldPw)put('settings','emailpw',{pw,updatedAt:Date.now()},{sys:true});
  logH({act:'changed',kind:'settings',title:'updated the email settings',ch});
  emailDirty=false;$('#eErr').hidden=true;toast('Email settings saved');render();
}

/* ---------- parent (summary) tasks & successors ---------- */
const hasOwnWork=t=>false;
function parentWin(m,I){for(const a of [...(I?I.anc:[])].reverse()){const A=m.info.get(a);if(A&&A.ps!=null)return A}return null}
function ownWorkLine(t){return [t.start&&t.end?`${fmt(d2n(t.start))} – ${fmt(d2n(t.end))}`:'',+t.effort>0?`${fh(t.effort)} ${t.effortUnit==='d'?'days':'h'} effort`:'',`${+t.progress||0}% done`,t.skill?skillName(t.skill):'',t.assignee?mName(t.assignee):''].filter(Boolean).join(' · ')}
function ownWorkTask(t){return {projectId:t.projectId,parentId:t.id,title:`${t.title} (main work)`,assignee:t.assignee||'',skill:t.skill||'',effort:t.effort??'',effortUnit:t.effortUnit||'d',spread:t.spread||'even',priority:t.priority||'normal',
  start:t.start||n2d(TODAY),end:t.end||t.start||n2d(TODAY+4),progress:+t.progress||0,status:t.status||'todo',deps:[],notes:t.notes||'',fu:t.fu??'',fuLead:t.fuLead??'',fuDl:t.fuDl??'',outsideSkill:!!t.outsideSkill,order:1}}
function keepOwnWork(pid){const t=S.tasks.get(pid);if(!t||!hasOwnWork(t)||!canWrite())return null;const nid=uid('t');
  put('tasks',nid,ownWorkTask(t));put('tasks',pid,{...clean(t),ownWorkMoved:true});
  logH({act:'created',kind:'task',id:nid,pid:t.projectId,title:`${t.title} (main work)`,code:(S.projects.get(t.projectId)||{}).code||'',ch:['Kept the parent task’s own dates, effort, progress and follow-ups as a subtask',ownWorkLine(t)]});return nid}
function successorsHtml(m,id){
  const I=m.info.get(id),ids=[id,...(I?I.kids.map(k=>k.id):[])],seen=new Set(),out=[];
  for(const x of m.flat){const X=m.info.get(x);if(X.deps.some(d=>d===id||(m.info.get(d)&&m.info.get(d).anc.includes(id))||ids.includes(d))&&!seen.has(x)&&x!==id&&!X.anc.includes(id)){seen.add(x);out.push(X)}}
  if(!out.length)return '';
  return `<div class="fld"><span class="lab">Successor tasks · waiting on this</span><div class="sublist">${out.map(X=>`<button type="button" class="subrow" data-action="edit-task" data-id="${X.t.id}"><span class="wbs">${X.wbs}</span><span class="st">${h(X.t.title)}${X.conflict?' <span class="slip small">starts too early</span>':''}</span><span class="as">${X.leaf?h(mName(X.t.assignee))+' · ':''}${fmt(X.s)} – ${fmt(X.e)}</span><span class="chip st-${X.status}">${STATUS[X.status]}</span></button>`).join('')}</div><span class="hint">These start only after this task finishes. If this task slips, use “Fix link conflicts” to move them.</span></div>`;
}
function parentPanel(m,I,t){
  const leaves=m.leaves.filter(x=>m.info.get(x).anc.includes(I.t.id)).map(x=>m.info.get(x));
  let hrs=0,miss=0;for(const L of leaves){const hh=taskHours(L.t,S.members.get(L.t.assignee));if(hh)hrs+=hh;else miss++}
  const fk=k=>leaves.filter(L=>L.fu&&L.fu.kind===k).length,owners=[...new Set(leaves.map(L=>L.t.assignee).filter(Boolean))];
  const sk=[...new Set(leaves.map(L=>L.t.skill).filter(Boolean))].map(skillName);
  const work=I.leaf,rs=work?I.rs:I.s,re=work?I.re:I.e,rp=work?I.rprog:I.prog,rst=work?I.rstatus:I.status,ndone=leaves.filter(L=>L.status==='done').length;
  const head=work?`<div class="fld"><span class="lab">Subtasks summary · for reference only</span><span class="hint" style="margin:0">This task is tracked on its own dates, progress and status above. Its subtasks are tracked separately.</span></div>
    ${I.outside?`<div class="alert"><span>Subtasks run ${I.early?`${I.early} day${I.early>1?'s':''} before this task starts`:''}${I.early&&I.late?' and ':''}${I.late?`${I.late} day${I.late>1?'s':''} past this task’s end (${fmt(I.e)})`:''}.</span></div>`:''}
    ${I.status==='done'&&ndone<leaves.length?`<div class="alert"><span>This task is marked <b>Done</b> but ${leaves.length-ndone} subtask${leaves.length-ndone>1?'s are':' is'} still open.</span></div>`:''}`
   :`<div class="fld"><span class="lab">Own dates (optional)</span>
    <div class="two"><div class="fld"><label for="f-pstart" class="sub">Start</label><input type="date" id="f-pstart" value=""></div><div class="fld"><label for="f-pend" class="sub">End</label><input type="date" id="f-pend" value=""></div></div>
    <div class="hint">This task has no dates of its own, so it simply summarises its subtasks. Give it dates to track it separately, with its own owner, effort, progress, status and follow-ups.</div></div>`;
  return `${head}<div class="rollup sumgrid">
    <div><span class="as">Subtask dates</span><b class="${I.outside?'slip':''}">${fmt(rs)} – ${fmt(re)}</b><span class="as">${leaves.length} subtask${leaves.length===1?'':'s'}</span></div>
    <div><span class="as">Subtask progress</span><b>${rp}%</b><span class="as">${STATUS[rst]} · ${ndone}/${leaves.length} done</span></div>
    <div><span class="as">Subtask effort</span><b>${fh(hrs)} h</b><span class="as">${miss?`<span class="slip">${miss} without effort</span>`:'all estimated'}</span></div>
    <div><span class="as">Subtask follow-ups</span><b class="${fk('missed')?'slip':fk('due')?'fwarn':''}">${fk('missed')?fk('missed')+' missed':fk('due')?fk('due')+' due':'On track'}</b><span class="as">${leaves.filter(L=>L.fu&&!['done','off'].includes(L.fu.kind)).length} followed</span></div>
  </div>
  <div class="hint">${owners.length?'People: '+owners.map(o=>h(mName(o))).join(', '):'No owners yet'}${sk.length?' · Skills: '+sk.map(h).join(', '):''}</div>
  <div class="fld"><span class="lab">Subtasks</span><div class="sublist">${I.kids.map(k=>{const K=m.info.get(k.id);const outK=work&&K.leaf&&(K.s<I.s||K.e>I.e);return `<button type="button" class="subrow" data-action="edit-task" data-id="${k.id}"><span class="wbs">${K.wbs}</span><span class="st">${h(K.t.title)}${K.kids.length?` <span class="muted small">(${K.kids.length} subtasks)</span>`:''}${outK?' <span class="slip small">outside this task’s dates</span>':''}</span><span class="as">${K.leaf?h(mName(K.t.assignee))+' · ':''}${fmt(K.s)} – ${fmt(K.e)}${K.leaf&&+K.t.effort>0?` · ${fh(K.t.effort)} ${K.t.effortUnit==='d'?'d':'h'}`:''}${K.leaf&&K.t.skill?' · '+h(skillName(K.t.skill)):''}</span><span class="sr">${K.leaf&&K.fu?fuChip(K.fu):''}<span class="chip st-${K.status}">${STATUS[K.status]}</span><span class="mono small">${K.prog}%</span></span></button>`}).join('')}</div>
  <span class="hint">Open a subtask to change its owner, dates, skill, effort or follow-ups.</span></div>`;
}

/* ---------- edit / delete a follow-up update ---------- */
const canEditUp=u=>canWrite()&&(u.by===meKey()||isAdmin());
function drEditUpdate(d){
  const u=S.updates.get(d.uid);if(!u)return `${dHead('Follow-ups','Update not found')}<div class="dr-b"><p>This update was deleted.</p></div>`;
  const t=S.tasks.get(u.taskId),p=S.projects.get(u.pid)||{};const m=t?model(t.projectId):null,I=m?m.info.get(t.id):null;
  const r=evRange(u),ro=!canEditUp(u),dis=ro?' disabled':'';
  const lim=I?`min="${n2d(I.s)}" max="${n2d(I.e)}"`:'';
  return `<form id="f" novalidate>${dHead(`${h(p.code||'')}${I?' · Task '+I.wbs:''}`,'Edit follow-up update')}
  <div class="dr-b">
    <div class="rollup"><b>${t?h(t.title):'Deleted task'}</b><br>Logged by ${h(pName(u.by))} · ${fmtTs(u.t)}${u.editedAt?` · edited by ${h(pName(u.editedBy))} ${fmtTs(u.editedAt)}`:''}</div>
    ${ro?`<div class="banner">Only the person who logged this update, or an admin, can change it.</div>`:''}
    <div class="fld"><label for="u-event">Event</label><select id="u-event"${dis}>${EVENTS.map(e=>`<option ${e[1]===u.event?'selected':''}>${e[1]}</option>`).join('')}${EVENTS.some(e=>e[1]===u.event)?'':`<option selected>${h(u.event)}</option>`}</select></div>
    <div class="fld"><label for="u-rem">Remarks</label><textarea id="u-rem" maxlength="1000"${dis}>${h(u.remarks)}</textarea></div>
    <div class="fld"><label for="ue-prog">Progress recorded in this update</label><div class="codebox"><input type="number" id="ue-prog" min="0" max="100" step="5" value="${u.progress??''}"${dis}><span class="muted small" style="align-self:center">%</span></div><span class="hint">Changes the record only. To change the task’s current progress, edit the task${t?` (now ${+t.progress||0}%)`:''}.</span></div>
    ${I?`<div class="evbox"><label class="chk"><input type="checkbox" id="u-evt" ${r?'checked':''}${dis}> <b>Event timeline</b> · place this event on the task’s Gantt bar</label>
      <div id="evFields" ${r?'':'hidden'}>
        <div class="two"><div class="fld"><label for="u-ev-from" class="sub">Event date</label><input type="date" id="u-ev-from" ${lim} value="${r?n2d(r.a):n2d(Math.min(Math.max(TODAY,I.s),I.e))}"${dis}></div>
        <div class="fld"><label class="chk sub" for="u-ev-hasto"><input type="checkbox" id="u-ev-hasto" ${r&&r.b>r.a?'checked':''}${dis}> End date</label><input type="date" id="u-ev-to" ${lim} value="${r&&r.b>r.a?n2d(r.b):''}" ${r&&r.b>r.a&&!ro?'':'disabled'} data-end="${n2d(I.e)}" aria-label="Event end date"></div></div>
        <span class="hint">Dates must fall within this task’s timeline, ${fmt(I.s)} – ${fmt(I.e)}.</span></div></div>`:''}
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f">${ro?'':`<button type="submit" class="btn primary">Save changes</button><span class="spacer"></span><button type="button" class="btn danger" data-action="del-update" data-id="${u.id}" data-two="Confirm delete">Delete</button>`}<button type="button" class="btn" data-action="close-drawer">${ro?'Close':'Cancel'}</button></div></form>`;
}
function saveEditUpdate(d){
  const u=S.updates.get(d.uid);if(!u)return closeDrawer();if(!canEditUp(u))return formErr('Only the person who logged this update, or an admin, can change it.');
  const t=S.tasks.get(u.taskId),I=t?model(t.projectId).info.get(t.id):null;
  const event=$('#u-event').value,remarks=$('#u-rem').value.trim();if(!remarks)return formErr('Add a remark.');
  const pv=$('#ue-prog').value;const progress=pv===''?null:Math.min(100,Math.max(0,Math.round(+pv)));
  const rec={...clean(u),event,remarks,progress,editedAt:Date.now(),editedBy:meKey()};delete rec.evFrom;delete rec.evTo;
  if(I&&$('#u-evt').checked){const a=d2n($('#u-ev-from').value),b=$('#u-ev-hasto').checked?d2n($('#u-ev-to').value):null;
    if(a==null)return formErr('Pick the event date.');
    if(a<I.s||a>I.e)return formErr(`The event date must be within the task’s timeline, ${fmt(I.s)} – ${fmt(I.e)}.`);
    if($('#u-ev-hasto').checked&&b==null)return formErr('Pick the end date, or untick End date for a one-day event.');
    if(b!=null&&(b<a||b>I.e))return formErr(b<a?'The end date is before the event date.':`The end date must be on or before the task ends (${fmt(I.e)}).`);
    rec.evFrom=n2d(a);if(b!=null&&b>a)rec.evTo=n2d(b)}
  else if(!I&&u.evFrom){rec.evFrom=u.evFrom;if(u.evTo)rec.evTo=u.evTo}
  const ch=diffFields([['Event',u.event,event],['Event date',evTxt(u),evTxt(rec)],['Progress',u.progress!=null?u.progress+'%':'',progress!=null?progress+'%':'']]);if(u.remarks!==remarks)ch.push('Remarks edited');
  if(!ch.length){closeDrawer();return toast('No changes')}
  put('updates',u.id,rec);
  logH({act:'edited',kind:'task',id:u.taskId,pid:u.pid,title:t?t.title:'',code:(S.projects.get(u.pid)||{}).code||'',ch:[`Follow-up update from ${fmtTs(u.t)}`,...ch]});
  closeDrawer();toast('Update changed');
}
function deleteUpdate(id){const u=S.updates.get(id);if(!u||!canEditUp(u))return;const t=S.tasks.get(u.taskId);closeDrawer();del('updates',id);
  logH({act:'deleted',kind:'task',id:u.taskId,pid:u.pid,title:t?t.title:'',code:(S.projects.get(u.pid)||{}).code||'',ch:[`Follow-up update from ${fmtTs(u.t)}: ${u.event}`]});toast('Update deleted')}

/* ---------- drawer ---------- */
function openDrawer(d){drawer=d;renderDrawer();$('#drawerWrap').hidden=false;setTimeout(()=>{const f=$('#drawer [autofocus]');if(f&&window.innerWidth>760)f.focus()},30)}
function closeDrawer(){drawer=null;$('#drawerWrap').hidden=true;$('#drawer').innerHTML=''}
const dHead=(eyebrow,title)=>`<div class="dr-h"><div style="min-width:0"><div class="eyebrow">${eyebrow}</div><h2 id="drTitle">${title}</h2></div><span class="spacer"></span><button type="button" class="icon-btn" data-action="close-drawer" aria-label="Close"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>`;
function renderDrawer(){
  const el=$('#drawer');const d=drawer;if(!d)return;
  if(d.type==='task')el.innerHTML=drTask(d);
  else if(d.type==='project')el.innerHTML=drProject(d);
  else if(d.type==='member')el.innerHTML=drMember(d);
  else if(d.type==='resolve')el.innerHTML=drResolve(d);
  else if(d.type==='cred')el.innerHTML=d.mid?drMCred(d):drCred(d);
  else if(d.type==='export'){el.innerHTML=drExport(d);drawExportPreview(d)}
  else if(d.type==='update')el.innerHTML=drUpdate(d);
  else if(d.type==='editupdate')el.innerHTML=drEditUpdate(d);
  else if(d.type==='skill')el.innerHTML=drSkill(d);
  else if(d.type==='level'){el.innerHTML=drLevel(d);el.querySelectorAll('[data-lvl]').forEach(c=>c.addEventListener('change',()=>{c.checked?d.pick.add(c.dataset.lvl):d.pick.delete(c.dataset.lvl);const b=el.querySelector('[data-action=apply-level]');if(b){b.textContent=`Move ${d.pick.size} task${d.pick.size===1?'':'s'}`;b.disabled=!d.pick.size}}))}
  wireDrawer();
}
function drTask(d){
  const t=d.id?S.tasks.get(d.id):d.draft;
  const p=S.projects.get(t.projectId);const m=model(t.projectId);const I=d.id?m.info.get(d.id):null;
  const isParent=I&&!I.leaf;const parentI=t.parentId?m.info.get(t.parentId):null;
  const firstSub=!d.id&&parentI&&parentI.leaf&&hasOwnWork(parentI.t);
  const eyebrow=d.id?`${h(p?.code||'')} · Task ${I?.wbs||''}`:parentI?`New subtask under ${parentI.wbs} ${h(parentI.t.title)}`:`New task · ${h(p?.name||'')}`;
  const others=m.flat.filter(x=>x!==d.id);
  const deps=new Set(t.deps||[]);
  const s=d2n(t.start),e=d2n(t.end);
  const confl=I&&I.conflict?I.deps.filter(x=>I.s<=m.info.get(x).e).map(x=>m.info.get(x)):[];
  return `<form id="f" novalidate>${dHead(eyebrow,d.id?h(t.title):'Add task')}
  <div class="dr-b">
    ${firstSub?`<div class="rollup"><b>${h(parentI.t.title)} becomes a summary task.</b> Its own plan (${h(ownWorkLine(parentI.t))}) will be kept as a subtask “${h(parentI.t.title)} (main work)”, so its dates, effort, progress and follow-ups aren’t lost.</div>`:''}
    <div class="fld"><label for="f-title">Task name</label><input type="text" id="f-title" value="${h(t.title)}" required autofocus placeholder="e.g. Antenna matching network tuning"></div>
    ${isParent?`<div class="two">
      <div class="fld"><label for="f-assignee">Owner</label><select id="f-assignee"><option value="">Unassigned</option>${memberList().map(x=>`<option value="${x.id}" ${t.assignee===x.id?'selected':''}>${h(x.name)}</option>`).join('')}</select></div>
      <div class="fld"><label for="f-priority">Priority</label><select id="f-priority">${Object.entries(PRIO).map(([k,v])=>`<option value="${k}" ${(t.priority||'normal')===k?'selected':''}>${v}</option>`).join('')}</select></div>
    </div>`:`<div class="two">
      <div class="fld"><label for="f-skill">Required skill</label><select id="f-skill"><option value="">Choose a skill…</option>${skillList().map(sk=>`<option value="${sk.id}" ${t.skill===sk.id?'selected':''}>${h(sk.name)}</option>`).join('')}<option value="general" ${t.skill==='general'?'selected':''}>General (no special skill)</option></select></div>
      <div class="fld"><label for="f-priority">Priority</label><select id="f-priority">${Object.entries(PRIO).map(([k,v])=>`<option value="${k}" ${(t.priority||'normal')===k?'selected':''}>${v}</option>`).join('')}</select></div>
    </div>`}
    ${isParent?parentPanel(m,I,t):`
    <div class="two">
      <div class="fld"><label for="f-start">Start</label><input type="date" id="f-start" value="${h(t.start||'')}"></div>
      <div class="fld"><label for="f-end">End</label><input type="date" id="f-end" value="${h(t.end||'')}"></div>
    </div>
    ${(()=>{const PW=parentWin(m,I||(t.parentId?{anc:[t.parentId,...(m.info.get(t.parentId)?m.info.get(t.parentId).anc:[])]}:null));return PW?`<div class="hint" id="pwHint" data-ps="${PW.ps}" data-pe="${PW.pe}" data-nm="${h(PW.t.title)}"></div>`:''})()}
    <div class="hint" id="durOut">${s!=null&&e!=null&&e>=s?`${workdays(s,e)} working days (${WD[dow(s)]} → ${WD[dow(e)]})`:'Set both dates'}</div>
    <div class="two">
      <div class="fld"><label for="f-effort">Effort needed</label><div class="codebox"><input type="number" id="f-effort" min="0.5" step="0.5" value="${h(t.effort??'')}" placeholder="e.g. 24" inputmode="decimal"><select id="f-eunit" class="sel" aria-label="Effort unit"><option value="h" ${t.effortUnit!=='d'?'selected':''}>hours</option><option value="d" ${t.effortUnit==='d'?'selected':''}>days</option></select></div><select class="sel" id="f-spread" aria-label="Effort spread" style="margin-top:6px">${SPREAD.map(([v,l])=>`<option value="${v}" ${(t.spread||'even')===v?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="fld"><label for="f-assignee">Owner</label><select id="f-assignee"></select></div>
    </div>
    ${isAdmin()?`<label class="chk"><input type="checkbox" id="f-override" ${t.outsideSkill?'checked':''}> Show everyone (admin override: assign outside the skill)</label>`:''}
    <div class="hint" id="effHint"></div><div id="ownWarn"></div>
    <div class="two">
      <div class="fld"><label for="f-progress">Progress</label><div class="range"><input type="range" id="f-progress" min="0" max="100" step="5" value="${+t.progress||0}"><output id="progOut">${+t.progress||0}%</output></div></div>
      <div class="fld"><label for="f-status">Status</label><select id="f-status">${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${(t.status||'todo')===k?'selected':''}>${v}</option>`).join('')}</select></div>
    </div>`}
    ${confl.length?`<div class="alert"><span><b>Schedule conflict.</b> This task starts ${fmt(I.s)}, before ${confl.map(c=>`${c.wbs} ${h(c.t.title)} finishes on ${fmt(c.e)}`).join('; ')}.</span><button type="button" class="btn warn" data-action="resolve">Review fixes</button></div>`:''}
    <div class="fld"><span class="lab">Waits on (finish → start)</span>
      <span class="hint">Tick the tasks that must finish before this one can start. Leave everything unticked for work that runs in parallel.</span>
      ${others.length?`${others.length>10?'<input type="search" id="depSearch" placeholder="Filter tasks" aria-label="Filter tasks">':''}<div class="deplist" id="deplist">${others.map(x=>{const X=m.info.get(x);const why=d.id?blockedReason(m,d.id,x):(t.parentId&&(x===t.parentId||m.info.get(t.parentId)?.anc.includes(x))?'parent of this task':'');
        return `<label class="dep ${why?'dis':''}" data-q="${h((X.wbs+' '+X.t.title).toLowerCase())}"><input type="checkbox" name="dep" value="${x}" ${deps.has(x)?'checked':''} ${why&&!deps.has(x)?'disabled':''}><span class="wbs">${X.wbs}</span><span class="dt">${h(X.t.title)}</span>${why?`<span class="why">${why}</span>`:`<span class="why mono">ends ${fmt(X.e)}</span>`}</label>`}).join('')}</div>`:'<span class="hint">No other tasks in this project yet.</span>'}
    </div>
    ${isParent?'':`<div class="fld"><span class="lab">Follow-ups</span>
      ${(()=>{const pc=fuCfg({},p||{});return `<div class="fu3">
        <div class="fld"><label for="f-fu" class="sub">How often to ask</label><select class="sel" id="f-fu"><option value="">${fuLabel(pc.f)} (project default)</option>${FU_FREQ.map(([v,l])=>`<option value="${v}" ${t.fu!==''&&t.fu!=null&&+t.fu===v?'selected':''}>${l}</option>`).join('')}</select></div>
        <div class="fld"><label for="f-ful" class="sub">Deadline Mode</label><select class="sel" id="f-ful"><option value="">${leadLabel(pc.l)} (project default)</option>${FU_LEAD.map(([v,l])=>`<option value="${v}" ${t.fuLead!==''&&t.fuLead!=null&&String(t.fuLead==='start'?'off':t.fuLead)===String(v)?'selected':''}>${l}</option>`).join('')}</select></div>
        <div class="fld"><label for="f-fdl" class="sub">Deadline frequency</label><select class="sel" id="f-fdl"><option value="">${fuLabel(pc.dlf)} (project default)</option>${FU_DL.map(([v,l])=>`<option value="${v}" ${t.fuDl!==''&&t.fuDl!=null&&+t.fuDl===v?'selected':''}>${l}</option>`).join('')}</select></div>
      </div>`})()}
      <div class="hint" id="fuNote"></div>
      ${d.id&&I&&I.fu?`<div class="fuline">${fuChip(I.fu)}<span class="spacer"></span><button type="button" class="btn w" data-action="add-update" data-id="${d.id}">Add update</button></div>${upsFor(d.id).slice(0,3).map(upItem).join('')}`:''}
    </div>`}
    ${I&&I.leaf&&I.par?parentPanel(m,I,t):''}
    ${d.id?successorsHtml(m,d.id):''}
    <div class="fld"><label for="f-notes">Notes</label><textarea id="f-notes" placeholder="Test conditions, specs, links to reports…">${h(t.notes||'')}</textarea></div>
    ${d.id?taskHist(t):''}
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary w">${d.id?'Save changes':'Add task'}</button>
    ${d.id?`<button type="button" class="btn w" data-action="new-subtask" data-id="${d.id}">Add subtask</button><span class="spacer"></span><button type="button" class="btn danger w" data-action="delete-task" data-id="${d.id}" data-two="${isParent?`Delete with ${I.kids.length} subtask${I.kids.length>1?'s':''}`:'Confirm delete'}">Delete</button>`:'<button type="button" class="btn" data-action="close-drawer">Cancel</button>'}
  </div></form>`;
}
function drProject(d){
  const p=d.id?S.projects.get(d.id):{name:'',code:'',owner:'',status:'planning',start:n2d(TODAY),target:'',description:''};
  return `<form id="f" novalidate>${dHead(d.id?h(p.code||'Project'):'New project',d.id?'Project details':'Create project')}
  <div class="dr-b">
    <div class="fld"><label for="p-name">Project name</label><input type="text" id="p-name" value="${h(p.name)}" required autofocus placeholder="e.g. UHF fixed reader, 4-port"></div>
    <div class="two">
      <div class="fld"><label for="p-code">Project code</label><div class="codebox"><input type="text" id="p-code" value="${h(p.code||genCode())}" readonly maxlength="5" autocapitalize="characters" autocomplete="off" spellcheck="false" aria-describedby="codeHint"><button type="button" class="icon-btn" id="codeRegen" title="Generate a new code" aria-label="Generate a new code"><svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M11.5 7A4.5 4.5 0 1 1 10 3.6M10.2 1v2.8H7.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" class="btn" id="codeEdit">Edit</button></div><span class="hint" id="codeHint">Generated automatically.</span></div>
      <div class="fld"><label for="p-status">Status</label><select id="p-status">${Object.entries(PSTATUS).map(([k,v])=>`<option value="${k}" ${p.status===k?'selected':''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="fld"><label for="p-rank">Priority</label><select id="p-rank">${[['','Not ranked'],...[1,2,3,4,5,6,7,8,9,10].map(n=>[n,'P'+n+(n===1?' · highest':'')])].map(([v,l])=>`<option value="${v}" ${String(p.rank||'')===String(v)?'selected':''}>${l}</option>`).join('')}</select><span class="hint">When people are overloaded, Suggest fixes moves tasks from lower-priority projects first.</span></div>
    <div class="fld"><label for="p-owner">Project lead</label><select id="p-owner"><option value="">None</option>${memberList().map(x=>`<option value="${x.id}" ${p.owner===x.id?'selected':''}>${h(x.name)}</option>`).join('')}</select></div>
    <div class="two">
      <div class="fld"><label for="p-start">Planned start</label><input type="date" id="p-start" value="${h(p.start||'')}"></div>
      <div class="fld"><label for="p-target">Target finish</label><input type="date" id="p-target" value="${h(p.target||'')}"></div>
    </div>
    <span class="hint">The target date draws a dashed line on the timeline and flags a slip when tasks run past it.</span>
    ${(()=>{const pc=fuCfg({},p);return `<div class="fu3">
      <div class="fld"><label for="p-fu">How often to ask</label><select id="p-fu">${FU_FREQ.map(([v,l])=>`<option value="${v}" ${pc.f===v?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="fld"><label for="p-ful">Deadline Mode</label><select id="p-ful">${FU_LEAD.map(([v,l])=>`<option value="${v}" ${String(pc.l)===String(v)?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="fld"><label for="p-fdl">Deadline frequency</label><select id="p-fdl">${FU_DL.map(([v,l])=>`<option value="${v}" ${pc.dlf===v?'selected':''}>${l}</option>`).join('')}</select></div>
    </div>`})()}
    <span class="hint">Follow-ups for every task in this project: ask at “How often to ask”; when the deadline is near, Deadline Mode switches to the faster “Deadline frequency” and pauses the regular asks. Each task can override these.</span>
    <div class="fld"><label for="p-desc">Description</label><textarea id="p-desc" placeholder="Scope, customer, standards (e.g. ISO 18000-63, ETSI EN 302 208)…">${h(p.description||'')}</textarea></div>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary w">${d.id?'Save changes':'Create project'}</button>${d.id?`<span class="spacer"></span><button type="button" class="btn danger w" data-action="delete-project" data-id="${d.id}" data-two="Delete project and all tasks">Delete</button>`:'<button type="button" class="btn" data-action="close-drawer">Cancel</button>'}</div></form>`;
}
function drMember(d){
  const x=d.id?S.members.get(d.id):{name:'',role:''};
  return `<form id="f" novalidate>${dHead('Team',d.id?h(x.name):'Add team member')}
  <div class="dr-b">
    <div class="fld"><label for="m-name">Name</label><input type="text" id="m-name" value="${h(x.name)}" required autofocus placeholder="Full name"></div>
    <div class="fld"><label for="m-role">Role</label><input type="text" id="m-role" value="${h(x.role||'')}" placeholder="e.g. RF hardware engineer"></div>
    <div class="fld"><label for="m-email">Email ID</label><input type="email" id="m-email" value="${h(x.email||'')}" placeholder="name@company.com" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="120"></div>
    <span class="hint">Follow-up emails go here for tasks they own, and for every task in projects they lead.</span>
    <div class="fld"><span class="lab">Skills</span>${skillList().length?`<div class="sklist">${skillList().map(sk=>`<div class="skrow"><span>${h(sk.name)}</span><select class="sel" id="ms-${sk.id}" data-sk="${sk.id}" aria-label="${h(sk.name)} level">${[['','—'],['assist','Can assist'],['expert','Expert']].map(([v,l])=>`<option value="${v}" ${((x.skills||{})[sk.id]||'')===v?'selected':''}>${l}</option>`).join('')}</select></div>`).join('')}</div>`:'<span class="hint">No skills defined yet. Add them in Admin settings → Skills &amp; calendar.</span>'}</div>
    <div class="two">
      <div class="fld"><label for="m-hpd">Productive hours per day</label><input type="number" id="m-hpd" min="1" max="12" step="0.5" value="${h(x.hoursPerDay||6)}"><label for="m-wip" style="margin-top:8px">Max tasks at once (optional)</label><input type="number" id="m-wip" min="1" max="20" step="1" value="${h(x.wip||'')}" placeholder="No limit"></div>
      <div class="fld"><span class="lab">Working days</span><div class="wdays">${[1,2,3,4,5,6,0].map(dd=>`<label class="wd"><input type="checkbox" name="wd" value="${dd}" ${memberCap(x).wd.includes(dd)?'checked':''}><span>${WDN[dd]}</span></label>`).join('')}</div></div>
    </div>
    <div class="fld"><span class="lab">Leave</span><div id="leaveList"></div>
      <div class="leaveadd"><input type="date" id="lv-from" aria-label="Leave from"><input type="date" id="lv-to" aria-label="Leave to"><input type="text" id="lv-note" placeholder="Note (optional)" maxlength="60" aria-label="Leave note"><button type="button" class="btn" id="lvAdd">Add</button></div>
      <span class="hint">Leave days and company holidays reduce this person’s capacity in Resource load.</span></div>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary w">${d.id?'Save changes':'Add member'}</button>${d.id?`<span class="spacer"></span><button type="button" class="btn danger w" data-action="delete-member" data-id="${d.id}" data-two="Remove and unassign tasks">Remove</button>`:'<button type="button" class="btn" data-action="close-drawer">Cancel</button>'}</div></form>`;
}
function drResolve(d){
  const p=S.projects.get(d.pid);const moves=planResolve(d.pid);d.moves=moves;
  return `${dHead(h(p.code||p.name),'Fix link conflicts')}
  <div class="dr-b">
    <p style="margin:0">${moves.length?`Moving these ${moves.length} task${moves.length>1?'s':''} so each one starts on the next working day after everything it waits on has finished. Durations stay the same, and later tasks in the chain shift too.`:'Nothing needs to move. Every linked task already starts after its predecessors finish.'}</p>
    <div>${moves.map(mv=>`<div class="mv"><span class="wbs">${mv.I.wbs}</span><span>${h(mv.I.t.title)}</span><span class="d"><s>${fmt(mv.I.s)} – ${fmt(mv.I.e)}</s> → <b>${fmt(mv.s)} – ${fmt(mv.e)}</b> (+${mv.s-mv.I.s}d)</span></div>`).join('')}</div>
  </div>
  <div class="dr-f">${moves.length?`<button type="button" class="btn primary w" data-action="apply-resolve">Move ${moves.length} task${moves.length>1?'s':''}</button>`:''}<button type="button" class="btn" data-action="close-drawer">${moves.length?'Cancel':'Close'}</button></div>`;
}
function wireDrawer(){
  const f=$('#f');if(f)f.addEventListener('submit',onSubmit);
  if(!canWrite())document.querySelectorAll('#drawer .dr-b input,#drawer .dr-b select,#drawer .dr-b textarea,#drawer .codebox button').forEach(x=>{if(x.id!=='depSearch')x.disabled=true});
  const st=$('#f-start'),en=$('#f-end');
  const pwh=$('#pwHint');const pw=()=>{if(!pwh)return;const s=d2n(st.value),e=d2n(en.value),a=+pwh.dataset.ps,b=+pwh.dataset.pe;const out=s!=null&&e!=null&&(s<a||e>b);pwh.innerHTML=`${h(pwh.dataset.nm)} runs <b>${fmt(a)} – ${fmt(b)}</b>.`+(out?` <span class="slip">These dates fall outside it${e>b?`, ${e-b} day${e-b>1?'s':''} past its planned end`:''}.</span>`:'')};
  const pwe=$('#f-pstart');if(pwe){const pu=()=>{const a=d2n(pwe.value),b=d2n($('#f-pend').value);if(a!=null&&(b==null||b<a))$('#f-pend').value=n2d(a+4)};pwe.addEventListener('change',pu)}
  const upd=()=>{pw();const s=d2n(st.value),e=d2n(en.value);$('#durOut').textContent=s!=null&&e!=null?(e>=s?`${workdays(s,e)} working days (${WD[dow(s)]} → ${WD[dow(e)]})`:'End date is before start date'):'Set both dates'};
  if(st){st.addEventListener('change',()=>{const s=d2n(st.value),e=d2n(en.value);if(s!=null&&(e==null||e<s))en.value=n2d(s+4);upd()});en.addEventListener('change',upd)}
  const pr=$('#f-progress');if(pr)pr.addEventListener('input',()=>{$('#progOut').textContent=pr.value+'%';const ss=$('#f-status');if(+pr.value===100)ss.value='done';else if(+pr.value>0&&ss.value==='todo')ss.value='active';else if(+pr.value<100&&ss.value==='done')ss.value='active'});
  const ss=$('#f-status');if(ss)ss.addEventListener('change',()=>{if(ss.value==='done'){pr.value=100;$('#progOut').textContent='100%'}});
  const pc=$('#p-code');
  if(pc){const ed=$('#codeEdit'),hint=$('#codeHint');
    $('#codeRegen').addEventListener('click',()=>{pc.value=genCode(drawer&&drawer.id);pc.readOnly=true;ed.textContent='Edit';hint.textContent='Generated automatically.'});
    ed.addEventListener('click',()=>{if(pc.readOnly){pc.readOnly=false;ed.textContent='Done';hint.textContent='Type 5 capital letters or digits.';pc.focus();pc.select()}else{pc.readOnly=true;ed.textContent='Edit';hint.textContent=/^[A-Z0-9]{5}$/.test(pc.value)?'Entered manually.':'Code must be exactly 5 capital letters or digits.'}});
    pc.addEventListener('input',()=>{const v=pc.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);if(v!==pc.value)pc.value=v});
  }
  if(drawer&&drawer.type==='member'){
    if(!drawer.leave){const mm=drawer.id?S.members.get(drawer.id):null;drawer.leave=mm&&mm.leave?mm.leave.map(r=>({...r})):[]}
    const draw=()=>{const box=$('#leaveList');if(!box)return;const L=drawer.leave.slice().sort((a,b)=>a.from<b.from?-1:1);drawer.leave=L;
      box.innerHTML=L.length?L.map((r,i)=>`<div class="lvrow"><span class="mono small">${fmt(d2n(r.from))}${r.to&&r.to!==r.from?' – '+fmt(d2n(r.to)):''}</span><span class="small">${h(r.note||'Leave')}</span><button type="button" class="linkbtn" data-lv="${i}">Remove</button></div>`).join(''):'<span class="hint">No leave added.</span>'};
    draw();
    $('#leaveList').addEventListener('click',e=>{const b=e.target.closest('[data-lv]');if(!b)return;drawer.leave.splice(+b.dataset.lv,1);draw()});
    $('#lvAdd').addEventListener('click',()=>{const f=$('#lv-from').value,t=$('#lv-to').value||f,n=$('#lv-note').value.trim();if(!f)return formErr('Pick the first day of leave.');if(d2n(t)<d2n(f))return formErr('Leave ends before it starts.');drawer.leave.push({from:f,to:t,note:n});$('#lv-from').value='';$('#lv-to').value='';$('#lv-note').value='';$('#fErr').hidden=true;draw()});
    if(!canWrite())$('#lvAdd').disabled=true;
  }
  wireOwnerPicker();
  const pful=$('#p-ful');if(pful){const t=()=>{$('#p-fdl').disabled=pful.value==='off'||!canWrite()};pful.addEventListener('change',t);t()}
  const ffu=$('#f-fu');if(ffu&&drawer&&drawer.type==='task'){
    const tk=drawer.id?S.tasks.get(drawer.id):drawer.draft;const P=S.projects.get(tk.projectId)||{};const pc=fuCfg({},P);
    const upd=()=>{const lv=$('#f-ful').value,dv=$('#f-fdl').value;const l=lv===''?pc.l:parseLead(lv),dlf=dv===''?pc.dlf:+dv;
      const se=$('#f-start'),ee=$('#f-end');let s0=se?d2n(se.value):null,e=ee?d2n(ee.value):null;
      if(e==null&&drawer.id){const I=model(tk.projectId).info.get(drawer.id);if(I){e=I.e;s0=I.s}}
      const fdl=$('#f-fdl');fdl.disabled=l==='off'||!canWrite();let note='';
      if(l!=='off'&&e!=null){const ds=Math.max(s0??e,e-l);const on=TODAY>=ds;ffu.disabled=on||!canWrite();
        note=on?`Deadline mode is on since ${fmt(ds)}: asking ${fuLabel(dlf).toLowerCase()}. “How often to ask” is paused.`:`Deadline mode switches on ${fmt(ds)}: from then it asks ${fuLabel(dlf).toLowerCase()} and pauses “How often to ask”.`}
      else{ffu.disabled=!canWrite();note='Deadline mode is off: follow-ups keep using “How often to ask” until the task is completed.'}
      const n=$('#fuNote');if(n)n.textContent=note};
    ['#f-ful','#f-fdl','#f-start','#f-end'].forEach(q=>{const el=$(q);if(el)el.addEventListener('change',upd)});upd()}
  const ue=$('#u-evt');if(ue){ue.addEventListener('change',()=>{$('#evFields').hidden=!ue.checked});const uf=$('#u-ev-from'),ut=$('#u-ev-to'),uh=$('#u-ev-hasto');uh.addEventListener('change',()=>{ut.disabled=!uh.checked;ut.value=uh.checked?ut.dataset.end:''});uf.addEventListener('change',()=>{ut.min=uf.value||ut.min;if(ut.value&&uf.value&&ut.value<uf.value)ut.value=ut.dataset.end})}
  const up=$('#u-prog');if(up){up.addEventListener('input',()=>{$('#uProgOut').textContent=up.value+'%';$('#u-done').checked=+up.value===100});$('#u-done').addEventListener('change',e=>{if(e.target.checked){up.value=100;$('#uProgOut').textContent='100%'}})}
  const ds=$('#depSearch');if(ds)ds.addEventListener('input',()=>{const q=ds.value.toLowerCase().trim();document.querySelectorAll('#deplist .dep').forEach(l=>l.hidden=q&&!l.dataset.q.includes(q))});
}
function formErr(msg){const e=$('#fErr');e.textContent=msg;e.hidden=false}
async function onSubmit(ev){
  ev.preventDefault();const d=drawer;if(!d)return;
  if(d.type==='cred')return d.mid?saveMemberCred(d):saveCred(d);
  if(d.type==='update')return saveUpdate(d);
  if(d.type==='editupdate')return saveEditUpdate(d);
  if(d.type==='skill')return saveSkill(d);
  if(d.type==='task'){
    const old=d.id?S.tasks.get(d.id):d.draft;
    const title=$('#f-title').value.trim();if(!title)return formErr('Give the task a name.');
    const data={...clean(old),title,assignee:$('#f-assignee').value,priority:$('#f-priority').value,notes:$('#f-notes').value.trim(),
      deps:[...document.querySelectorAll('#deplist input[name=dep]:checked')].map(i=>i.value)};
    if($('#f-skill')){const sk=$('#f-skill').value;if(!sk)return formErr('Choose the required skill for this task.');const ef=+$('#f-effort').value;if(!(ef>0))return formErr('Enter the effort this task needs, in hours or days.');
      data.skill=sk;data.effort=ef;data.effortUnit=$('#f-eunit').value;data.spread=$('#f-spread').value;
      const ow=S.members.get(data.assignee);const outside=!!(ow&&sk!=='general'&&!(ow.skills||{})[sk]);
      if(outside&&!isAdmin()&&ow.id!==(old.assignee||''))return formErr(`${ow.name} doesn’t have this skill. Pick someone who does, or ask an admin.`);
      data.outsideSkill=outside}
    if($('#f-pstart')){const ps=$('#f-pstart').value,pe=$('#f-pend').value;if(!!ps!==!!pe)return formErr('Set both the planned start and planned end, or leave both empty.');if(ps&&d2n(pe)<d2n(ps))return formErr('The planned end is before the planned start.');data.start=ps;data.end=pe}
    if($('#f-start')){const s=$('#f-start').value,e=$('#f-end').value;if(!s||!e)return formErr('Set a start and end date.');if(d2n(e)<d2n(s))return formErr('The end date is before the start date.');
      data.start=s;data.end=e;data.progress=+$('#f-progress').value;data.status=$('#f-status').value;
      if(data.status==='done')data.progress=100;if(data.progress===100)data.status='done'}
    if($('#f-fu')){data.fu=$('#f-fu').value===''?'':+$('#f-fu').value;data.fuLead=$('#f-ful').value===''?'':parseLead($('#f-ful').value);data.fuDl=$('#f-fdl').value===''?'':+$('#f-fdl').value}
    const id=d.id||uid('t');if(!d.id)data.order=Date.now();
    const mm=model(data.projectId),pc=S.projects.get(data.projectId);
    put('tasks',id,data);
    const ch=d.id?diffTask(old,data,mm):[data.assignee?'Owner: '+mName(data.assignee):'',data.start?`Dates: ${dLab(data.start)} – ${dLab(data.end)}`:''].filter(Boolean);
    if(!d.id||ch.length)logH({act:d.id?'edited':'created',kind:'task',id,pid:data.projectId,title:data.title,code:pc?pc.code:'',ch});
    if(data.parentId)ui.collapsed.delete(data.parentId);
    {const II=d.id?model(data.projectId).info.get(id):null;toast(d.id&&II&&II.par&&data.status==='done'&&II.ropen?`Saved. Marked done, but ${II.ropen} subtask${II.ropen>1?'s are':' is'} still open.`:(d.id?'Task saved':'Task added'))}closeDrawer();
  }else if(d.type==='project'){
    const name=$('#p-name').value.trim();if(!name)return formErr('Give the project a name.');
    const t=$('#p-target').value,s=$('#p-start').value;if(t&&s&&d2n(t)<d2n(s))return formErr('Target finish is before the planned start.');
    const old=d.id?S.projects.get(d.id):{order:Date.now()};
    const code=$('#p-code').value.trim().toUpperCase();
    if(!(code===old.code||/^[A-Z0-9]{5}$/.test(code)))return formErr('Project code must be exactly 5 capital letters or digits.');
    if([...S.projects.values()].some(x=>x.id!==d.id&&x.code===code))return formErr(`Code ${code} is already used by another project. Generate a new one or enter a different code.`);
    const id=d.id||uid('p');
    const pdata={...clean(old),name,code,owner:$('#p-owner').value,status:$('#p-status').value,start:s,target:t,description:$('#p-desc').value.trim(),rank:$('#p-rank').value?+$('#p-rank').value:'',fuFreq:+$('#p-fu').value,fuLead:parseLead($('#p-ful').value),fuDl:+$('#p-fdl').value};
    put('projects',id,pdata);const pch=d.id?diffProject(old,pdata).concat(String(old.rank||'')!==String(pdata.rank||'')?[`Priority: ${old.rank?'P'+old.rank:'Not ranked'} → ${pdata.rank?'P'+pdata.rank:'Not ranked'}`]:[]):[];if(!d.id||pch.length)logH({act:d.id?'edited':'created',kind:'project',id,pid:id,title:name,code,ch:pch});
    closeDrawer();if(!d.id){ui.view='project';ui.pid=id;toast('Project created. Add its first task.')}else toast('Project saved');
  }else if(d.type==='member'){
    const name=$('#m-name').value.trim();if(!name)return formErr('Enter a name.');
    const old=d.id?S.members.get(d.id):{order:Date.now(),hue:nextHue()};
    const memail=$('#m-email').value.trim().toLowerCase();if(memail&&!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(memail))return formErr('Enter a valid email ID, like name@company.com.');
    if(memail&&[...S.members.values()].some(o=>o.id!==d.id&&(o.email||'').toLowerCase()===memail))return formErr('Another team member already uses this email ID.');
    const mid=d.id||uid('m'),mrole=$('#m-role').value.trim();
    const msk={};document.querySelectorAll('#drawer [data-sk]').forEach(el=>{if(el.value)msk[el.dataset.sk]=el.value});
    const hpd=Math.min(12,Math.max(1,+$('#m-hpd').value||6)),wdays=[...document.querySelectorAll('#drawer input[name=wd]:checked')].map(i=>+i.value);
    if(!wdays.length)return formErr('Pick at least one working day.');
    const wip=+$('#m-wip').value>0?Math.round(+$('#m-wip').value):'';put('members',mid,{...clean(old),name,role:mrole,email:memail,skills:msk,hoursPerDay:hpd,workDays:wdays,leave:d.leave||[],wip});
    const skTxt=o=>Object.entries(o||{}).filter(([k])=>S.skills.has(k)).map(([k,v])=>skillName(k)+(v==='expert'?' (Expert)':'')).sort().join(', ');
    const mch=d.id?diffFields([['Name',old.name,name],['Role',old.role||'',mrole],['Email',old.email||'',memail],['Skills',skTxt(old.skills),skTxt(msk)],['Hours/day',old.hoursPerDay||6,hpd],['Working days',memberCap(old).wd.map(x=>WDN[x]).join(' '),wdays.map(x=>WDN[x]).join(' ')],['Leave entries',(old.leave||[]).length,(d.leave||[]).length],['Max tasks at once',old.wip||'No limit',wip||'No limit']]):[mrole,memail,skTxt(msk)].filter(Boolean);if(!d.id||mch.length)logH({act:d.id?'edited':'created',kind:'member',id:mid,title:name,ch:mch});
    toast(d.id?'Member saved':'Member added');closeDrawer();
  }
}
/* 5-char project code: capitals + digits, always mixed, skips look-alikes (0/O, 1/I), unique across projects */
function genCode(selfId){
  const L='ABCDEFGHJKLMNPQRSTUVWXYZ',D='23456789',A=L+D;
  const used=new Set([...S.projects.values()].filter(p=>p.id!==selfId).map(p=>p.code));
  const pick=s=>{const r=new Uint32Array(1);crypto.getRandomValues(r);return s[r[0]%s.length]};
  for(let i=0;i<500;i++){let c='';for(let j=0;j<5;j++)c+=pick(A);if(/[A-Z]/.test(c)&&/\d/.test(c)&&!used.has(c))return c}
  return Date.now().toString(36).toUpperCase().slice(-5);
}
function nextHue(){const used=new Map();for(const m of S.members.values())used.set(m.hue%8,(used.get(m.hue%8)||0)+1);let best=0,bc=Infinity;for(let i=0;i<8;i++){const c=used.get(i)||0;if(c<bc){bc=c;best=i}}return best}

/* ---------- actions ---------- */
function newTaskDraft(pid,parentId){
  const m=model(pid);let s=TODAY;
  if(parentId){const P=m.info.get(parentId);if(P){const pps=d2n(P.t.start);const base=pps!=null&&!P.leaf?pps:(pps!=null&&P.leaf?pps:P.s);s=Math.max(base,isWE(base)?nextWork(base):base)}}
  else{const pj=S.projects.get(pid);const ps=d2n(pj?.start);if(ps&&ps>s)s=ps}
  if(isWE(s))s=nextWork(s);
  return {projectId:pid,parentId:parentId||'',title:'',assignee:'',skill:'',effort:'',effortUnit:'d',priority:'normal',start:n2d(s),end:n2d(s+4),progress:0,status:'todo',deps:[],notes:''};
}
async function deleteTask(id){
  if(!canWrite())return toast('You have read-only access.');
  const t=S.tasks.get(id);if(!t)return;const m=model(t.projectId);
  const gone=new Set([id]);for(const x of m.flat)if(m.info.get(x).anc.includes(id))gone.add(x);
  closeDrawer();
  for(const x of m.flat){if(gone.has(x))continue;const X=S.tasks.get(x);if((X.deps||[]).some(d=>gone.has(d)))await put('tasks',x,{...clean(X),deps:X.deps.filter(d=>!gone.has(d))})}
  for(const x of gone)del('tasks',x);
  logH({act:'deleted',kind:'task',id,pid:t.projectId,title:t.title,code:(S.projects.get(t.projectId)||{}).code||'',ch:gone.size>1?[`and ${gone.size-1} subtask${gone.size>2?'s':''}`]:[]});
  toast(gone.size>1?`Deleted ${gone.size} tasks`:'Task deleted');
}
async function deleteProject(id){
  if(!canWrite())return toast('You have read-only access.');
  const pj=S.projects.get(id);closeDrawer();const ts=[...S.tasks.values()].filter(t=>t.projectId===id);
  ui.view='overview';del('projects',id);for(const t of ts)del('tasks',t.id);logH({act:'deleted',kind:'project',id,pid:id,title:pj?pj.name:'',code:pj?pj.code:'',ch:[`${ts.length} task${ts.length===1?'':'s'} removed`]});toast('Project deleted');
}
async function deleteMember(id){
  if(!canWrite())return toast('You have read-only access.');
  closeDrawer();
  for(const t of S.tasks.values())if(t.assignee===id)put('tasks',t.id,{...clean(t),assignee:''});
  for(const p of S.projects.values())if(p.owner===id)put('projects',p.id,{...clean(p),owner:''});
  const mb=S.members.get(id);del('members',id);logH({act:'deleted',kind:'member',id,title:mb?mb.name:''});toast('Member removed; their tasks are now unassigned');
}
async function applyResolve(){
  const d=drawer;if(!d||!d.moves)return;const moves=d.moves;closeDrawer();
  for(const mv of moves){const t=S.tasks.get(mv.id);if(t)put('tasks',mv.id,{...clean(t),start:n2d(mv.s),end:n2d(mv.e)})}
  logH({act:'moved',kind:'bulk',pid:d.pid,title:`Rescheduled ${moves.length} task${moves.length>1?'s':''} to fix link conflicts`,code:(S.projects.get(d.pid)||{}).code||'',ch:moves.map(mv=>`${mv.I.wbs} ${mv.I.t.title}: ${fmt(mv.s)} – ${fmt(mv.e)}`)});
  toast(`Moved ${moves.length} task${moves.length>1?'s':''}`);
}
async function loadExample(){
  if(!canWrite())return toast('You have read-only access.');
  const B=monday(TODAY)-14;const D=o=>n2d(B+o);
  const M={a:uid('m'),r:uid('m'),v:uid('m'),me:uid('m'),k:uid('m')};
  const mem=[[M.a,'Asha Menon','Product & compliance lead'],[M.r,'Ravi Kulkarni','Firmware engineer'],[M.v,'Vikram Rao','RF hardware engineer'],[M.me,'Meena Iyer','Antenna design engineer'],[M.k,'Karan Singh','Test & validation engineer']];
  mem.forEach(([id,name,role],i)=>put('members',id,{name,role,hue:[0,1,2,3,4][i],order:i,example:true}));
  const P1=uid('p'),P2=uid('p');
  put('projects',P1,{name:'UHF Handheld Reader v2',code:'UHF2R',owner:M.a,status:'active',start:D(0),target:D(91),description:'Example project: next-generation handheld UHF RFID reader with BLE companion app.',order:1,example:true});
  put('projects',P2,{name:'Anti-metal Tag Qualification',code:'AMTQ1',owner:M.me,status:'active',start:D(7),target:D(46),description:'Example project: qualify an on-metal UHF tag for industrial asset tracking.',order:2,example:true});
  const ids={};const T=k=>ids[k]||(ids[k]=uid('t'));
  const rows=[
   [P1,'A','', 'Requirements & architecture'],
   [P1,'A1','A','Customer & regulatory requirements',M.a,0,4,100,[]],
   [P1,'A2','A','Chipset evaluation (E710 vs R2000)',M.v,0,9,60,[],'high'],
   [P1,'A3','A','System architecture & BOM estimate',M.r,7,15,70,['A1']],
   [P1,'H','', 'Hardware'],
   [P1,'H1','H','RF front-end design',M.v,16,30,10,['A2','A3'],'high'],
   [P1,'H2','H','Antenna design & simulation',M.me,16,28,25,['A3']],
   [P1,'H3','H','Schematic & PCB layout',M.v,31,51,0,['H1','H2']],
   [P1,'H4','H','EVT prototype build',M.k,52,63,0,['H3']],
   [P1,'F','', 'Firmware'],
   [P1,'F1','F','BSP & reader driver',M.r,21,45,0,['A3']],
   [P1,'F2','F','Gen2 inventory & anti-collision',M.r,46,63,0,['F1']],
   [P1,'F3','F','BLE companion app interface',M.k,28,50,0,['F1']],
   [P1,'V','', 'Validation'],
   [P1,'V1','V','Read-range & sensitivity testing',M.me,66,76,0,['H4','F2']],
   [P1,'V2','V','ETSI / FCC pre-compliance',M.a,79,90,0,['V1'],'critical'],
   [P2,'B1','','Inlay & spacer material shortlist',M.me,7,13,100,[]],
   [P2,'B2','','Sample tag build (3 variants)',M.k,14,24,40,['B1']],
   [P2,'B3','','Read range on steel plate',M.k,25,32,0,['B2']],
   [P2,'B4','','Environmental tests (heat, salt fog)',M.a,25,40,0,['B2']],
   [P2,'B5','','Qualification report',M.a,41,45,0,['B3','B4'],'high']];
  rows.forEach((r,i)=>{const [pid,k,par,title,as='',s=0,e=0,pg=0,dp=[],pr='normal']=r;const isPar=r.length===4;
    put('tasks',T(k),{projectId:pid,parentId:par?T(par):'',title,assignee:as,start:isPar?'':D(s),end:isPar?'':D(e),progress:pg,status:pg>=100?'done':pg>0?'active':'todo',priority:pr,deps:dp.map(T),notes:'',order:i,example:true})});
  logH({act:'created',kind:'bulk',title:'Loaded example data: 2 projects, 5 team members'});ui.view='project';ui.pid=P1;toast('Example projects loaded');
}
async function removeExamples(){
  if(!canWrite())return toast('You have read-only access.');
  for(const col of ['tasks','projects','members'])for(const x of [...S[col].values()])if(x.example)del(col,x.id);
  if(ui.pid&&!S.projects.has(ui.pid))ui.view='overview';
  logH({act:'deleted',kind:'bulk',title:'Removed example data'});
  toast('Example data removed');
}

const actions={
  'go':el=>{ui.view=el.dataset.view;emailDirty=false;render();window.scrollTo(0,0)},
  'admin-tab':el=>{ui.adminTab=el.dataset.v;emailDirty=false;render()},
  'open-project':el=>{ui.view='project';ui.pid=el.dataset.id;ui.fAssignee='';ui.fStatus='';render();window.scrollTo(0,0)},
  'new-project':()=>openDrawer({type:'project'}),
  'edit-project':()=>openDrawer({type:'project',id:ui.pid}),
  'new-member':()=>openDrawer({type:'member'}),
  'edit-member':el=>openDrawer({type:'member',id:el.dataset.id}),
  'new-task':()=>openDrawer({type:'task',draft:newTaskDraft(ui.pid,'')}),
  'new-subtask':el=>{const t=S.tasks.get(el.dataset.id);openDrawer({type:'task',draft:newTaskDraft(t.projectId,t.id)})},
  'edit-task':el=>{if(S.tasks.has(el.dataset.id))openDrawer({type:'task',id:el.dataset.id})},
  'toggle':el=>{const id=el.dataset.id;ui.collapsed.has(id)?ui.collapsed.delete(id):ui.collapsed.add(id);saveUi();render()},
  'expand-all':()=>{const m=model(ui.pid);m.flat.forEach(x=>ui.collapsed.delete(x));saveUi();render()},
  'collapse-all':()=>{const m=model(ui.pid);m.flat.forEach(x=>{if(m.info.get(x).par&&m.info.get(x).depth===0)ui.collapsed.add(x)});saveUi();render()},
  'set-mode':el=>{ui.mode=el.dataset.v;saveUi();render()},
  'set-zoom':el=>{ui.zoom=el.dataset.v;saveUi();render()},
  'jump-today':()=>{const g=$('#gantt');if(g)g.scrollTo({left:Math.max(0,+g.dataset.todayx-g.clientWidth*0.25),behavior:'smooth'})},
  'resolve':()=>{const pid=drawer&&drawer.type==='task'?(S.tasks.get(drawer.id)?.projectId||ui.pid):ui.pid;openDrawer({type:'resolve',pid})},
  'apply-resolve':applyResolve,
  'close-drawer':closeDrawer,
  'delete-task':el=>deleteTask(el.dataset.id),
  'delete-project':el=>deleteProject(el.dataset.id),
  'delete-member':el=>deleteMember(el.dataset.id),
  'load-example':loadExample,
  'remove-examples':removeExamples,
  'approve':async el=>{const u=el.dataset.id;let mid=$('#rq-m-'+u).value;const r=$('#rq-r-'+u).value;
    if(mid==='_new'){mid=uid('m');const nm=PF[u]&&PF[u].name?PF[u].name:'New team member';await put('members',mid,{name:nm,role:'',hue:nextHue(),order:Date.now()});logH({act:'created',kind:'member',id:mid,title:nm,ch:['Added when access was approved']})}
    await grant(u,r,mid);if(mid)await applyMemberSetup(u,mid);if(!S.creds.has(u))openDrawer({type:'cred',uid:u})},
  'pw-toggle':el=>{const u=el.dataset.id;ui.pwShown.has(u)?ui.pwShown.delete(u):ui.pwShown.add(u);render()},
  'pw-all':()=>{if(ui.pwShown.size)ui.pwShown.clear();else{for(const k of S.pwvault.keys())ui.pwShown.add(k);for(const k of S.memberlogin.keys())ui.pwShown.add('m:'+k)}render()},
  'pw-copy':el=>{const pw=pwFor(el.dataset.id);if(!pw)return;try{navigator.clipboard.writeText(pw).then(()=>toast('Password copied'),()=>toast('Copy was blocked. Click Show and copy it by hand.'))}catch(e){toast('Copy was blocked. Click Show and copy it by hand.')}},
  'decline':el=>{const u=el.dataset.id;if(!isAdmin())return;del('requests',u,{sys:true});logH({act:'declined',kind:'access',who:u});toast('Request declined')},
  'revoke':el=>{const u=el.dataset.id;if(!isAdmin())return;del('access',u,{sys:true});dropLogin(u);logH({act:'revoked',kind:'access',who:u});toast('Access removed')},
  'grant':el=>{const u=el.dataset.id;grant(u,el.dataset.role,'').then(()=>openDrawer({type:'cred',uid:u}))},
  'set-login':el=>{if(isAdmin()&&el.dataset.id)openDrawer({type:'cred',uid:el.dataset.id})},
  'gen-pw':()=>{const p=$('#c-pw');if(p){p.value=genPw();p.focus();p.select()}},
  'remove-login':el=>{const u=el.dataset.id;if(!isAdmin())return;dropLogin(u);logH({act:'unlogin',kind:'access',who:u});closeDrawer();toast('Login removed')},
  'sign-out':signOut,
  'edit-update':el=>{if(S.updates.has(el.dataset.id))openDrawer({type:'editupdate',uid:el.dataset.id})},
  'del-update':el=>deleteUpdate(el.dataset.id),
  'keep-own':el=>{const nid=keepOwnWork(el.dataset.id);if(nid){toast('Kept as a subtask. Open it to adjust dates or effort.');renderDrawer()}},
  'level':()=>openDrawer({type:'level'}),
  'apply-level':applyLevel,
  'load-opt':el=>{ui[el.dataset.k]=el.dataset.k==='loadWeeks'?+el.dataset.v:el.dataset.v;ui.loadSel=null;render()},
  'load-cell':el=>{const b=el.dataset.by;if(!b){ui.loadSel=null;return render()}const k=el.dataset.k,w=+el.dataset.w;ui.loadSel=ui.loadSel&&ui.loadSel.by===b&&ui.loadSel.k===k&&ui.loadSel.w===w?null:{by:b,k,w};render();setTimeout(()=>{const d=document.querySelector('.ldetail');if(d)d.scrollIntoView({block:'nearest',behavior:'smooth'})},30)},
  'rename-skill':el=>{if(canManage())openDrawer({type:'skill',id:el.dataset.id})},
  'del-skill':el=>deleteSkill(el.dataset.id),
  'del-hol':el=>{if(!canManage())return;const x=holidayList().find(y=>y.date===el.dataset.v);put('calendar','holidays',{days:holidayList().filter(y=>y.date!==el.dataset.v)},{sys:true});logH({act:'changed',kind:'settings',title:`removed the holiday ${x?x.name:''} on ${fmtY(d2n(el.dataset.v))}`});toast('Holiday removed')},
  'add-update':el=>{if(S.tasks.has(el.dataset.id))openDrawer({type:'update',id:el.dataset.id})},
  'fu-show':el=>{ui.fuShow=el.dataset.v;render()},
  'fu-csv':fuCsv,
  'export':()=>{if(ui.pid&&S.projects.has(ui.pid))openDrawer({type:'export',pid:ui.pid,fmt:'pdf',scope:'all'})},
  'exp-opt':el=>{if(drawer&&drawer.type==='export'){drawer[el.dataset.k]=el.dataset.v;renderDrawer()}},
  'do-export':doExport,
  'set-mlogin':el=>{if(canManage())openDrawer({type:'cred',mid:el.dataset.id})},
  'remove-mlogin':el=>{const mid=el.dataset.id;if(!canManage())return;const m=S.members.get(mid);del('memberlogin',mid,{sys:true});logH({act:'edited',kind:'member',id:mid,title:m?m.name:'',ch:['Prepared login removed']});closeDrawer();toast('Login removed')},
  'toggle-enabled':el=>{if(!canManage())return;const u=el.dataset.uid,mid=el.dataset.mid;
    if(u){const a=S.access.get(u);if(!a||u===ME.id)return;const off=!a.disabled;put('access',u,{...clean(a),disabled:off},{sys:true});logH({act:off?'disabled':'enabled',kind:'access',who:u});toast(`${pName(u)}’s account ${off?'disabled':'enabled'}`)}
    else if(mid){const m=S.members.get(mid);if(!m)return;const off=!m.accessDisabled;put('members',mid,{...clean(m),accessDisabled:off});logH({act:'edited',kind:'member',id:mid,title:m.name,ch:[off?'Access disabled':'Access enabled']});toast(`${m.name} ${off?'will start disabled':'is enabled'}`)}},
  'admin-reset-own':()=>{if(!isAdmin()||!ME.id||!myCreds())return;dropLogin(ME.id);logH({act:'unlogin',kind:'access',who:ME.id});ui.view='access';toast('Login cleared. Set a new login ID and password now.');setTimeout(()=>openDrawer({type:'cred',uid:ME.id}),300)},
};
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-action]');if(!el)return;
  if(el.closest('.dep'))return;
  const a=el.dataset.action;
  if(el.dataset.two&&!el.dataset.armed){e.preventDefault();el.dataset.armed='1';el.dataset.orig=el.textContent;el.textContent=el.dataset.two;setTimeout(()=>{if(el.isConnected&&el.dataset.armed){delete el.dataset.armed;el.textContent=el.dataset.orig}},4000);return}
  e.preventDefault();e.stopPropagation();
  actions[a]&&actions[a](el,e);
});
document.addEventListener('change',e=>{const ds=e.target.dataset||{};if(ds.acc){updateAccess(ds.uid,ds.acc,e.target.value);return}if(ds.link){if(e.target.value){const pm=S.members.get(ds.link);updateAccess(e.target.value,'memberId',ds.link);setTimeout(()=>applyMemberSetup(e.target.value,ds.link),80);if(pm&&pm.accessType&&e.target.value!==ME.id)setTimeout(()=>updateAccess(e.target.value,'role',pm.accessType),50)}return}
  if(ds.mtype){const m=S.members.get(ds.mtype);if(!m||!canManage())return;const before=m.accessType||'write',val=e.target.value;put('members',m.id,{...clean(m),accessType:val});logH({act:'edited',kind:'member',id:m.id,title:m.name,ch:[`Account type: ${ROLE[before]} → ${ROLE[val]} (when they join)`]});toast(`${m.name} will get ${ROLE[val]} access when they join`+(val==='admin'?'. Also share the page with them as Editor.':''));return}
  if(e.target.id&&e.target.id.startsWith('rq-m-')){const rs=$('#rq-r-'+e.target.id.slice(5)),pm=S.members.get(e.target.value);if(rs&&pm&&pm.accessType)rs.value=pm.accessType;return}if(ds.change){ui[ds.change]=e.target.value;render()}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&drawer)closeDrawer()});
render();

}
