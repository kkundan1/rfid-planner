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
// All dates are shown as DD/MM/YYYY.
const p2=x=>String(x).padStart(2,'0');
const fmtY=n=>{if(n==null||!isFinite(n))return '—';const d=new Date(n*DAY);return p2(d.getUTCDate())+'/'+p2(d.getUTCMonth()+1)+'/'+d.getUTCFullYear()};
const fmt=fmtY;
const isoToDmy=v=>{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v||''));return m?`${m[3]}/${m[2]}/${m[1]}`:v};
const dmyToIso=v=>{const m=/^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})\s*$/.exec(String(v||''));if(!m)return null;let y=+m[3];if(y<100)y+=2000;const d=+m[1],mo=+m[2];const iso=`${y}-${p2(mo)}-${p2(d)}`;const n=d2n(iso);return n!=null&&n2d(n)===iso?iso:null};
function isoWeek(n){const d=new Date(n*DAY);const day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day+3);const y=d.getUTCFullYear();const j4=Date.UTC(y,0,4);const j4d=(new Date(j4).getUTCDay()+6)%7;return 1+Math.round(((d-j4)/DAY-3+j4d)/7)}
const uid=p=>p+Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4);
const initials=n=>String(n||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase()||'?';
const STATUS={todo:'Not started',active:'In progress',blocked:'Blocked',done:'Done'};
const PSTATUS={planning:'Planning',active:'Active',hold:'On hold',done:'Completed',aborted:'Aborted'};
const PSTATUS_SET=['planning','active','hold'];// chosen by hand; Completed is automatic, Aborted needs a comment
const projClosed=p=>!!p&&(p.status==='done'||p.status==='aborted');
const projFrozen=pid=>projClosed(S.projects.get(pid));
const canManageProj0=pid=>canWrite()&&(isAdmin()||isLead(pid));
// View only people with "Can abort projects" may abort the projects ticked for them (not reopen)
const canAbortProj=pid=>{if(canManageProj0(pid))return true;if(readOnly||mode!=='live'||role()!=='read')return false;const m=myMember();return !!(m&&m.canAbortProjects&&canSeeProject(pid))};
const PRIO={low:'Low',normal:'Normal',high:'High',critical:'Critical'};
const chevron='<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ---------- data store (shared db when available, in-memory otherwise) ---------- */
const COLS=['members','projects','tasks','access','requests','history','creds','pwvault','memberlogin','updates','settings','skills','calendar','files','logs'];
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
  if(!(opts&&opts.sys)&&!canWrite()&&!(opts&&opts.addp&&canAddProj())){toast('You have read-only access.');return}
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
          if(col==='tasks')liveTaskDates(S.tasks,m);
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
function schedule(){loadCache=null;anaCache=null;if(raf)return;raf=requestAnimationFrame(()=>{raf=0;render()})}
let toastT=0;
function toast(msg){const t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>t.hidden=true,3800)}

/* ---------- follow-ups frequency ---------- */
const FU_DL=[[1,'Daily'],[7,'Weekly'],[14,'Every 2 weeks'],[21,'Every 3 weeks'],[2,'Every 2 days'],[3,'Every 3 days'],[4,'Every 4 days'],[5,'Every 5 days']];
const FU_FREQ=[[0,'Off'],...FU_DL];
const FU_LEAD=[['off','Off'],[3,'3 days before deadline'],[7,'1 week before deadline'],[14,'2 weeks before deadline'],[30,'1 month before deadline']];
const EVENTS=[['progress','Progress update'],['done','Work completed'],['issue','Blocked / issue'],['delay','Delay expected'],['supplier','Waiting on supplier'],['test','Test / measurement result'],['review','Design review'],['milestone','Milestone completed'],['reopen','Milestone reopened'],['delayrep','Delay reported'],['other','Other']];
const evKey=l=>(EVENTS.find(e=>e[1]===l)||['other'])[0];
const EVHEX={progress:'#2747C9',done:'#2E8B57',issue:'#C8323C',delay:'#B7791F',supplier:'#8B3FC7',test:'#0E8A7A',review:'#4A6177',milestone:'#2E8B57',reopen:'#B7791F',other:'#7A8897'};
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
function fuCounts(){let due=0,missed=0;for(const p of projList()){if(projClosed(p))continue;const m=model(p.id);for(const id of m.leaves){const k=m.info.get(id).fu?.kind;if(k==='due')due++;else if(k==='missed')missed++}}return {due,missed}}
function fuFilteredUpdates(){return [...S.updates.values()].filter(u=>inYearD(dayOf(u.t))&&(!ui.fuProject||u.pid===ui.fuProject)&&(!ui.fuPerson||(S.tasks.get(u.taskId)||{}).assignee===ui.fuPerson)).sort((a,b)=>b.t-a.t)}
function viewFollowups(){
  const ps=projList(),ms=workList(),ORD={missed:0,due:1,ok:2,scheduled:3,off:4};
  const rows=[];
  for(const p of ps){if(projClosed(p))continue;if(ui.fuProject&&p.id!==ui.fuProject)continue;const m=model(p.id);for(const id of m.leaves){const I=m.info.get(id);if(!I.fu||I.fu.kind==='done')continue;if(ui.fuPerson&&I.t.assignee!==ui.fuPerson)continue;rows.push({p,I})}}
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
      <div class="factions">${canEditTask(I.t)?`<button class="btn w" data-action="report-delay" data-id="${I.t.id}">Report delay</button>`:''}<button class="btn ${['due','missed'].includes(I.fu.kind)?'primary':''} w" data-action="add-update" data-id="${I.t.id}">Add update</button></div>
    </div>`}).join('')}</div></section>`}).join('');
  const fuTabs=`<div class="seg futabs" role="tablist" aria-label="Follow-ups views"><button class="${ui.fuTab!=='ms'&&ui.fuTab!=='dl'?'on':''}" role="tab" aria-selected="${ui.fuTab!=='ms'&&ui.fuTab!=='dl'}" data-action="fu-tab" data-v="fu">Follow-ups</button><button class="${ui.fuTab==='ms'?'on':''}" role="tab" aria-selected="${ui.fuTab==='ms'}" data-action="fu-tab" data-v="ms">Milestones${(()=>{let o=0;for(const t of S.tasks.values())if(canSeeProject(t.projectId))o+=msList(t).filter(msOver).length;return o?` <span class="badge">${o}</span>`:''})()}</button><button class="${ui.fuTab==='dl'?'on':''}" role="tab" aria-selected="${ui.fuTab==='dl'}" data-action="fu-tab" data-v="dl">Delays</button></div>`;
  if(ui.fuTab==='dl')return `<div class="phead"><div><div class="eyebrow">Follow-ups</div><h1 class="ptitle">Delays</h1></div></div>${fuTabs}${viewDelays()}`;
  if(ui.fuTab==='ms')return `<div class="phead"><div><div class="eyebrow">Follow-ups</div><h1 class="ptitle">Milestones</h1></div></div>${fuTabs}${viewMilestones()}`;
  return `<div class="phead"><div><div class="eyebrow">Follow-ups frequency</div><h1 class="ptitle">Follow-ups</h1></div></div>
  ${fuTabs}
  ${role()!=='read'||mode!=='live'?alertSettingsHtml():''}
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
    ${msList(t).length?`<div class="fld msfu"><span class="lab">Milestones · tick the ones completed</span>${msList(t).map((x,k)=>`<label class="chk msfu-r ${msState(x)}"><input type="checkbox" class="u-ms" value="${h(x.id)}" ${x.done?'checked disabled':''}> <span class="msn">${k+1}</span> ${h(x.name)}${x.due?` <span class="muted small">· target ${dLab(x.due)}</span>`:''}${x.done?` <span class="ok small">✓ ${x.doneAt?fmt(dayOf(x.doneAt)):''}</span>`:msOver(x)?' <span class="slip small">overdue</span>':''}</label>`).join('')}<div class="hint" id="uMsHint">${msDoneN(t)} of ${msList(t).length} completed = ${msProg(t)}%.</div></div>
    <input type="hidden" id="u-prog" value="${I.prog}"><output id="uProgOut" hidden>${I.prog}%</output>`:`<div class="fld"><label for="u-prog">Progress now</label><div class="range"><input type="range" id="u-prog" min="0" max="100" step="5" value="${I.prog}"><output id="uProgOut">${I.prog}%</output></div></div>`}
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
  const msTick=[...document.querySelectorAll('.u-ms:checked:not(:disabled)')].map(i=>i.value);
  if(!remarks&&!msTick.length)return formErr('Add a remark so the team knows what happened.');
  const done=$('#u-done').checked;let prog=done?100:+$('#u-prog').value;
  if(msList(t).length){const L=msList(t),ids=done?L.filter(x=>!x.done).map(x=>x.id):msTick;if(ids.length){const now=Date.now(),names=[];const ms=L.map(x=>{if(ids.includes(x.id)&&!x.done){names.push(x.name);return {...x,done:true,doneAt:now,doneBy:meKey()}}return x});
      const nt=withMsProgress({...clean(t),ms});put('tasks',t.id,nt);prog=nt.progress;d.msNames=names;logH({act:'edited',kind:'task',id:t.id,pid:t.projectId,title:t.title,code:(S.projects.get(t.projectId)||{}).code||'',ch:names.map(n=>'Milestone completed: '+n)})}else prog=msProg(t)}
  const rec={taskId:t.id,pid:t.projectId,t:Date.now(),by:meKey(),event:d.msNames&&d.msNames.length&&event==='Progress update'?'Milestone completed':event,remarks:remarks||('Milestone completed: '+(d.msNames||[]).join(', ')),progress:prog};if(d.msNames&&d.msNames.length)rec.ms=d.msNames;
  if($('#u-evt')&&$('#u-evt').checked){const I=model(t.projectId).info.get(t.id);const a=d2n($('#u-ev-from').value),b=$('#u-ev-hasto').checked?d2n($('#u-ev-to').value):null;if($('#u-ev-hasto').checked&&b==null)return formErr('Pick the end date, or untick End date for a one-day event.');
    if(a==null)return formErr('Pick the event date.');
    if(a<I.s||a>I.e)return formErr(`The event date must be within the task’s timeline, ${fmt(I.s)} – ${fmt(I.e)}.`);
    if(b!=null&&(b<a||b>I.e))return formErr(b<a?'The end date is before the event date.':`The end date must be on or before the task ends (${fmt(I.e)}).`);
    rec.evFrom=n2d(a);if(b!=null&&b>a)rec.evTo=n2d(b)}
  put('updates',uid('u'),rec);
  const ch=[event,remarks.length>90?remarks.slice(0,90)+'…':remarks];if(rec.evFrom)ch.push('Event timeline: '+evTxt(rec));
  if(!msList(t).length&&(prog!==(+t.progress||0)||done)){const st=prog>=100?'done':(t.status==='done'?'active':(t.status==='todo'&&prog>0?'active':t.status||'todo'));put('tasks',t.id,{...clean(t),progress:prog,status:st});ch.push(`Progress: ${+t.progress||0}% → ${prog}%`)}
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
const onLeave=(m,n)=>(m.leave||[]).some(r=>{if(r.half)return false;const a=d2n(r.from),b=d2n(r.to)??a;return a!=null&&n>=a&&n<=b});
const halfLeave=(m,n)=>(m.leave||[]).some(r=>r.half&&d2n(r.from)===n);
const HOL_COLOR='#7B2FBE',LV_COLOR='#000000';
// leave of a task's owner that falls inside [a,b]: [{a,b,half,note}]
function leaveIn(mid,a,b){const m=mid&&S.members.get(mid);if(!m||!Array.isArray(m.leave))return [];const out=[];for(const r of m.leave){const f=d2n(r.from),t=d2n(r.to||r.from);if(f==null||t==null||t<a||f>b)continue;out.push({a:Math.max(f,a),b:Math.min(t,b),half:!!r.half,note:r.note||''})}return out}
/* ---------- booked time ahead ---------- */
const BK_TYPES=[['routine','Routine work'],['support','Production support'],['meeting','Meetings'],['training','Training'],['travel','Travel'],['other','Other']];
const bkLabel=t=>(BK_TYPES.find(x=>x[0]===t)||BK_TYPES[5])[1];
// bookings of a person that cover day n (weekly ones repeat their from–to span every 7 days)
function bookingsOn(m,n){const out=[];for(const b of (m&&m.bookings)||[]){if(!b||!(+b.hours>0))continue;const a=d2n(b.from),z=d2n(b.to||b.from);if(a==null||z==null||n<a)continue;
  if(b.weekly){const u=d2n(b.until)??z;if(n>u)continue;if((n-a)%7<=z-a)out.push(b)}else if(n<=z)out.push(b)}return out}
const bookedOn=(m,n)=>bookingsOn(m,n).reduce((a,b)=>a+(+b.hours||0),0);
const bkEnd=b=>b.weekly?b.until:(b.to||b.from);
const bkWhen=b=>`${fmt(d2n(b.from))}${b.to&&b.to!==b.from?' – '+fmt(d2n(b.to)):''}${b.weekly?` · every week until ${fmt(d2n(b.until))}`:''}`;
// booked days of a task's owner inside [a,b]: [{a,b,h,full,label}] (runs of days with the same hours)
function bookIn(mid,a,b,hol){const m=mid&&S.members.get(mid);if(!m||!Array.isArray(m.bookings)||!m.bookings.length)return [];const hpd=memberCap(m).hpd,out=[];let cur=null;
  for(let n=Math.max(a,TODAY);n<=b;n++){const L=isWorkDay(m,n,hol)?bookingsOn(m,n):[],x=L.reduce((s,y)=>s+(+y.hours||0),0);
    if(x>0&&cur&&cur.h===x&&cur.b===n-1){cur.b=n;continue}if(cur){out.push(cur);cur=null}if(x>0)cur={a:n,b:n,h:x,full:x>=hpd-0.01,label:L.map(y=>`${fh(y.hours)} h ${bkLabel(y.type)}${y.note?' ('+y.note+')':''}`).join(', ')}}
  if(cur)out.push(cur);return out}
let _gh=null,_ghk='';const ganttHol=()=>{const L=holidayList(),k=L.length+'|'+(L[0]||{}).date;if(!_gh||k!==_ghk){_gh=new Set(L.map(x=>x.date));_ghk=k}return _gh};
const holIn=(a,b)=>holidayList().filter(x=>{const n=d2n(x.date);return n!=null&&n>=a&&n<=b});
function isWorkDay(m,n,hol){if(hol.has(n2d(n)))return false;if(!m)return !isWE(n);return memberCap(m).wd.includes(dow(n))&&!onLeave(m,n)}
function taskHours(t,owner){const e=+t.effort;if(!(e>0))return null;return t.effortUnit==='d'?e*(owner?memberCap(owner).hpd:6):e}
function taskDaily(t,I,owner,hol,from){
  const H=taskHours(t,owner);if(H==null)return null;
  const rem=H*(1-Math.min(100,I.prog||0)/100),out=new Map();if(rem<=0)return out;
  const F0=from==null?TODAY:from;
  let a=Math.max(I.s,F0),b=I.e;if(b<F0){a=F0;b=Math.max(F0,monday(F0)+4)}
  const days=[];for(let n=a;n<=b;n++)if(isWorkDay(owner,n,hol))days.push(n);if(!days.length)days.push(a);
  const mode=t.spread||'even';
  if(mode!=='even'){const hpd=owner?memberCap(owner).hpd:6;if(rem<=hpd*days.length+0.01){let r=rem;const seq=mode==='late'?days.slice().reverse():days;for(const n of seq){if(r<=0)break;const x=Math.min(hpd,r);out.set(n,x);r-=x}return out}}
  const per=rem/days.length;for(const n of days)out.set(n,per);return out;
}
// Daily log by person and day (visible entries with hours, up to and including today)
function logsByMember(){const LG=new Map();for(const l of S.logs.values()){if(!canSeeLog(l))continue;const n=d2n(l.date);if(n==null||n>TODAY||!(+l.hours>0)||!l.mid)continue;let mm=LG.get(l.mid);if(!mm)LG.set(l.mid,mm=new Map());if(!mm.has(n))mm.set(n,[]);mm.get(n).push(l)}return LG}
// average routine (non-project) hours per working day over the last 4 weeks; needs 3+ logged days
function routineAvg(m,mm,hol){if(!mm)return 0;const w0=TODAY-28;let npH=0,dl=0,wdc=0;for(const [n,ls] of mm)if(n>=w0&&n<TODAY){dl++;for(const l of ls)if(!l.pid)npH+=+l.hours||0}for(let n=w0;n<TODAY;n++)if(isWorkDay(m,n,hol))wdc++;return dl<3||!npH||!wdc?0:npH/wdc}
function computeLoad(){
  if(loadCache)return loadCache;
  const hol=new Set(holidayList().map(x=>x.date)),W0=monday(TODAY);
  const projs=[...S.projects.values()].filter(p=>!projClosed(p)&&canSeeProject(p.id)&&inYearP(p));let maxE=TODAY;
  const models=projs.map(p=>{const m=model(p.id);if(isFinite(m.e))maxE=Math.max(maxE,m.e);return [p,m]});
  const nW=Math.min(52,Math.max(16,Math.ceil((maxE-W0+1)/7)+1)),weeks=[...Array(nW)].map((_,i)=>W0+i*7);
  const blank=()=>({load:weeks.map(()=>0),cap:weeks.map(()=>0),items:weeks.map(()=>[])});
  const people=new Map();
  for(const m of S.members.values()){if(isViewOnly(m))continue;const P=blank();const c=memberCap(m);weeks.forEach((w,i)=>{let h=0;for(let n=w;n<w+7;n++)if(isWorkDay(m,n,hol))h+=halfLeave(m,n)?c.hpd/2:c.hpd;P.cap[i]=h});people.set(m.id,P)}
  const skills=new Map(),missingEffort=[],missingSkill=[],open=new Map();
  const sk=k=>{if(!skills.has(k))skills.set(k,blank());return skills.get(k)};
  const LG=logsByMember();
  for(const [p,m] of models)for(const id of m.leaves){const I=m.info.get(id);if(I.status==='done')continue;const t=I.t;
    if(!t.skill)missingSkill.push({p,I});
    const owner=S.members.get(t.assignee),lt=owner&&LG.get(owner.id),daily=taskDaily(t,I,owner,hol,lt&&lt.has(TODAY)?TODAY+1:TODAY);
    if(owner){if(!open.has(owner.id))open.set(owner.id,[]);open.get(owner.id).push({id:t.id,s:I.s,e:I.e})}
    if(daily==null){missingEffort.push({p,I});continue}
    const wk=new Map();for(const [n,h] of daily){const w=Math.floor((n-W0)/7);if(w>=0&&w<nW)wk.set(w,(wk.get(w)||0)+h)}
    const S2=sk(t.skill||'none');
    for(const [w,h] of wk){const it={p,I,h};if(owner&&people.has(owner.id)){const P=people.get(owner.id);P.load[w]+=h;P.items[w].push(it)}S2.load[w]+=h;S2.items[w].push(it)}
  }
  // logged hours so far this week (incl. today); from tomorrow on (or today if not logged yet) the larger of
  // the time booked ahead and the person's usual routine non-project work
  for(const [mid,P] of people){const m=S.members.get(mid),mm=LG.get(mid);P.logged=weeks.map(()=>0);P.routine=weeks.map(()=>0);P.booked=weeks.map(()=>0);
    if(mm)for(const [n,ls] of mm){if(n<W0)continue;const w=Math.floor((n-W0)/7);if(w<0||w>=nW)continue;const hh=ls.reduce((a,l)=>a+(+l.hours||0),0);P.load[w]+=hh;P.logged[w]+=hh}
    const avg=routineAvg(m,mm,hol);if(avg)P.npAvg=avg;const from=mm&&mm.has(TODAY)?TODAY+1:TODAY;const hasBk=Array.isArray(m.bookings)&&m.bookings.length;if(!avg&&!hasBk)continue;
    weeks.forEach((w0,i)=>{let x=0,bk=0;for(let n=Math.max(w0,from);n<w0+7;n++)if(isWorkDay(m,n,hol)){const r=halfLeave(m,n)?avg/2:avg,b=hasBk?bookedOn(m,n):0;if(b>=r)bk+=b;else x+=r}
      if(x>0){P.load[i]+=x;P.routine[i]+=x}if(bk>0){P.load[i]+=bk;P.booked[i]+=bk}})}
  for(const s of skillList())sk(s.id);
  for(const [k,S2] of skills){if(k==='none')continue;for(const m of S.members.values()){if(k!=='general'&&!(m.skills||{})[k])continue;const P=people.get(m.id);if(!P)continue;P.cap.forEach((c,i)=>S2.cap[i]+=c)}}
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
/* ---------- daily log (work diary) ---------- */
const LOG_TYPES=['Lab testing','Design','Meeting','Customer support','Production support','Documentation','Learning','Admin','Other'];
const LOG_LOCK=7*DAY;
const logType=l=>l.type==='Other'&&l.typeOther?l.typeOther:(l.type||'Other');
const NPROJ={id:'_np',code:'NP',name:'Non-project work',rank:'',status:'active'};
const logMid=()=>{const m=myMember();return m&&!isViewOnly(m)?m.id:null};
const leadsAny=()=>{const m=myMember();return !!m&&[...S.projects.values()].some(p=>p.owner===m.id)};
function canSeeLog(l){if(!l)return false;if(isAdmin()||l.by===meKey())return true;const m=myMember();const p=l.pid&&S.projects.get(l.pid);return !!(m&&p&&p.owner===m.id)}
const logLocked=l=>!!l&&Date.now()-(l.createdAt||0)>LOG_LOCK;
const canEditLog=l=>canWrite()&&(!l||isAdmin()||(l.by===meKey()&&!logLocked(l)));
const logsVisible=()=>[...S.logs.values()].filter(l=>canSeeLog(l)&&inYearD(d2n(l.date)));
const myLogs=()=>{const k=meKey(),mid=logMid();return [...S.logs.values()].filter(l=>l.by===k||(mid&&l.mid===mid))};
function logIndex(list){const m=new Map();for(const l of list){if(!m.has(l.date))m.set(l.date,[]);m.get(l.date).push(l)}for(const a of m.values())a.sort((x,y)=>(x.createdAt||0)-(y.createdAt||0));return m}
const sumH=a=>a.reduce((s,l)=>s+(+l.hours||0),0);
const holSet=()=>new Set(holidayList().map(x=>x.date));
const dueByHour=17;
function logMissingDays(m,from,to,idx,hol){const out=[];const nowH=new Date().getHours();for(let n=from;n<=to;n++){if(n>TODAY)break;if(n===TODAY&&nowH<dueByHour)continue;if(!isWorkDay(m,n,hol))continue;if(!idx.has(n2d(n)))out.push(n)}return out}
function myLogBadge(){const mid=logMid();if(!mid||!canWrite())return 0;const m=S.members.get(mid);return logMissingDays(m,TODAY-6,TODAY,logIndex(myLogs()),holSet()).length}
const logProjLab=l=>{const p=l.pid&&S.projects.get(l.pid);if(!p)return l.pid?'Removed project':'Non-project work';const t=l.taskId&&S.tasks.get(l.taskId);return `${p.code||''} ${p.name}${t?' · '+t.title:''}`.trim()};
function logCard(l,showWho){const ed=canEditLog(l);const p=l.pid&&S.projects.get(l.pid);
  return `<button type="button" class="logc" data-action="open-log" data-id="${l.id}"><span class="logh mono">${fh(l.hours)} h</span><span style="min-width:0">
  <span class="logm">${showWho?`<b>${h(mName(l.mid))}</b> · `:''}<span class="ltype">${h(logType(l))}</span> · ${p?`<span class="mono">${h(p.code||'')}</span> ${h(p.name)}${l.taskId&&S.tasks.get(l.taskId)?' · '+h(S.tasks.get(l.taskId).title):''}`:`<span class="muted">${l.pid?'Removed project':'Non-project work'}</span>`}${!ed&&l.by===meKey()&&logLocked(l)?' · <span class="muted">locked</span>':''}</span>
  <span class="logw">${h(l.what||'')}</span>${l.result?`<span class="logr"><b>Result / blockers:</b> ${h(l.result)}</span>`:''}${l.plan?`<span class="logr"><b>Plan for tomorrow:</b> ${h(l.plan)}</span>`:''}</span></button>`}
function logMonthOf(){let m=/^\d{4}-\d{2}$/.test(ui.logMonth||'')?ui.logMonth:n2d(TODAY).slice(0,7);const y=gFy();if(y!=null){const [A,B]=fyRange(y),a=n2d(A).slice(0,7),b=n2d(B).slice(0,7);if(m<a)m=a;if(m>b)m=b}return m}
function viewLog(){
  const tabs=[['mine','My diary']];if(isAdmin()||leadsAny())tabs.push(['team','Team diary']);if(isAdmin())tabs.push(['sheet','Monthly timesheet']);
  if(!tabs.some(t=>t[0]===ui.logTab))ui.logTab='mine';
  const body=ui.logTab==='team'?logTeam():ui.logTab==='sheet'?logSheet():logMine();
  return `<div class="phead"><div><div class="eyebrow">Work diary · not a project</div><h1 class="ptitle">Daily log</h1></div><div class="actions">${ui.logTab==='mine'&&logMid()&&canWrite()?`<button class="btn" data-action="book-ahead">Book time ahead</button><button class="btn primary w" data-action="new-log">+ Log entry</button>`:isAdmin()&&canWrite()?`<button class="btn" data-action="book-ahead">Book time ahead</button>`:''}</div></div>
  <div class="seg" style="align-self:flex-start" role="tablist" aria-label="Daily log views">${tabs.map(([k,l])=>`<button class="${ui.logTab===k?'on':''}" data-action="log-tab" data-v="${k}" role="tab" aria-selected="${ui.logTab===k}">${l}</button>`).join('')}</div>${body}`;
}
function logMine(){
  const mid=logMid();
  if(!mid)return `<div class="banner"><span>${role()==='read'?'View only accounts don’t keep a daily log.':'Your login isn’t linked to a team member yet, so there’s no diary to write in. An admin can link it in <b>Admin settings → Users &amp; access</b>.'}</span></div>`;
  const m=S.members.get(mid),hpd=memberCap(m).hpd,hol=holSet(),idx=logIndex(myLogs());
  const mo=logMonthOf(),[yy,mm]=mo.split('-').map(Number),A=monStart(yy,mm-1),B=monStart(yy,mm)-1;
  if(!ui.logDate)ui.logDate=n2d(TODAY);const sel=d2n(ui.logDate);
  const lead=(dow(A)+6)%7;let cells='';for(let i=0;i<lead;i++)cells+='<span class="lcd pad"></span>';
  let tot=0,days=0;const types=new Map();let proj=0,np=0;const miss=new Set(logMissingDays(m,A,B,idx,hol));
  for(let n=A;n<=B;n++){const L=idx.get(n2d(n))||[],hs=sumH(L);if(L.length){tot+=hs;days++;for(const l of L){types.set(logType(l),(types.get(logType(l))||0)+(+l.hours||0));if(l.pid)proj+=+l.hours||0;else np+=+l.hours||0}}
    const wd=isWorkDay(m,n,hol),cls=hs>hpd+0.01?'over':hs>=hpd*0.75?'full':hs>0?'part':miss.has(n)?'miss':!wd?'off':n>TODAY?'fut':'';
    const bk=!L.length&&wd&&n>=TODAY?bookedOn(m,n):0;
    cells+=`<button type="button" class="lcd ${cls} ${bk?'bkd':''} ${n===sel?'sel':''} ${n===TODAY?'today':''}" data-action="log-day" data-d="${n2d(n)}" aria-label="${fmtY(n)}${hs?`, ${fh(hs)} hours logged`:bk?`, ${fh(bk)} hours booked`:miss.has(n)?', nothing logged':''}"><span class="dn">${new Date(n*DAY).getUTCDate()}</span>${hs?`<span class="dh">${fh(hs)}h</span>`:bk?`<span class="dh bk">${fh(bk)}h</span>`:miss.has(n)?'<span class="dm" aria-hidden="true"></span>':''}</button>`}
  const prev=n2d(monStart(yy,mm-2)).slice(0,7),next=n2d(monStart(yy,mm)).slice(0,7);
  const dayL=idx.get(n2d(sel))||[],dh=sumH(dayL);
  let planCard='';{const before=[...idx.keys()].filter(k=>k<n2d(sel)).sort().pop();if(before&&d2n(before)>=sel-7){const pl=idx.get(before).filter(l=>l.plan);if(pl.length)planCard=`<div class="plancard"><div class="lab">Planned on ${fmtY(d2n(before))}</div>${pl.map(l=>`<div class="planrow"><span>${h(l.plan)}</span>${[...S.logs.values()].some(x=>x.fromPlan===l.id)?'<span class="ok small">Logged ✓</span>':canWrite()?`<button type="button" class="btn sm" data-action="new-log" data-plan="${l.id}">Log it</button>`:''}</div>`).join('')}</div>`}}
  const tl=[...types].sort((a,b)=>b[1]-a[1]);
  return `<div class="logwrap"><section class="panel lcal"><div class="panel-h"><button type="button" class="icon-btn" data-action="log-month" data-v="${prev}" aria-label="Previous month">‹</button><h2>${MON[mm-1]} ${yy}</h2><button type="button" class="icon-btn" data-action="log-month" data-v="${next}" aria-label="Next month">›</button></div>
    <div class="lcgrid">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<span class="lcw">${d}</span>`).join('')}${cells}</div>
    <div class="legend"><span><i class="lg-part"></i>Some hours</span><span><i class="lg-full"></i>Full day</span><span><i class="lg-over"></i>Over ${fh(hpd)} h</span><span><i class="lg-miss"></i>Not logged</span><span><i class="lg-bk"></i>Booked ahead</span></div>
    <div class="lsum"><div><b>${fh(tot)} h</b><span>logged this month</span></div><div><b>${days}</b><span>days logged</span></div><div class="${miss.size?'bad':''}"><b>${miss.size}</b><span>working days missing</span></div><div><b>${tot?Math.round(proj/tot*100):0}%</b><span>on projects</span></div></div>
    ${tl.length?`<div class="tbars">${tl.map(([k,v])=>`<div class="tbar"><span>${h(k)}</span><i style="width:${Math.max(4,Math.round(v/tl[0][1]*100))}%"></i><b class="mono">${fh(v)} h</b></div>`).join('')}</div>`:''}</section>
  <section class="panel lday"><div class="panel-h"><h2>${WD[dow(sel)]} ${fmtY(sel)}</h2><span class="muted small">${fh(dh)} h logged${isWorkDay(m,sel,hol)?` of ${fh(hpd)} h`:' · day off'}</span></div>
    ${planCard}${bookCard(m,sel,dayL)}
    <div class="loglist">${dayL.map(l=>logCard(l,false)).join('')||`<div class="empty-note">${sel>TODAY?'This day is still ahead.':'Nothing logged for this day yet.'}</div>`}</div>
    ${sel<=TODAY&&canWrite()?`<button type="button" class="btn w" data-action="new-log" data-d="${n2d(sel)}">+ Log entry for ${fmt(sel)}</button>`:''}
    <p class="hint" style="margin:0">Only you and admins can read your diary. Project leads also see entries linked to their projects. Entries can be changed for 7 days after you write them.</p></section></div>`;
}
// booked time on the selected day: ahead → a reminder; today or past → a pre-filled entry to confirm or adjust
function bookCard(m,n,dayL){const L=bookingsOn(m,n);if(!L.length||!isWorkDay(m,n,holSet()))return '';
  const done=b=>[...S.logs.values()].some(l=>l.bookingId===b.id&&l.date===n2d(n)&&l.mid===m.id);
  const row=b=>{const p=b.pid&&S.projects.get(b.pid);const lab=`${fh(b.hours)} h · ${h(bkLabel(b.type))}${p?` · <span class="mono">${h(p.code||'')}</span>`:''}${b.note?` · ${h(b.note)}`:''}`;
    return `<div class="planrow"><span>${lab}</span>${n>TODAY?'<span class="muted small">Ahead</span>':done(b)?'<span class="ok small">Logged ✓</span>':canWrite()?`<span class="bkbtns"><button type="button" class="btn sm primary" data-action="bk-confirm" data-id="${b.id}" data-d="${n2d(n)}">Confirm</button><button type="button" class="btn sm" data-action="new-log" data-bk="${b.id}" data-d="${n2d(n)}">Adjust</button></span>`:''}</div>`};
  return `<div class="plancard bkcard"><div class="lab">${n>TODAY?'Booked ahead':'Booked for this day · confirm what really happened'}</div>${L.map(row).join('')}</div>`}
const BK2LOG={routine:'Admin',support:'Production support',meeting:'Meeting',training:'Learning',travel:'Other',other:'Other'};
function bkLogData(m,b,date,hours){return {typeOther:b.type==='travel'?'Travel':b.type==='other'?(b.note||'Booked work').slice(0,60):'',by:meKey(),mid:m.id,date,hours,type:BK2LOG[b.type]||'Other',what:b.note||bkLabel(b.type),pid:b.pid||'',taskId:'',result:'',plan:'',createdAt:Date.now(),updatedAt:Date.now(),editedBy:meKey(),fromPlan:'',bookingId:b.id}}
function bkConfirm(id,date){const m=S.members.get(logMid());const b=m&&(m.bookings||[]).find(x=>x.id===id);if(!b)return toast('That booking isn’t there any more.');
  if(d2n(date)>TODAY)return toast('Booked days ahead are confirmed on the day.');
  if([...S.logs.values()].some(l=>l.bookingId===id&&l.date===date&&l.mid===m.id))return toast('Already logged.');
  const others=myLogs().filter(x=>x.date===date&&x.mid===m.id);if(sumH(others)+(+b.hours)>24)return toast('That would be more than 24 hours on one day.');
  const lid=uid('lg'),data=bkLogData(m,b,date,+b.hours);put('logs',lid,data);logH({act:'created',kind:'log',id:lid,title:`${mName(m.id)} · ${fmtY(d2n(date))}`,pid:b.pid||undefined,ch:[`${fh(b.hours)} h · confirmed booking`]});loadCache=null;toast('Logged')}
/* Book time ahead drawer: own bookings (admins can pick anyone) */
function drBook(d){const meM=logMid();const mid=d.mid||meM||(isAdmin()?(workList()[0]||{}).id:'');const m=mid&&S.members.get(mid);
  if(!m)return `${dHead('Daily log','Book time ahead')}<div class="dr-b"><p>Your login isn’t linked to a team member.</p></div>`;
  const today=n2d(TODAY),hpd=memberCap(m).hpd,L=(m.bookings||[]).filter(b=>bkEnd(b)>=today).sort((a,b)=>a.from<b.from?-1:1);
  const row=b=>{const p=b.pid&&S.projects.get(b.pid),started=b.from<today;return `<div class="lvrow"><span class="mono small">${bkWhen(b)}</span><span class="small"><b>${fh(b.hours)} h/day</b> · ${h(bkLabel(b.type))}${p?' · '+h(p.code||p.name):''}${b.note?' · '+h(b.note):''}</span><button type="button" class="linkbtn" data-bkdel="${h(b.id)}">${started?'End now':'Cancel'}</button></div>`};
  return `<form id="f" novalidate>${dHead('Daily log','Book time ahead')}
  <div class="dr-b">
    <div class="rollup">Book non-project work you already know is coming: production support, meetings, training, travel. It takes effect straight away: <b>${fh(hpd)} h</b> productive hours a day minus the booked hours is what is left for project tasks. When a task needs more than is left, the lost hours add up and its end date moves out (linked tasks and the project target follow; stakeholders are told). A full-day booking works like leave. On the day the booking shows in your diary to confirm or adjust.</div>
    ${isAdmin()?`<div class="fld"><label for="bk-who">Team member</label><select id="bk-who">${workList().map(x=>`<option value="${x.id}" ${x.id===m.id?'selected':''}>${h(x.name)}</option>`).join('')}</select></div>`:''}
    <div class="two"><div class="fld"><label for="bk-from">From</label><input type="date" id="bk-from" min="${today}"></div><div class="fld"><label for="bk-to">To</label><input type="date" id="bk-to" min="${today}"></div></div>
    <div class="two"><div class="fld"><label for="bk-h">Hours a day</label><input type="number" id="bk-h" min="0.25" max="24" step="0.25" inputmode="decimal" placeholder="e.g. 3"></div>
    <div class="fld"><label for="bk-type">Type</label><select id="bk-type">${BK_TYPES.map(([k,l])=>`<option value="${k}">${l}</option>`).join('')}</select></div></div>
    <div class="fld"><label for="bk-pid">Project <span class="muted">(optional, e.g. support for a delivered project)</span></label><select id="bk-pid"><option value="">None</option>${projList().map(p=>`<option value="${p.id}">${h((p.code||'')+' '+p.name)}</option>`).join('')}</select></div>
    <div class="fld"><label for="bk-note">Note</label><input type="text" id="bk-note" maxlength="200" placeholder="e.g. Line trial support at plant 2"></div>
    <label class="chk"><input type="checkbox" id="bk-wk"> Repeat every week</label>
    <div class="fld" id="bk-untilf" hidden><label for="bk-until">Repeat until</label><input type="date" id="bk-until" min="${today}"></div>
    <div id="bkWarn"></div>
    <div class="err" id="fErr" hidden></div>
    <div class="fld"><span class="lab">${m.id===meM?'Your':h(m.name)+'’s'} booked time</span><div class="lvlist">${L.length?L.map(row).join(''):'<span class="hint">Nothing booked.</span>'}</div><span class="hint">Past days stay as they were logged in the diary.</span></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary">Book time</button><button type="button" class="btn" data-action="close-drawer">Close</button></div></form>`}
function wireBook(d){const f=$('#bk-from'),t=$('#bk-to'),wk=$('#bk-wk'),uf=$('#bk-untilf'),who=$('#bk-who'),hh=$('#bk-h'),w=$('#bkWarn');
  const mem=()=>S.members.get(who?who.value:(d.mid||logMid()));
  const upd=()=>{const m=mem(),a=d2n(f.value),b=d2n(t.value)??a,x=+hh.value;if(!m||a==null||!(x>0)){w.innerHTML='';return}const hpd=memberCap(m).hpd;
    const c=myLeaveClash(m,a,wk.checked?(d2n($('#bk-until').value)??b):b);
    w.innerHTML=`<div class="${x>=hpd-0.01?'alert':'rollup'}"><span>${x>=hpd-0.01?`A full day (${fh(hpd)} h or more): no project work on these days, like leave.`:`${fh(Math.max(0,hpd-x))} h a day left for project tasks.`}${c.length?` ${c.length} open task${c.length>1?'s':''} in these days may move out.`:''}</span></div>`};
  if(who)who.addEventListener('change',()=>{d.mid=who.value;renderDrawer()});
  f.addEventListener('change',()=>{if(!t.value||d2n(t.value)<d2n(f.value))t.value=f.value;upd()});[t,hh].forEach(e=>e.addEventListener('input',upd));
  wk.addEventListener('change',()=>{uf.hidden=!wk.checked;upd()});$('#bk-until').addEventListener('change',upd);
  $('#drawer').querySelectorAll('[data-bkdel]').forEach(btn=>btn.addEventListener('click',()=>{const m=mem();if(!m)return;const id=btn.dataset.bkdel,today=n2d(TODAY),yest=n2d(TODAY-1);
    const L=(m.bookings||[]).map(b=>{if(b.id!==id)return b;if(b.from>=today)return null;return b.weekly?{...b,until:yest<b.to?b.to:yest}:{...b,to:yest}}).filter(Boolean);
    const b=(m.bookings||[]).find(x=>x.id===id);saveBookings(m,L,`${b&&b.from<today?'Ended':'Cancelled'} booked time${b?' '+bkWhen(b):''}${m.id!==logMid()?' for '+m.name:''}`);renderDrawer()}))}
function saveBookings(m,L,what){put('members',m.id,{...clean(m),bookings:L},{sys:true});logH({act:'changed',kind:'booking',title:what,ch:[]});loadCache=null;toast(what)}
function saveBook(d){const who=$('#bk-who'),m=S.members.get(who?who.value:(d.mid||logMid()));if(!m)return formErr('Pick the team member.');
  if(m.id!==logMid()&&!isAdmin())return formErr('You can only book your own time.');
  const a=$('#bk-from').value,b=$('#bk-to').value||a,hours=Math.round((+$('#bk-h').value)*100)/100,weekly=$('#bk-wk').checked,until=$('#bk-until').value;
  if(!a)return formErr('Pick the first day.');if(a<n2d(TODAY))return formErr('Booked time can’t start in the past. Use the Daily log for work already done.');if(b<a)return formErr('It ends before it starts.');
  if(!(hours>0&&hours<=24))return formErr('Enter the hours a day, between 0.25 and 24.');
  if(weekly){if(!until||until<b)return formErr('Pick a “repeat until” date after the end.');if(d2n(b)-d2n(a)>6)return formErr('A weekly booking covers at most 7 days.')}
  else if(d2n(b)-d2n(a)>180)return formErr('Book at most 180 days at a time.');
  const rec={id:uid('bk'),from:a,to:b,hours,type:$('#bk-type').value,pid:$('#bk-pid').value,note:$('#bk-note').value.trim(),weekly,until:weekly?until:'',by:meKey(),at:Date.now()};
  saveBookings(m,[...(m.bookings||[]),rec],`Booked ${fh(hours)} h/day ${bkLabel(rec.type)}: ${bkWhen(rec)}${m.id!==logMid()?' for '+m.name:''}`);d.mid=m.id;renderDrawer()}
function logTeamFilter(){
  const F=ui.logF||(ui.logF=(()=>{const y=gFy();if(y==null||y===curFy())return {who:'',from:n2d(TODAY-6),to:n2d(TODAY),type:'',pid:''};const [A,B]=fyRange(y);return {who:'',from:n2d(A),to:n2d(Math.min(B,TODAY)),type:'',pid:''}})());
  let L=logsVisible();const a=F.from||'0000',b=F.to||'9999';L=L.filter(l=>l.date>=a&&l.date<=b);
  if(F.who)L=L.filter(l=>l.mid===F.who);if(F.type)L=L.filter(l=>(l.type||'Other')===F.type);if(F.pid)L=L.filter(l=>F.pid==='_np'?!l.pid:l.pid===F.pid);
  return {F,L:L.sort((x,y)=>x.date<y.date?1:x.date>y.date?-1:(y.createdAt||0)-(x.createdAt||0))};
}
function logTeam(){
  const {F,L}=logTeamFilter();const ms=workList();
  const byP=new Map();for(const l of L)byP.set(l.mid,(byP.get(l.mid)||0)+(+l.hours||0));
  const days=new Map();for(const l of L){if(!days.has(l.date))days.set(l.date,[]);days.get(l.date).push(l)}
  const sel=(k,opts)=>`<select class="afsel" data-logf="${k}">${opts}</select>`;
  return `<div class="afbar">${sel('who',`<option value="">Everyone</option>${ms.map(m=>`<option value="${m.id}" ${F.who===m.id?'selected':''}>${h(m.name)}</option>`).join('')}`)}
    <span class="afrange"><input type="date" class="afsel" data-logf="from" value="${h(F.from)}" aria-label="From"><span class="muted">to</span><input type="date" class="afsel" data-logf="to" value="${h(F.to)}" aria-label="To"></span>
    <select class="afsel" id="log-fy" aria-label="Financial year"><option value="">Pick a financial year…</option>${fyChoices().filter(y=>fyRange(y)[0]<=TODAY).map(y=>{const [A,B]=fyRange(y),on=F.from===n2d(A)&&F.to===n2d(Math.min(B,TODAY));return `<option value="${y}" ${on?'selected':''}>${fyLabel(y)}</option>`}).join('')}</select>
    ${sel('type',`<option value="">All types of work</option>${LOG_TYPES.map(t=>`<option ${F.type===t?'selected':''}>${t}</option>`).join('')}`)}
    ${sel('pid',`<option value="">All projects and non-project</option><option value="_np" ${F.pid==='_np'?'selected':''}>Non-project work only</option>${projList().map(p=>`<option value="${p.id}" ${F.pid===p.id?'selected':''}>${h((p.code||'')+' '+p.name)}</option>`).join('')}`)}
    <button type="button" class="btn sm" data-action="log-csv">Export CSV</button></div>
  ${!isAdmin()?'<p class="hint" style="margin:0">You see entries linked to the projects you lead.</p>':''}
  <div class="lpchips">${[...byP].sort((a,b)=>b[1]-a[1]).map(([mid,v])=>`<button type="button" class="lpc ${F.who===mid?'on':''}" data-action="log-who" data-id="${mid}">${av(mid)}<span>${h(mName(mid))}</span><b class="mono">${fh(v)} h</b></button>`).join('')||''}</div>
  ${[...days].map(([d,a])=>`<section class="panel"><div class="panel-h"><h2>${WD[dow(d2n(d))]} ${fmtY(d2n(d))}</h2><span class="muted small">${a.length} entr${a.length===1?'y':'ies'} · ${fh(sumH(a))} h</span></div><div class="loglist">${a.map(l=>logCard(l,true)).join('')}</div></section>`).join('')||'<div class="empty-note">No diary entries match these filters.</div>'}`;
}
function sheetData(){
  const mo=/^\d{4}-\d{2}$/.test(ui.sheetMonth||'')?ui.sheetMonth:n2d(TODAY).slice(0,7),[yy,mm]=mo.split('-').map(Number),A=monStart(yy,mm-1),B=monStart(yy,mm)-1,hol=holSet();
  const days=[];for(let n=A;n<=B;n++)days.push(n);
  const all=logsVisible().filter(l=>l.date>=n2d(A)&&l.date<=n2d(B));
  const rows=workList().map(m=>{const idx=logIndex(all.filter(l=>l.mid===m.id));const v=days.map(n=>sumH(idx.get(n2d(n))||[]));const miss=new Set(logMissingDays(m,A,B,idx,hol));return {m,v,miss,tot:v.reduce((a,b)=>a+b,0),wd:days.map(n=>isWorkDay(m,n,hol))}});
  return {mo,yy,mm,A,B,days,rows};
}
// timesheet for a whole financial year: person × month
function sheetFyData(){const y=+ui.sheetFy,[A,B]=fyRange(y),hol=holSet(),cols=[];for(let k=0;k<12;k++){const a=monStart(y,fyStart()-1+k),[ay,am]=ymdN(a);cols.push({a,b:monStart(ay,am+1)-1,top:MON[am],sub:String(ay)})}
  const all=logsVisible().filter(l=>l.date>=n2d(A)&&l.date<=n2d(B));
  const rows=workList().map(m=>{const L=all.filter(l=>l.mid===m.id),idx=logIndex(L);const v=cols.map(c=>sumH(L.filter(l=>l.date>=n2d(c.a)&&l.date<=n2d(c.b))));const miss=logMissingDays(m,A,Math.min(B,TODAY),idx,hol).length;return {m,v,miss,tot:v.reduce((a,b)=>a+b,0)}});
  return {y,A,B,cols,rows}}
function logSheetFy(){const D=sheetFyData(),dt=D.cols.map((_,i)=>D.rows.reduce((a,r)=>a+r.v[i],0));
  return `<div class="afbar">${sheetFyPick()}<button type="button" class="btn sm" data-action="sheet-csv">Export CSV</button><button type="button" class="btn sm" data-action="sheet-pdf">Export PDF</button><span class="muted small">${fmtY(D.A)} – ${fmtY(D.B)} · hours logged per month</span></div>
  <div class="mxwrap"><table class="mx ts"><thead><tr><th scope="col">Team member</th>${D.cols.map(c=>`<th scope="col"><b>${c.top}</b><span>${c.sub}</span></th>`).join('')}<th scope="col"><b>Total</b><span>hours</span></th><th scope="col"><b>Missing</b><span>days</span></th></tr></thead>
  <tbody>${D.rows.map(r=>`<tr><th scope="row"><span class="mxn">${av(r.m.id)}<span>${h(r.m.name)}</span></span></th>${r.v.map(x=>`<td class="tsd">${x?fh(x):''}</td>`).join('')}<td class="mt"><b>${fh(r.tot)}</b></td><td class="mt ${r.miss?'slip':''}"><b>${r.miss}</b></td></tr>`).join('')}</tbody>
  <tfoot><tr><th scope="row">Month total</th>${dt.map(x=>`<td>${x?fh(x):''}</td>`).join('')}<td><b>${fh(dt.reduce((a,b)=>a+b,0))}</b></td><td></td></tr></tfoot></table></div>`}
const sheetFyPick=()=>`<select class="afsel" id="sheet-fy" aria-label="Month or financial year"><option value="">One month</option>${fyChoices().filter(y=>fyRange(y)[0]<=TODAY).map(y=>`<option value="${y}" ${String(ui.sheetFy||'')===String(y)?'selected':''}>${fyLabel(y)} (by month)</option>`).join('')}</select>`;
function logSheet(){
  if(ui.sheetFy)return logSheetFy();
  const D=sheetData();const dt=D.days.map((_,i)=>D.rows.reduce((a,r)=>a+r.v[i],0));
  return `<div class="afbar">${sheetFyPick()}<input type="month" class="afsel" data-sheet="1" value="${D.mo}" aria-label="Month"><button type="button" class="btn sm" data-action="sheet-csv">Export CSV</button><button type="button" class="btn sm" data-action="sheet-pdf">Export PDF</button>
  <span class="legend"><span><i class="lg-miss"></i>Working day not logged</span><span><i class="lg-off"></i>Weekend, holiday or leave</span></span></div>
  <div class="mxwrap"><table class="mx ts"><thead><tr><th scope="col">Team member</th>${D.days.map(n=>`<th scope="col" class="${isWE(n)?'we':''}"><b>${new Date(n*DAY).getUTCDate()}</b><span>${WD[dow(n)].slice(0,2)}</span></th>`).join('')}<th scope="col"><b>Total</b><span>hours</span></th><th scope="col"><b>Missing</b><span>days</span></th></tr></thead>
  <tbody>${D.rows.map(r=>`<tr><th scope="row"><span class="mxn">${av(r.m.id)}<span>${h(r.m.name)}</span></span></th>${r.v.map((x,i)=>`<td class="tsd ${r.miss.has(D.days[i])?'miss':!r.wd[i]?'off':''}">${x?fh(x):''}</td>`).join('')}<td class="mt"><b>${fh(r.tot)}</b></td><td class="mt ${r.miss.size?'slip':''}"><b>${r.miss.size}</b></td></tr>`).join('')}</tbody>
  <tfoot><tr><th scope="row">Day total</th>${dt.map(x=>`<td>${x?fh(x):''}</td>`).join('')}<td><b>${fh(dt.reduce((a,b)=>a+b,0))}</b></td><td></td></tr></tfoot></table></div>`;
}
function sheetTable(){const r1=x=>Math.round(x*100)/100;
  if(ui.sheetFy){const D=sheetFyData();return {title:`Timesheet - ${fyLabel(D.y)}`,sub:`Hours from the daily log by month · ${fmtY(D.A)} – ${fmtY(D.B)} · exported ${fmtY(TODAY)}`,head:['Team member',...D.cols.map(c=>c.top+' '+c.sub),'Total h','Missing days'],
    rows:D.rows.map(r=>[r.m.name,...r.v.map(r1),r1(r.tot),r.miss]),foot:['Month total',...D.cols.map((_,i)=>r1(D.rows.reduce((a,r)=>a+r.v[i],0))),r1(D.rows.reduce((a,r)=>a+r.tot,0)),''],shade:false}}
  const D=sheetData();
  return {title:`Monthly timesheet - ${MON[D.mm-1]} ${D.yy}`,sub:`Hours from the daily log · exported ${fmtY(TODAY)}`,head:['Team member',...D.days.map(n=>String(new Date(n*DAY).getUTCDate())),'Total h','Missing days'],
    rows:D.rows.map(r=>[r.m.name,...r.v.map(r1),r1(r.tot),r.miss.size]),foot:['Day total',...D.days.map((_,i)=>r1(D.rows.reduce((a,r)=>a+r.v[i],0))),r1(D.rows.reduce((a,r)=>a+r.tot,0)),''],shade:false}}
async function csvSave(lines,fname){const dl=await afDl();if(!dl)return;const esc=v=>`"${String(isoToDmy(v)??'').replace(/"/g,'""')}"`;
  try{await dl.save({filename:fname,data:'﻿'+lines.map(r=>r.map(esc).join(',')).join('\r\n')});toast('CSV saved')}catch(e){if(!(e&&e.code==='declined'))toast('Couldn’t save the file. Try again.')}}
function logCsv(){const {L}=logTeamFilter();csvSave([['Date','Team member','Hours','Type of work','Project code','Project','Task','What was done','Result / blockers','Plan for tomorrow'],...L.map(l=>{const p=l.pid&&S.projects.get(l.pid),t=l.taskId&&S.tasks.get(l.taskId);return [l.date,mName(l.mid),l.hours,logType(l),p?p.code:'',p?p.name:'Non-project work',t?t.title:'',l.what,l.result,l.plan]})],`Daily_log_${n2d(TODAY)}.csv`)}
function sheetCsv(){const T=sheetTable();csvSave([[T.title],[T.sub],[],T.head,...T.rows,T.foot],`Timesheet_${ui.sheetFy?fyLabel(+ui.sheetFy).replace(/\s+/g,'_'):sheetData().mo}.csv`)}
function drLog(d){
  const l=d.id?S.logs.get(d.id):null,ed=canEditLog(l)&&(l||logMid()),v=l||d.draft||{};
  const dis=ed?'':'disabled';const ps=projList();
  const who=l?mName(l.mid):(S.members.get(logMid())||{}).name||'';
  return `<form id="f" novalidate>${dHead(`Daily log · ${h(who)}`,l?'Diary entry':'Log entry')}
  <div class="dr-b">
    ${l&&!ed?`<div class="rollup">${logLocked(l)&&l.by===meKey()?'This entry is locked: entries can be changed for 7 days after they’re written. Ask an admin if it needs a correction.':'You can read this entry but not change it.'}</div>`:''}
    <div class="two"><div class="fld"><label for="l-date">Date</label><input type="date" id="l-date" value="${h(v.date||n2d(TODAY))}" max="${n2d(TODAY)}" ${dis}></div>
    <div class="fld"><label for="l-hours">Hours spent</label><input type="number" id="l-hours" min="0.25" max="24" step="0.25" inputmode="decimal" value="${v.hours??''}" placeholder="e.g. 2.5" ${dis} ${!l?'autofocus':''}></div></div>
    <div class="fld"><label for="l-type">Type of work</label><select id="l-type" ${dis}>${LOG_TYPES.map(t=>`<option ${(v.type||'')===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div class="fld" id="l-otherf" ${v.type==='Other'?'':'hidden'}><label for="l-typeo">Describe the type of work</label><input type="text" id="l-typeo" maxlength="60" value="${h(v.typeOther||'')}" placeholder="e.g. Supplier visit, Patent drafting" ${dis}></div>
    <div class="fld"><label for="l-what">What I did</label><textarea id="l-what" maxlength="2000" placeholder="e.g. Measured read range of the 5 tuned inlays on metal; 3 met spec" ${dis}>${h(v.what||'')}</textarea></div>
    <div class="fld"><label for="l-pid">Linked to <span class="muted">(optional)</span></label><select id="l-pid" ${dis}><option value="">Non-project work</option>${ps.map(p=>`<option value="${p.id}" ${v.pid===p.id?'selected':''}>${h((p.code||'')+' '+p.name)}</option>`).join('')}</select></div>
    <div class="fld" id="l-taskf" ${v.pid?'':'hidden'}><label for="l-task">Task <span class="muted">(optional; its hours count as actual hours on the task)</span></label><select id="l-task" ${dis}>${logTaskOpts(v.pid,v.taskId)}</select></div>
    <div class="fld"><label for="l-res">Result / blockers <span class="muted">(optional)</span></label><textarea id="l-res" maxlength="1000" placeholder="What came out of it, or what is stuck" ${dis}>${h(v.result||'')}</textarea></div>
    <div class="fld"><label for="l-plan">Plan for tomorrow <span class="muted">(optional)</span></label><textarea id="l-plan" maxlength="1000" placeholder="Shows on your next day so you can tick it off" ${dis}>${h(v.plan||'')}</textarea></div>
    <div class="err" id="fErr" hidden></div>
    ${l?`<p class="hint" style="margin:0">Written ${fmtTs(l.createdAt)}${l.updatedAt&&l.updatedAt!==l.createdAt?` · last changed ${fmtTs(l.updatedAt)}${l.editedBy&&l.editedBy!==l.by?' by '+h(pName(l.editedBy)):''}`:''}</p>`:''}
  </div>
  <div class="dr-f">${ed?`<button type="submit" class="btn primary w">${l?'Save changes':'Save entry'}</button>`:''}<button type="button" class="btn" data-action="close-drawer">${ed?'Cancel':'Close'}</button>${l&&ed?`<span class="spacer"></span><button type="button" class="btn danger" data-action="log-delete" data-id="${l.id}" data-two="Click again to delete">Delete</button>`:''}</div></form>`;
}
function logTaskOpts(pid,sel){if(!pid)return '<option value="">—</option>';const m=model(pid),mid=logMid();const L=m.flat.map(id=>m.info.get(id)).filter(I=>I&&I.leaf);
  L.sort((a,b)=>((b.t.assignee===mid)-(a.t.assignee===mid)));return `<option value="">No specific task</option>${L.map(I=>`<option value="${I.t.id}" ${sel===I.t.id?'selected':''}>${h(I.wbs+' '+I.t.title)}${I.t.assignee===mid?' (mine)':''}${I.status==='done'?' · done':''}</option>`).join('')}`}
function wireLog(){const ty=$('#l-type');if(ty)ty.addEventListener('change',()=>{const o=$('#l-otherf');o.hidden=ty.value!=='Other';if(!o.hidden)$('#l-typeo').focus()});const ps=$('#l-pid');if(ps)ps.addEventListener('change',()=>{$('#l-taskf').hidden=!ps.value;$('#l-task').innerHTML=logTaskOpts(ps.value,'')})}
function saveLog(d){
  const l=d.id?S.logs.get(d.id):null;if(!canEditLog(l))return formErr('You can’t change this entry.');
  const mid=l?l.mid:logMid();if(!mid)return formErr('Your login isn’t linked to a team member.');
  const date=$('#l-date').value,hours=Math.round((+$('#l-hours').value)*100)/100,what=$('#l-what').value.trim();
  if(!d2n(date))return formErr('Pick the date.');if(d2n(date)>TODAY)return formErr('The date can’t be in the future.');
  if(!(hours>0&&hours<=24))return formErr('Enter the hours spent, between 0.25 and 24.');
  if(!what)return formErr('Describe what you did.');
  const others=myLogs().filter(x=>x.date===date&&x.mid===mid&&(!l||x.id!==l.id));if(sumH(others)+hours>24)return formErr('That would be more than 24 hours on one day.');
  const typ=$('#l-type').value,typeOther=typ==='Other'?$('#l-typeo').value.trim():'';if(typ==='Other'&&!typeOther)return formErr('Describe the type of work.');
  const pid=$('#l-pid').value,data={typeOther,by:l?l.by:meKey(),mid,date,hours,type:$('#l-type').value,what,pid,taskId:pid?$('#l-task').value:'',result:$('#l-res').value.trim(),plan:$('#l-plan').value.trim(),
    createdAt:l?l.createdAt:Date.now(),updatedAt:Date.now(),editedBy:meKey(),fromPlan:l?l.fromPlan||'':d.fromPlan||'',bookingId:l?l.bookingId||'':d.bookingId||''};
  const id=l?l.id:uid('lg');const ch=[];
  if(l){if(l.date!==date)ch.push(`Date: ${fmtY(d2n(l.date))} → ${fmtY(d2n(date))}`);if(+l.hours!==hours)ch.push(`Hours: ${fh(l.hours)} → ${fh(hours)}`);if(logType(l)!==logType(data))ch.push(`Type: ${logType(l)} → ${logType(data)}`);if((l.pid||'')!==pid)ch.push('Linked project changed');if(l.what!==what||l.result!==data.result||l.plan!==data.plan)ch.push('Text changed')}
  else ch.push(`${fh(hours)} h · ${logType(data)}`);
  put('logs',id,data);logH({act:l?'edited':'created',kind:'log',id,title:`${mName(mid)} · ${fmtY(d2n(date))}`,pid:pid||undefined,ch});
  ui.logDate=date;ui.logMonth=date.slice(0,7);closeDrawer();toast(l?'Entry updated':'Logged');
}
function deleteLog(id){const l=S.logs.get(id);if(!l||!canEditLog(l))return;closeDrawer();del('logs',id);logH({act:'deleted',kind:'log',id,title:`${mName(l.mid)} · ${fmtY(d2n(l.date))}`,pid:l.pid||undefined,ch:[`${fh(l.hours)} h · ${logType(l)}`]});toast('Entry deleted')}
function taskActual(tid){const L=[...S.logs.values()].filter(l=>l.taskId===tid&&canSeeLog(l));return {h:sumH(L),n:L.length}}

/* ---------- backup, export & restore ---------- */
const BK_COLS=['members','projects','tasks','updates','logs','skills','calendar','files','access','history'];
const BK_RESTORE=['members','projects','tasks','updates','logs','skills','calendar','files','history','access','creds','pwvault','memberlogin'];
const BK_LOGINS=['creds','pwvault','memberlogin'];
const bkWithPw=()=>{const c=$('#bk-pw');return c?c.checked:ui.bkPw!==false};
const BK_LABEL={members:'Team members',projects:'Projects',tasks:'Tasks',updates:'Follow-up updates',logs:'Daily log entries',skills:'Skills',calendar:'Calendar',files:'Document records',access:'Account roles',history:'History',creds:'User logins',pwvault:'Saved passwords',memberlogin:'Prepared logins'};
const isServer=()=>!!window.__plannerSync;
let srvBk=null,srvBkAt=0,bkBusy=false;
async function loadSrvBk(force){if(!isServer()||!isAdmin())return;if(!force&&Date.now()-srvBkAt<60000)return;srvBkAt=Date.now();try{const r=await fetch('/api/backup',{cache:'no-store'});srvBk=r.ok?await r.json():{error:'Couldn’t read the backup status.'}}catch(e){srvBk={error:'Couldn’t reach the server.'}}schedule()}
const lastExport=()=>S.settings.get('lastexport')||null;
const agoDays=t=>t?Math.floor((Date.now()-t)/DAY):null;
function backupBanner(){
  if(!isAdmin()||mode!=='live')return '';
  if(isServer()){loadSrvBk();if(!srvBk)return '';const L=srvBk.last,d=L?agoDays(L.at):null;
    if(srvBk.error||d==null||d>=2)return `<div class="banner bad"><span><b>Automatic backup ${srvBk.error?'isn’t working':d==null?'hasn’t run yet':`last ran ${d} days ago`}.</b> ${srvBk.error?h(srvBk.error):'Open Backup to run one now.'}</span><span class="spacer"></span><button class="btn w" data-action="go-backup">Open Backup</button></div>`;return ''}
  const e=lastExport(),d=e?agoDays(e.at):null;if(d!=null&&d<7)return '';
  return `<div class="banner"><span><b>${d==null?'No full backup has been saved yet.':`Last full backup was ${d} days ago.`}</b> Save one every week and keep it outside this planner.</span><span class="spacer"></span><button class="btn w" data-action="bk-json">Save backup now</button></div>`;
}
function bkData(withPw){const out={};for(const c of [...BK_COLS,...(withPw?BK_LOGINS:[])]){const m={};for(const [id,d] of S[c]){const x={...d};delete x.id;if(c==='logs'&&!canSeeLog(d))continue;m[id]=x}out[c]=m}return out}
function markExport(kind){put('settings','lastexport',{at:Date.now(),by:meKey(),kind},{sys:true})}
async function bkJson(){const dl=await afDl();if(!dl)return;const withPw=bkWithPw();
  const data={app:'RFID R&D Planner',format:1,exportedAt:new Date().toISOString(),exportedBy:pName(meKey()),withLogins:withPw,collections:bkData(withPw)};
  const n=Object.values(data.collections).reduce((a,m)=>a+Object.keys(m).length,0);
  try{await dl.save({filename:`RFID_Planner_backup_${n2d(TODAY)}.json`,data:new Blob([JSON.stringify(data,null,1)],{type:'application/json'})});markExport('json');logH({act:'exported',kind:'backup',title:'Full backup (JSON)',ch:[`${n} items`,withPw?'with user logins and passwords':'without passwords']});toast('Backup saved')}catch(e){if(!(e&&e.code==='declined'))toast('Couldn’t save the backup. Try again.')}}
let xlsxP=null;
function loadXlsx(){if(window.XLSX)return Promise.resolve();if(window.__loadXlsx)return window.__loadXlsx();return xlsxP||(xlsxP=new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=()=>res();s.onerror=()=>{xlsxP=null;rej(new Error('load'))};document.head.appendChild(s)}))}
const dY=s=>{const n=d2n(s);return n==null?'':n2d(n)};
function bkSheets(withPw){
  const fy=gFy()!=null?gFy():ui.bkFy===''||ui.bkFy==null?null:+ui.bkFy,[FA,FB]=fy!=null?fyRange(fy):[-Infinity,Infinity];
  const pIn=p=>fy==null||(!!p&&!!p.id&&projInFy(p,fy)),dIn=n=>n!=null&&n>=FA&&n<=FB;
  const ST={todo:'Not started',active:'In progress',blocked:'Blocked',done:'Done'};
  const P=[['Code','Project','Status','Priority','Project lead','Customer','End customer','Expected volume','Introducer','Introduced on','Sales person','Start','Target','Progress %','Work items','Open','Overdue','Technical summary','Reference product','Additional technical inputs','Description']];
  const T=[['Project code','Project','WBS','Task','Level','Owner','Required skill','Effort','Unit','Start','End','Status','Progress %','Overdue','Depends on (WBS)','Actual hours (daily log)','Follow-up every (days)','Notes']];
  for(const p of [...S.projects.values()].filter(x=>canSeeProject(x.id)&&pIn(x)).sort((a,b)=>String(a.code||'').localeCompare(String(b.code||'')))){
    const m=model(p.id);let open=0,over=0;for(const id of m.leaves){const I=m.info.get(id);if(I.status!=='done'){open++;if(I.e<TODAY)over++}}
    P.push([p.code||'',p.name,PSTATUS[p.status]||p.status||'',prioTxt(p),p.owner?mName(p.owner):'',p.customerName||'',p.endCustomer||'',p.volume||'',personTxt(p.assignedBy)||'',dY(p.assignedOn),personTxt(p.salesPerson)||'',dY(p.start)||(isFinite(m.s)?n2d(m.s):''),dY(p.target),m.prog,m.leaves.length,open,over,p.techSummary||'',p.refProduct||'',p.techInputs||'',p.description||'']);
    for(const id of m.flat){const I=m.info.get(id),t=I.t,a=taskActual(id);
      T.push([p.code||'',p.name,I.wbs,t.title,(I.wbs.match(/\./g)||[]).length+1,mName(t.assignee),t.skill?skillName(t.skill):'',t.effort===''||t.effort==null?'':+t.effort,t.effortUnit==='d'?'days':'hours',isFinite(I.s)?n2d(I.s):'',isFinite(I.e)?n2d(I.e):'',ST[I.status]||I.status,I.prog,I.status!=='done'&&I.e<TODAY?'Yes':'',(t.deps||[]).map(x=>(m.info.get(x)||{}).wbs).filter(Boolean).join(', '),a.n?Math.round(a.h*100)/100:'',t.fu===''||t.fu==null?'':t.fu,t.notes||''])}}
  const U=[['Date','Time','Project code','Project','Task','Owner','Event','Event from','Event to','Remarks','Progress %','Updated by']];
  for(const u of [...S.updates.values()].filter(u=>canSeeProject(u.pid)&&dIn(dayOf(u.t))).sort((a,b)=>b.t-a.t)){const t=S.tasks.get(u.taskId),p=S.projects.get(u.pid)||{},d=new Date(u.t);U.push([n2d(dayOf(u.t)),d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),p.code||'',p.name||'',t?t.title:'(deleted task)',t?mName(t.assignee):'',u.event||'',u.evFrom||'',u.evFrom?(u.evTo||u.evFrom):'',u.remarks||'',u.progress,pName(u.by)])}
  const L=[['Date','Team member','Hours','Type of work','Project code','Project','Task','What was done','Result / blockers','Plan for tomorrow']];
  for(const l of logsVisible().filter(l=>dIn(d2n(l.date))).sort((a,b)=>a.date<b.date?1:-1)){const p=l.pid&&S.projects.get(l.pid),t=l.taskId&&S.tasks.get(l.taskId);L.push([l.date,mName(l.mid),+l.hours,logType(l),p?p.code:'',p?p.name:'Non-project work',t?t.title:'',l.what||'',l.result||'',l.plan||''])}
  const M=[['Name','Role','Email','User type','Hours per day','Working days','Skills (★ = expert)']];
  for(const m of memberList())M.push([m.name,m.role||'',m.email||'',isViewOnly(m)?'View only':m.accessType==='admin'?'Admin':'Read & write',memberCap(m).hpd,memberCap(m).wd.map(d=>WD[d]).join(' '),Object.entries(m.skills||{}).filter(([k,v])=>v&&S.skills.has(k)).map(([k,v])=>skillName(k)+(v==='expert'?' ★':'')).join(', ')]);
  const F=[['Project code','Project','File','Category','Revision','Status','Related task','Uploaded by','Uploaded on','Size (KB)','SHA-256']];
  for(const f of [...S.files.values()].filter(f=>canSeeProject(f.projectId)&&pIn(S.projects.get(f.projectId))).sort((a,b)=>(b.at||0)-(a.at||0))){const p=S.projects.get(f.projectId)||{},t=f.taskId&&S.tasks.get(f.taskId);F.push([p.code||'',p.name||'',f.name||'',f.category==='Other'&&f.categoryOther?'Other: '+f.categoryOther:(f.category||''),f.rev||'',f.status||'',t?t.title:'',pName(f.by),f.at?n2d(dayOf(f.at)):'',f.size?Math.round(f.size/1024):'',f.sha256||''])}
  const H=[['Date','Time','Who','What','Changes']];const tmp=document.createElement('div');
  for(const e of allHist().filter(e=>dIn(dayOf(e.t))).slice(0,3000)){tmp.innerHTML=hSentence(e);const d=new Date(e.t);H.push([n2d(dayOf(e.t)),d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),pName(e.by),tmp.textContent.trim(),(e.ch||[]).join(' | ')])}
  const MS=[['Project code','Project','Task','Task owner','No.','Milestone','Target date','Status','Completed on','Completed by','Task progress %']];
  for(const p of [...S.projects.values()].filter(x=>canSeeProject(x.id)&&pIn(x))){const m=model(p.id);for(const id of m.flat){const I=m.info.get(id),Lm=msList(I.t);Lm.forEach((x,k)=>MS.push([p.code||'',p.name,`${I.wbs} ${I.t.title}`,mName(I.t.assignee),k+1,x.name,x.due||'',x.done?'Completed':msOver(x)?'Overdue':'Open',x.doneAt?n2d(dayOf(x.doneAt)):'',x.done?pName(x.doneBy):'',msProg(I.t)]))}}
  const sh=[['Projects',P],['Tasks',T],['Milestones',MS],['Follow-ups',U],['Daily log',L],['Team',M],['Documents',F],['History',H]];
  if(withPw){const A=[['Name','Login ID','Account type','Status','Team member','Email','Password','Password set on']];const seen=new Set();
    for(const [uid,a] of S.access){const m=a.memberId&&S.members.get(a.memberId),c=S.creds.get(uid),v=S.pwvault.get(uid);seen.add(a.memberId);
      A.push([m?m.name:pName(uid),c?c.loginId:'',ROLE[a.role]||a.role||'',a.disabled?'Disabled':'Enabled',m?m.name:'',m&&m.email||'',v&&v.pw?v.pw:(c?'(not stored – set again in Users & access)':''),c&&c.setAt?n2d(dayOf(c.setAt)):''])}
    for(const [mid,ml] of S.memberlogin){if(seen.has(mid))continue;const m=S.members.get(mid);A.push([m?m.name:'',ml.loginId||'',m&&m.accessType?ROLE[m.accessType]:'Read & write',m&&m.accessDisabled?'Disabled':'Prepared (not joined yet)',m?m.name:'',m&&m.email||'',ml.pw||'',ml.setAt?n2d(dayOf(ml.setAt)):''])}
    sh.splice(6,0,['Users & logins',A])}
  return sh;
}
async function bkExcel(){const dl=await afDl();if(!dl)return;
  try{await loadXlsx()}catch(e){return toast('Couldn’t load the Excel maker. Check the internet connection and try again.')}
  const X=window.XLSX,wb=X.utils.book_new(),withPw=bkWithPw();
  const XL0=Date.UTC(1899,11,30)/DAY;
  for(const [name,rows] of bkSheets(withPw)){const ws=X.utils.aoa_to_sheet(rows);for(const k in ws){const c=ws[k];if(k[0]!=='!'&&c&&c.t==='s'&&/^\d{4}-\d{2}-\d{2}$/.test(c.v)&&!/^[A-Z]+1$/.test(k)){const n=d2n(c.v);if(n!=null){c.t='n';c.v=n-XL0;c.z='dd/mm/yyyy';delete c.w}}}ws['!cols']=rows[0].map((_,i)=>({wch:Math.min(48,Math.max(10,...rows.slice(0,200).map(r=>String(r[i]??'').length)))}));ws['!freeze']={xSplit:0,ySplit:1};if(rows.length>1)ws['!autofilter']={ref:X.utils.encode_range({s:{r:0,c:0},e:{r:rows.length-1,c:rows[0].length-1}})};X.utils.book_append_sheet(wb,ws,name)}
  const out=X.write(wb,{bookType:'xlsx',type:'array'});
  try{await dl.save({filename:`RFID_Planner_export_${gFy()!=null?fyLabel(gFy()).replace(/\s+/g,'_')+'_':ui.bkFy?fyLabel(+ui.bkFy).replace(/\s+/g,'_')+'_':''}${n2d(TODAY)}.xlsx`,data:new Blob([out],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})});markExport('excel');logH({act:'exported',kind:'backup',title:'Excel export'+(ui.bkFy?' · '+fyLabel(+ui.bkFy):''),ch:[withPw?'with user logins and passwords':'without passwords']});toast('Excel file saved')}catch(e){if(!(e&&e.code==='declined'))toast('Couldn’t save the file. Try again.')}}
async function bkPick(file){
  if(!file)return;if(file.size>40*1024*1024)return toast('That file is too large to be a planner backup.');
  let j;try{j=JSON.parse(await file.text())}catch(e){ui.bkPlan={err:'This isn’t a planner backup file (it couldn’t be read as JSON).'};return render()}
  if(!j||j.app!=='RFID R&D Planner'||!j.collections){ui.bkPlan={err:'This file wasn’t made by “Save full backup” in this planner.'};return render()}
  const rows=BK_RESTORE.map(c=>{const m=j.collections[c]||{};let add=0,chg=0,same=0;for(const [id,d] of Object.entries(m)){const cur=S[c].get(id);if(!cur)add++;else{const x={...cur};delete x.id;JSON.stringify(x)===JSON.stringify(d)?same++:chg++}}return {c,add,chg,same}}).filter(r=>r.add+r.chg+r.same);
  ui.bkPlan={name:file.name,at:j.exportedAt,by:j.exportedBy,rows,data:j.collections};render();
}
async function bkRestore(){
  const pl=ui.bkPlan;if(!pl||!pl.rows||bkBusy||!isAdmin())return;const over=!!($('#bk-over')&&$('#bk-over').checked);
  if(isServer())return bkRestoreServer(pl,over);
  const jobs=[];for(const r of pl.rows){if(r.c==='files'||r.c==='history')continue;const m=pl.data[r.c]||{};for(const [id,d] of Object.entries(m)){const cur=S[r.c].get(id);if(cur&&!over)continue;if(cur){const x={...cur};delete x.id;if(JSON.stringify(x)===JSON.stringify(d))continue}jobs.push([r.c,id,d])}}
  const fileRecs=isServer()&&pl.rows.some(r=>r.c==='files'&&r.add)?Object.fromEntries(Object.entries(pl.data.files||{}).filter(([id])=>!S.files.has(id))):null;
  if(!jobs.length&&!fileRecs){toast('Nothing to restore: everything in the backup is already here.');return}
  bkBusy=true;let done=0;const order=['skills','calendar','members','access','creds','pwvault','memberlogin','projects','tasks','updates','logs'];jobs.sort((a,b)=>order.indexOf(a[0])-order.indexOf(b[0]));
  const srv=isServer(),acc=pl.data.access||{},cr=pl.data.creds||{};
  for(const [c,id,d] of jobs){
    if(srv&&BK_LOGINS.includes(c)){
      // On the server, logins are recreated from the saved password through the team member they belong to.
      if(c==='pwvault'&&d&&d.pw){const a=acc[id]||S.access.get(id),cc=cr[id];if(a&&a.memberId&&cc&&cc.loginId&&id!==ME.id)await put('memberlogin',a.memberId,{loginId:cc.loginId,loginKey:String(cc.loginId).toLowerCase(),pw:d.pw,setAt:Date.now(),setBy:meKey()},{sys:true})}
      else if(c==='memberlogin'&&d&&d.pw)await put('memberlogin',id,d,{sys:true});
    }else if(!(c==='access'&&id===ME.id))await put(c,id,d,{sys:true});
    done++;if(done%20===0)toast(`Restoring… ${done} of ${jobs.length}`)}
  let docTxt='';
  if(fileRecs){try{const r=await fetch('/api/backup/documents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({records:fileRecs})});const j=await r.json().catch(()=>({}));
    if(r.ok)docTxt=` · ${j.recordsAdded} document record${j.recordsAdded===1?'':'s'} back${j.missingFile?`; ${j.missingFile} need${j.missingFile===1?'s':''} the file from a documents ZIP`:''}`;else docTxt=' · document records not restored: '+(j.error||'server error')}catch(e){docTxt=' · document records not restored'}}
  bkBusy=false;logH({act:'restored',kind:'backup',title:`From ${pl.name}`,ch:[`${jobs.length} items ${over?'added or replaced':'added'}${docTxt}`]});ui.bkPlan=null;toast(`Restored ${jobs.length} item${jobs.length===1?'':'s'}${docTxt}`);render();
}
// On the server the whole backup goes back in one step, exactly as saved (Completed / Aborted projects,
// their status history and frozen tasks included), and the result is checked item by item.
async function bkRestoreServer(pl,over){
  bkBusy=true;toast('Restoring…');render();
  let res=null,err='';
  try{const r=await fetch('/api/backup/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({collections:pl.data,overwrite:over})});res=await r.json().catch(()=>null);if(!r.ok||!res||!res.ok)err=(res&&(res.error||res.message))||'The server couldn’t restore this file.'}
  catch(e){err='Couldn’t reach the server. Nothing was changed.'}
  let docTxt='';const fileRecs=!err&&pl.rows.some(r=>r.c==='files'&&r.add)?Object.fromEntries(Object.entries(pl.data.files||{}).filter(([id])=>!S.files.has(id))):null;
  if(fileRecs){try{const r=await fetch('/api/backup/documents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({records:fileRecs})});const j=await r.json().catch(()=>({}));
    docTxt=r.ok?`${j.recordsAdded} document record${j.recordsAdded===1?'':'s'} back${j.missingFile?`; ${j.missingFile} need${j.missingFile===1?'s':''} the file from a documents ZIP`:''}`:'document records not restored: '+(j.error||'server error')}catch(e){docTxt='document records not restored'}}
  try{window.__plannerSync&&await window.__plannerSync()}catch(e){}
  bkBusy=false;
  if(err){ui.bkPlan={...pl,result:{error:err}};render();return toast(err)}
  const R=res.results||{},tot=k=>Object.values(R).reduce((a,x)=>a+(x[k]||0),0),added=tot('added'),repl=tot('replaced');
  // check: every item of the file is now here
  const missing=[];for(const c of ['members','projects','tasks','updates','logs','skills','calendar']){const n=Object.keys(pl.data[c]||{}).filter(id=>!S[c].has(id)).length;if(n)missing.push(`${n} ${BK_LABEL[c].toLowerCase()}`)}
  const lines=Object.entries(R).filter(([c,x])=>x.added||x.replaced||x.skipped).map(([c,x])=>`${c==='logins'?'User logins':BK_LABEL[c]||c}: ${x.added} added${x.replaced?`, ${x.replaced} replaced`:''}${x.skipped?(c==='logins'?`, ${x.skipped} not restored (see below)`:`, ${x.skipped} kept as they are here`):''}`);
  logH({act:'restored',kind:'backup',title:`From ${pl.name}`,ch:[`${added} added${repl?`, ${repl} replaced`:''}`,...(docTxt?[docTxt]:[]),...(res.notes||[])]});
  ui.bkPlan={name:pl.name,result:{lines,notes:[...(res.notes||[]),...(docTxt?[docTxt]:[])],missing,added,repl}};loadCache=null;anaCache=null;render();
  toast(missing.length?`Restore finished, but ${missing.join(', ')} didn’t come back`:`Restored ${added+repl} item${added+repl===1?'':'s'}`);
}
/* documents (attachments): download all or one project as ZIP, restore from such a ZIP */
function docsBkPanel(){const ps=[...S.projects.values()].sort((a,b)=>String(a.code||a.name).localeCompare(String(b.code||b.name)));
  const pid=ui.bkDocPid&&S.projects.has(ui.bkDocPid)?ui.bkDocPid:'';const n=[...S.files.values()].filter(f=>!pid||f.projectId===pid).length;const R=ui.bkDocRes;
  return `<section class="panel"><div class="panel-h"><h2>Documents (attachments)</h2></div>
    <p class="hint" style="margin:0">Download the uploaded files together with their details (category, revision, remarks, who and when) as one ZIP, and keep it with your backups.</p>
    <div class="bkacts"><select id="bk-docpid" aria-label="Which project"><option value="">All projects</option>${ps.map(p=>`<option value="${p.id}" ${p.id===pid?'selected':''}>${h(p.code||'')} · ${h(p.name)}</option>`).join('')}</select>
    <a class="btn primary" href="/api/backup/documents${pid?`?pid=${encodeURIComponent(pid)}`:''}" download data-docdl>Download documents (.zip)</a><span class="muted small" style="align-self:center">${n} document${n===1?'':'s'}</span></div>
    <div class="fld" style="margin-top:6px"><span class="lab">Restore documents</span>
      <label class="btn bkfile" style="align-self:flex-start">${bkDocBusy?'Restoring…':'Choose documents ZIP…'}<input type="file" accept=".zip,application/zip" id="bk-docs" hidden ${bkDocBusy?'disabled':''}></label>
      <span class="hint">On a new planner, restore the full backup (.json) first, then this ZIP. Adds back files and their details that are missing here. Nothing is overwritten or deleted; each file is checked against its saved fingerprint.</span></div>
    ${R?`<div class="banner ${R.error?'bad':''}"><span>${R.error?h(R.error):`<b>${R.filesWritten}</b> file${R.filesWritten===1?'':'s'} and <b>${R.recordsAdded}</b> record${R.recordsAdded===1?'':'s'} restored from ${h(R.name)} · ${R.alreadyHere} already here${R.noProject?` · ${R.noProject} skipped because their project isn’t in this planner. <b>Restore the full backup (.json) first, then this ZIP.</b>`:''}${R.missingFile?` · ${R.missingFile} missing from the ZIP`:''}${R.badFile?` · ${R.badFile} damaged (fingerprint didn’t match)`:''}`}</span></div>`:''}
  </section>`}
let bkDocBusy=false;
async function bkDocsRestore(file){if(!file||bkDocBusy||!isAdmin())return;bkDocBusy=true;ui.bkDocRes=null;render();
  try{const fd=new FormData();fd.append('file',file);const r=await fetch('/api/backup/documents',{method:'POST',body:fd});const j=await r.json().catch(()=>({}));
    ui.bkDocRes=r.ok?{...j,name:file.name}:{error:j.error||'Restore failed.'};
    if(r.ok)logH({act:'restored',kind:'backup',title:`Documents from ${file.name}`,ch:[`${j.filesWritten} files and ${j.recordsAdded} records restored`,`${j.alreadyHere} already here`]})}
  catch(e){ui.bkDocRes={error:'Restore failed. Check the connection and try again.'}}
  bkDocBusy=false;render()}
function viewBackup(){
  const e=lastExport(),srv=isServer();if(srv)loadSrvBk();
  const pl=ui.bkPlan;const fmtSz=b=>b>1048576?(b/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b/1024))+' KB';
  return `<div class="bkgrid">
  <section class="panel"><div class="panel-h"><h2>Export everything</h2></div>
    <p class="hint" style="margin:0">Save a copy of all planner data and keep it outside the planner (company drive, NAS or email).</p>
    <label class="chk bkpw"><input type="checkbox" id="bk-pw" ${ui.bkPw===false?'':'checked'}> Include user details, login IDs and passwords</label>
    <p class="hint warnline" style="margin:0">With this ticked, anyone who gets the file can sign in as any team member. Keep it somewhere only admins can open.</p>
    <div class="bkacts"><button type="button" class="btn primary w" data-action="bk-json">Save full backup (.json)</button><button type="button" class="btn w" data-action="bk-excel">Download Excel (.xlsx)</button></div>
    <div class="fybar"><label for="bk-fy" class="muted small">Excel covers</label><select id="bk-fy" class="afsel" ${gFy()!=null?'disabled title="Follows the year you chose; pick All years to change it"':''}><option value="">All years</option>${fyChoices().map(y=>`<option value="${y}" ${String(gFy()!=null?gFy():ui.bkFy||'')===String(y)?'selected':''}>${fyLabel(y)}</option>`).join('')}</select><span class="muted small">A year gives the projects running in it, with their tasks and milestones, and the follow-ups, daily log and history dated in it. The full backup (.json) always has everything.</span></div>
    <ul class="bklist"><li><b>Full backup (.json)</b>: every project, task, follow-up, daily log entry, team member, skill, calendar, document record and history entry. Use it to restore below.</li>
    <li><b>Excel</b>: the same data as readable sheets (Projects, Tasks, Follow-ups, Daily log, Team, Users &amp; logins, Documents, History) for reports and audits.</li>
    <li><b>Users &amp; logins</b> (when ticked): name, login ID, account type, enabled or disabled, linked team member, email and password. Passwords that were only imported as fingerprints show “not stored”.</li>
    <li>The email account password is never included.${srv?' Document files themselves are saved with “Download documents (.zip)” and the server backup.':' Uploaded document files stay in the planner; the backup lists them with their fingerprints.'}</li></ul>
    <div class="bkstat">${e?`Last saved ${fmtTs(e.at)} by ${h(pName(e.by))} (${e.kind==='excel'?'Excel':'full backup'})`:'No backup or export has been saved yet.'}</div></section>
  ${srv?`<section class="panel"><div class="panel-h"><h2>Automatic server backup</h2><button type="button" class="btn sm" data-action="bk-now" ${bkBusy?'disabled':''}>Back up now</button></div>
    ${!srvBk?'<div class="empty-note">Checking…</div>':srvBk.error?`<div class="banner bad"><span>${h(srvBk.error)}</span></div>`:`
    <p class="hint" style="margin:0">The server copies the whole database once a day, keeps the last ${srvBk.keep} copies, and copies new documents. Folder: <span class="mono">${h(srvBk.dir)}</span></p>
    <div class="bkstat">${srvBk.last?`Last backup ${fmtTs(srvBk.last.at)} · ${fmtSz(srvBk.last.size)}`:'No backup yet; the first one runs a minute after the server starts.'}</div>
    <div class="alist">${(srvBk.backups||[]).slice(0,10).map(b=>`<div class="bkrow"><span class="mono">${h(b.name)}</span><span class="muted small">${fmtSz(b.size)}</span><a class="btn sm" href="/api/backup/download?name=${encodeURIComponent(b.name)}" download>Download</a></div>`).join('')}</div>
    <p class="hint" style="margin:0">Download a copy now and then and keep it on another drive: a backup on the same disk doesn’t survive a disk failure.</p>`}</section>`:''}
  ${srv?docsBkPanel():''}
  <section class="panel"><div class="panel-h"><h2>Restore from a backup</h2></div>
    <p class="hint" style="margin:0">Choose a <b>.json</b> file saved with “Save full backup”. You’ll see what it contains before anything changes. Nothing is ever deleted by a restore.</p>
    <label class="btn w bkfile">Choose backup file…<input type="file" accept=".json,application/json" id="bk-file" hidden></label>
    ${pl&&pl.err?`<div class="banner bad"><span>${h(pl.err)}</span></div>`:''}
    ${pl&&pl.result?(pl.result.error?`<div class="banner bad"><span><b>Restore failed.</b> ${h(pl.result.error)}</span></div>`:`<div class="banner ${pl.result.missing.length?'bad':''}"><span><b>${pl.result.missing.length?'Restore finished with gaps':'Restore complete'}</b> from ${h(pl.name)}: ${pl.result.added} added${pl.result.repl?`, ${pl.result.repl} replaced`:''}.${pl.result.missing.length?` Not here after the restore: ${h(pl.result.missing.join(', '))}.`:' Every project, task and entry in the file is here.'}<br><span class="small">${pl.result.lines.map(h).join(' · ')}${pl.result.notes.length?'<br>'+pl.result.notes.map(h).join(' · '):''}</span></span><span class="spacer"></span><button type="button" class="btn sm" data-action="bk-cancel">Close</button></div>`):''}
    ${pl&&pl.rows?`<div class="bkplan"><div><b>${h(pl.name)}</b> <span class="muted small">saved ${pl.at?fmtTs(Date.parse(pl.at)):'—'}${pl.by?' by '+h(pl.by):''}</span></div>
      <table class="ptab"><thead><tr><th>Data</th><th class="n">Missing here</th><th class="n">Different here</th><th class="n">Same</th></tr></thead><tbody>${pl.rows.map(r=>`<tr><td>${BK_LABEL[r.c]}</td><td class="n">${r.add}</td><td class="n">${r.chg}</td><td class="n">${r.same}</td></tr>`).join('')}</tbody></table>
      <label class="chk"><input type="checkbox" id="bk-over"> Also replace items that are different here with the backup version</label>
      <div class="bkacts"><button type="button" class="btn primary w" data-action="bk-restore" data-two="Click again to restore" ${bkBusy?'disabled':''}>Restore</button><button type="button" class="btn" data-action="bk-cancel">Cancel</button></div>
      <p class="hint" style="margin:0">Without the tick, only missing items are added back. Everything comes back exactly as it was saved, including Completed and Aborted projects with their tasks and status history, and the change history. Document records come back only where the file itself is still on the server; restore the files with “Restore documents” above. Saved logins are restored for team members; your own login is never changed.</p></div>`:''}
  </section></div>`;
}

/* ---------- workload analysis: filters, periods, person / project / skill / matrix ---------- */
var anaCache=null,anaKey='',afT=0;
const AF_DEF={scope:'open',pmin:1,pmax:10,pids:[],period:'8w',year:0,from:'',to:'',q:'',role:'',sort:'load'};
function afGet(){if(!ui.af){let sv={};try{sv=JSON.parse(localStorage.getItem('rfid-planner-af')||'{}')||{}}catch(e){}ui.af={...AF_DEF,...sv,q:''};if(!Array.isArray(ui.af.pids))ui.af.pids=[]}return ui.af}
function afSave(){try{const a={...ui.af};delete a.q;localStorage.setItem('rfid-planner-af',JSON.stringify(a))}catch(e){}}
const ymdN=n=>{const d=new Date(n*DAY);return [d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()]};
const monStart=(y,m)=>Math.round(Date.UTC(y,m,1)/DAY);
const curYear=()=>ymdN(TODAY)[0];
/* ---------- financial year (Admin settings → Skills & calendar; April–March by default) ---------- */
const fyStart=()=>{const v=+((S.calendar&&S.calendar.get('fy'))||{}).start;return v>=1&&v<=12?v:4};
// the FY a day falls in, named by the calendar year it starts in
const fyOf=n=>{const [y,m]=ymdN(n);return m+1>=fyStart()?y:y-1};
const curFy=()=>fyOf(TODAY);
const fyRange=y=>[monStart(y,fyStart()-1),monStart(y+1,fyStart()-1)-1];
const fyLabel=y=>fyStart()===1?`Year ${y}`:`FY ${y}-${String((y+1)%100).padStart(2,'0')}`;
const fyMonths=()=>`${MON[fyStart()-1]} – ${MON[(fyStart()+10)%12]}`;
// years worth offering: a year either side of today, plus any year with project work
function fyChoices(){const ys=new Set([curFy()-1,curFy(),curFy()+1]);for(const p of S.projects.values()){const m=model(p.id);for(const v of [m.s,m.e,d2n(p.start),d2n(p.target)])if(v!=null&&isFinite(v))ys.add(fyOf(v))}return [...ys].filter(v=>v>2000&&v<2100).sort()}
// a project's span: its start (or first task) to its finish (when it was completed / aborted), or still running
function projSpan(p){const m=model(p.id);const s=d2n(p.start)??(isFinite(m.s)?m.s:null);
  let e;if(projClosed(p)){const L=(Array.isArray(p.closeLog)?p.closeLog:[]).filter(x=>x.act==='completed'||x.act==='aborted'),last=L[L.length-1];e=last&&last.at?dayOf(last.at):(isFinite(m.e)?m.e:s)}
  else e=Math.max(TODAY,isFinite(m.e)?m.e:TODAY,d2n(p.target)??TODAY);
  const s0=s??(d2n(p.createdAt?n2d(dayOf(p.createdAt)):'')??e);return [Math.min(s0,e),e]}
// in that year: running at any time during it (started before it ended, finished after it began)
/* the year each person chooses to work in (kept in their browser): every screen then shows only that year */
let gFyV=null,gFyK='';
const gFyKey=()=>'rfid-planner-gfy:'+(typeof meKey==='function'?meKey():'');
function gFy(){const k=gFyKey();if(gFyV==null||k!==gFyK){gFyK=k;try{gFyV=localStorage.getItem(k)||''}catch(e){gFyV=''}if(gFyV!==''){ui.sheetFy=gFyV}}return gFyV===''?null:+gFyV}
function setGFy(v){gFyV=v==null?'':String(v);try{localStorage.setItem(gFyKey(),gFyV)}catch(e){}loadCache=null;anaCache=null;
  const y=gFy();if(y!=null){const [A,B]=fyRange(y),pick=Math.min(Math.max(TODAY,A),B);ui.logMonth=n2d(pick).slice(0,7);ui.logDate=n2d(pick);if(ui.logF){ui.logF.from=n2d(A);ui.logF.to=n2d(Math.min(B,Math.max(A,TODAY)))}ui.sheetFy=String(y);ui.bkFy=String(y);
    if(ui.view==='project'&&ui.pid&&S.projects.get(ui.pid)&&!projInFy(S.projects.get(ui.pid),y))ui.view='overview'}
  else{ui.sheetFy='';ui.bkFy=''}
  render()}
const inYearP=p=>{const y=gFy();return y==null||(!!p&&projInFy(p,y))};
const inYearD=n=>{const y=gFy();if(y==null)return true;if(n==null)return false;const [A,B]=fyRange(y);return n>=A&&n<=B};
const yearSelect=(id,cls)=>`<select id="${id}" class="${cls||'afsel'}" aria-label="Financial year"><option value="">All years</option>${fyChoices().map(y=>`<option value="${y}" ${gFy()===y?'selected':''}>${fyLabel(y)}${y===curFy()?' (this year)':''}</option>`).join('')}</select>`;
function yearBanner(){const y=gFy();if(y==null)return '';const [A,B]=fyRange(y);return `<div class="banner yearban"><span><b>Showing ${fyLabel(y)} only</b> (${fmtY(A)} – ${fmtY(B)}): projects running in this year, and follow-ups, delays, daily log and history dated in it. Everything else is hidden, not deleted.</span><span class="spacer"></span>${yearSelect('gfy-ban')}<button type="button" class="btn w" data-action="gfy-all">Show all years</button></div>`}
function projInFy(p,y){if(y==null||y==='')return true;const [A,B]=fyRange(+y),[s,e]=projSpan(p);return s<=B&&e>=A}
function afPeriod(F){
  const [y,mo]=ymdN(TODAY);let A,B,label;
  if(gFy()!=null&&F.period!=='custom'&&!(gFy()===curFy()&&F.period!=='year'))F={...F,period:'year',year:gFy()};
  if(F.period==='month'){A=monStart(y,mo);B=monStart(y,mo+1)-1;label=MON[mo]+' '+y}
  else if(F.period==='quarter'){const f0=fyStart()-1,k=Math.floor(((mo-f0+12)%12)/3),fy=curFy();A=monStart(fy,f0+k*3);B=monStart(fy,f0+k*3+3)-1;label=fyStart()===1?'Q'+(k+1)+' '+y:'Q'+(k+1)+' '+fyLabel(fy)}
  else if(F.period==='year'){const yy=+F.year||curFy();[A,B]=fyRange(yy);label=fyLabel(yy)}
  else if(F.period==='custom'){const cm=n2d(TODAY).slice(0,7);const f=/^\d{4}-\d{2}$/.test(F.from)?F.from:cm;let t=/^\d{4}-\d{2}$/.test(F.to)?F.to:f;if(t<f)t=f;
    const [fy,fm]=f.split('-').map(Number),[ty,tm]=t.split('-').map(Number);A=monStart(fy,fm-1);B=Math.min(monStart(ty,tm)-1,monStart(fy+3,fm-1)-1);label=MON[fm-1]+' '+fy+(f===t?'':' – '+MON[tm-1]+' '+ty)}
  else{A=monday(TODAY);B=A+55;label='Next 8 weeks'}
  const unit=(B-A+1)<=100?'week':'month',buckets=[];
  if(unit==='week'){for(let w=monday(A);w<=B;w+=7){const a=Math.max(w,A),b=Math.min(w+6,B);buckets.push({a,b,top:'W'+isoWeek(w),sub:fmt(a),lab:'W'+isoWeek(w)+' '+fmt(a)})}}
  else{let [yy,mm]=ymdN(A);for(let k=0;k<60;k++){const a=monStart(yy,mm+k);if(a>B)break;const [ay,am]=ymdN(a);buckets.push({a:Math.max(a,A),b:Math.min(monStart(ay,am+1)-1,B),top:MON[am],sub:String(ay),lab:MON[am]+' '+ay})}}
  return {A,B,unit,label,buckets};
}
const afScope=F=>projList().filter(p=>F.scope==='all'||(F.scope==='closed')===projClosed(p));
function afProjects(F){const narrow=+F.pmin>1||+F.pmax<10;return afScope(F).filter(p=>{const r=projRank(p);if(narrow&&(r<+F.pmin||r>+F.pmax))return false;if(F.pids.length&&!F.pids.includes(p.id))return false;return true})}
function planDaily(t,I,owner,hol,H){
  const out=new Map(),days=[];for(let n=I.s;n<=I.e;n++)if(isWorkDay(owner,n,hol))days.push(n);if(!days.length)days.push(I.s);
  const mode=t.spread||'even';
  if(mode!=='even'){const hpd=owner?memberCap(owner).hpd:6;if(H<=hpd*days.length+0.01){let r=H;for(const n of (mode==='late'?days.slice().reverse():days)){if(r<=0)break;const x=Math.min(hpd,r);out.set(n,x);r-=x}return out}}
  const per=H/days.length;for(const n of days)out.set(n,per);return out;
}
function analysis(){
  const F=afGet(),key=JSON.stringify({...F,q:'',gfy:gFy()});if(anaCache&&anaKey===key)return anaCache;
  const per=afPeriod(F),{A,B,buckets}=per,nB=buckets.length,hol=new Set(holidayList().map(x=>x.date));
  const bi=n=>{if(n<A||n>B)return -1;let lo=0,hi=nB-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(buckets[mid].a<=n)lo=mid;else hi=mid-1}return lo};
  const zeros=()=>buckets.map(()=>0),lists=()=>buckets.map(()=>[]);
  const people=new Map();
  for(const m of workList()){const c=memberCap(m),cap=zeros();buckets.forEach((b,i)=>{let h=0;for(let n=b.a;n<=b.b;n++)if(isWorkDay(m,n,hol))h+=c.hpd;cap[i]=h});
    people.set(m.id,{m,load:zeros(),behind:zeros(),cap,cnt:zeros(),items:lists(),proj:new Map(),tasks:0,hours:0,np:0,capT:cap.reduce((a,b)=>a+b,0)})}
  const projs=afProjects(F),projects=new Map(),skills=new Map(),missing=[];
  const sk=k=>{if(!skills.has(k))skills.set(k,{load:zeros(),cap:zeros(),items:lists()});return skills.get(k)};
  const unassigned={load:zeros(),cnt:zeros(),items:lists(),hours:0,tasks:0,proj:new Map()};
  const pe=(P,p)=>{let e=P.proj.get(p.id);if(!e){e={p,roles:[],tasks:0,open:0,hours:0,next:null};P.proj.set(p.id,e)}return e};
  const npOK=!F.pids.length&&!(+F.pmin>1||+F.pmax<10)&&F.scope!=='closed';
  const LG=new Map();for(const l of S.logs.values()){if(!canSeeLog(l))continue;const n=d2n(l.date);if(n==null||n>TODAY||!(+l.hours>0)||!people.has(l.mid))continue;let mm=LG.get(l.mid);if(!mm)LG.set(l.mid,mm=new Map());if(!mm.has(n))mm.set(n,[]);mm.get(n).push(l)}
  for(const p of projs){
    const m=model(p.id),PR={p,load:zeros(),cnt:zeros(),items:lists(),people:new Set(),hours:0,tasks:0};projects.set(p.id,PR);
    for(const [rk,lab] of [['owner','Lead'],['salesPerson','Sales'],['assignedBy','Introducer']]){const P=people.get(p[rk]);if(P){const e=pe(P,p);if(!e.roles.includes(lab))e.roles.push(lab)}}
    for(const id of m.leaves){const I=m.info.get(id),t=I.t;if(I.s==null||I.e==null||!isFinite(I.s)||!isFinite(I.e))continue;
      const open=I.status!=='done',effE=open&&I.e<TODAY?Math.max(TODAY,monday(TODAY)+4):I.e;
      if(effE<A||I.s>B)continue;
      const owner=S.members.get(t.assignee),H=taskHours(t,owner),daily=new Map();
      const ownLog=owner&&LG.get(owner.id),behind=new Map();if(H!=null){if(I.s<TODAY){
          // past days nobody logged: a finished task's plan stands; for an open task only the part its progress says is done
          // (the rest is still ahead and is spread from today), so the task never counts more than its effort
          const past=[];for(const [n,h] of planDaily(t,I,owner,hol,H))if(n<TODAY&&!(ownLog&&ownLog.has(n)))past.push([n,h]);
          const sum=past.reduce((a,x)=>a+x[1],0),f=!open||!sum?1:Math.min(1,H*Math.min(100,I.prog||0)/100/sum);
          for(const [n,h] of past){if(h*f>0)daily.set(n,h*f);if(h*(1-f)>0.001)behind.set(n,h*(1-f))}}
        if(open){const r=taskDaily(t,I,owner,hol,ownLog&&ownLog.has(TODAY)?TODAY+1:TODAY);if(r)for(const [n,h] of r)daily.set(n,(daily.get(n)||0)+h)}}
      else if(open)missing.push({p,I});
      const wk=zeros();let tot=0;for(const [n,h] of daily){const i=bi(n);if(i>=0){wk[i]+=h;tot+=h}}
      const bw=zeros();for(const [n,h] of behind){const i=bi(n);if(i>=0)bw[i]+=h}
      const inB=buckets.map(b=>I.s<=b.b&&effE>=b.a&&(open||b.a<TODAY));
      if(!tot&&!inB.some(Boolean))continue;
      PR.tasks++;PR.hours+=tot;
      const P=people.get(t.assignee),tgt=P||unassigned,S2=sk(t.skill||'none');
      tgt.tasks++;tgt.hours+=tot;const e=pe(tgt,p);e.tasks++;e.hours+=tot;if(open){e.open++;if(e.next==null||I.e<e.next)e.next=I.e}
      if(P){PR.people.add(P.m.id);bw.forEach((x,i)=>{if(x)P.behind[i]+=x})}
      buckets.forEach((b,i)=>{const h=wk[i];if(!h&&!inB[i])return;const it={p,I,h,c:inB[i]};
        for(const X of [PR,tgt]){X.load[i]+=h;if(inB[i])X.cnt[i]++;X.items[i].push(it)}S2.load[i]+=h;S2.items[i].push(it)});
    }
  }
  const projIds=new Set(projs.map(p=>p.id));
  for(const [mid,mm] of LG){const P=people.get(mid);for(const [n,ls] of mm){const i=bi(n);if(i<0)continue;for(const l of ls){const p=l.pid&&S.projects.get(l.pid);if(p?!projIds.has(p.id):(l.pid||!npOK))continue;const hh=+l.hours,it={p:p||NPROJ,log:l,h:hh,c:false};P.load[i]+=hh;P.items[i].push(it);P.hours+=hh;
    if(p){const e=pe(P,p);e.hours+=hh;const PR=projects.get(p.id);PR.load[i]+=hh;PR.hours+=hh;PR.items[i].push(it);PR.people.add(mid)}else P.np+=hh}}}
  if(npOK&&B>=TODAY){for(const P of people.values()){const mm=LG.get(P.m.id);const avg=routineAvg(P.m,mm,hol);const hasBk=Array.isArray(P.m.bookings)&&P.m.bookings.length;if(!avg&&!hasBk)continue;if(avg)P.npAvg=avg;const from=mm&&mm.has(TODAY)?TODAY+1:TODAY;
    buckets.forEach((b,i)=>{let x=0,bk=0;for(let n=Math.max(b.a,from);n<=b.b;n++)if(isWorkDay(P.m,n,hol)){const r=halfLeave(P.m,n)?avg/2:avg,y=hasBk?bookedOn(P.m,n):0;if(y>=r)bk+=y;else x+=r}
      if(x>0){P.load[i]+=x;P.hours+=x;P.np+=x;P.items[i].push({p:NPROJ,routine:true,h:x,c:false})}if(bk>0){P.load[i]+=bk;P.hours+=bk;P.np+=bk;P.items[i].push({p:NPROJ,routine:true,booked:true,h:bk,c:false})}})}}
  for(const s of skillList())sk(s.id);
  for(const [k,S2] of skills){if(k==='none')continue;for(const P of people.values()){if(k!=='general'&&!(P.m.skills||{})[k])continue;P.cap.forEach((c,i)=>S2.cap[i]+=c)}}
  anaCache={per,buckets,people,projects,skills,unassigned,missing,projs};anaKey=key;return anaCache;
}
function afPeople(A){
  const F=afGet(),q=(F.q||'').toLowerCase().trim();
  const util=P=>P.capT?P.hours/P.capT:P.hours?9:0;
  const L=[...A.people.values()].filter(P=>(!q||String(P.m.name||'').toLowerCase().includes(q))&&(!F.role||(P.m.role||'')===F.role));
  L.sort(F.sort==='name'?(a,b)=>String(a.m.name).localeCompare(b.m.name):F.sort==='projects'?(a,b)=>b.proj.size-a.proj.size||util(b)-util(a):(a,b)=>util(b)-util(a)||String(a.m.name).localeCompare(b.m.name));
  return L;
}
const pSum=P=>{let lead=0;for(const e of P.proj.values())if(e.roles.includes('Lead'))lead++;const n=P.proj.size;return n?`${n} project${n===1?'':'s'} · ${lead} lead · ${P.tasks} task${P.tasks===1?'':'s'}`:'No projects in this view'};
const prioTxt=p=>+p.rank>0?'P'+(+p.rank):'—';
function afBar(compact){
  const F=afGet(),y=curYear();
  const seg=(k,v,l)=>`<button type="button" class="${String(F[k])===String(v)?'on':''}" data-action="af-set" data-k="${k}" data-v="${v}">${l}</button>`;
  const years=fyChoices();
  const extra=gFy()!=null&&!(gFy()===curFy()&&F.period!=='year')&&F.period!=='custom'?`<span class="muted small">${fyLabel(gFy())} (your chosen year)</span>`:F.period==='year'?`<select class="afsel" data-af="year" aria-label="Financial year">${years.map(v=>`<option value="${v}" ${v===(+F.year||curFy())?'selected':''}>${fyLabel(v)}</option>`).join('')}</select>`
    :F.period==='custom'?`<span class="afrange"><input type="month" class="afsel" data-af="from" aria-label="From month" value="${h(F.from||n2d(TODAY).slice(0,7))}"><span class="muted">to</span><input type="month" class="afsel" data-af="to" aria-label="To month" value="${h(F.to||F.from||n2d(TODAY).slice(0,7))}"></span>`:'';
  let html=`<div class="afbar ${compact?'compact':''}"><div class="seg" role="group" aria-label="Projects">${seg('scope','open','Open projects')}${seg('scope','closed','Closed')}${seg('scope','all','All')}</div>
    <div class="seg" role="group" aria-label="Period">${seg('period','month','This month')}${seg('period','8w','Next 8 wks')}${seg('period','quarter','This quarter')}${seg('period','year',fyStart()===1?'Year':'Financial year')}${seg('period','custom','Custom')}</div>${extra}`;
  if(!compact){
    const all=afScope(F),ps=(ui.afPs||'').toLowerCase().trim();
    const roles=[...new Set(workList().map(m=>m.role).filter(Boolean))].sort();
    const popt=(k)=>[...Array(10)].map((_,i)=>`<option value="${i+1}" ${+F[k]===i+1?'selected':''}>P${i+1}</option>`).join('');
    html+=`<span class="afprio"><span class="muted small">Priority</span><select class="afsel" data-af="pmin" aria-label="Priority from">${popt('pmin')}</select><span class="muted small">to</span><select class="afsel" data-af="pmax" aria-label="Priority to">${popt('pmax')}</select></span>
    <details class="afpick" ${ui.afPickOpen?'open':''}><summary class="afsel">${F.pids.length?`${F.pids.length} project${F.pids.length===1?'':'s'} picked`:'All projects'}</summary>
      <div class="afpop"><input type="search" class="afsel" data-afps placeholder="Search code or name" value="${h(ui.afPs||'')}" aria-label="Search projects">
      <div class="afplist">${all.map(p=>{const q=(String(p.code||'')+' '+p.name).toLowerCase();return `<label data-q="${h(q)}" ${ps&&!q.includes(ps)?'hidden':''}><input type="checkbox" data-af="pid" value="${p.id}" ${F.pids.includes(p.id)?'checked':''}><b class="mono">${h(p.code||'')}</b><span>${h(p.name)}</span><span class="muted small">${prioTxt(p)}</span></label>`}).join('')||'<div class="empty-note">No projects in this scope.</div>'}</div>
      ${F.pids.length?`<button type="button" class="btn sm" data-action="af-set" data-k="pids" data-v="">Clear picks</button>`:''}</div></details>
    <input type="search" class="afsel afq" data-af="q" placeholder="Search people" value="${h(F.q||'')}" aria-label="Search people">
    ${roles.length>1?`<select class="afsel" data-af="role" aria-label="Role"><option value="">All roles</option>${roles.map(r=>`<option ${F.role===r?'selected':''}>${h(r)}</option>`).join('')}</select>`:''}
    <select class="afsel" data-af="sort" aria-label="Sort people"><option value="load" ${F.sort==='load'?'selected':''}>Most loaded first</option><option value="projects" ${F.sort==='projects'?'selected':''}>Most projects first</option><option value="name" ${F.sort==='name'?'selected':''}>Name A–Z</option></select>`;
  }
  return html+'</div>';
}
function afScopeLine(A){const F=afGet();const sc={open:'Open projects',closed:'Closed projects',all:'All projects'}[F.scope];const pr=+F.pmin>1||+F.pmax<10?` · P${F.pmin}–P${F.pmax}`:'';const pk=F.pids.length?` · ${F.pids.length} picked`:'';
  return `${sc}${pr}${pk} · ${A.per.label} · ${A.projs.length} project${A.projs.length===1?'':'s'}`}
function viewLoad(){
  const A=analysis(),by=ui.loadBy||'person',B=A.buckets,nB=B.length,sel=ui.loadSel,wk=A.per.unit==='week';
  const ppl=afPeople(A);
  let overB=0;for(const P of A.people.values())for(let i=0;i<nB;i++)if(P.load[i]>P.cap[i]+0.01)overB++;
  const short=[...A.skills.entries()].filter(([k,S2])=>k!=='none'&&k!=='general'&&S2.load.some((lo,i)=>lo>S2.cap[i]+0.01)).map(([k])=>skillName(k));
  const cols=`style="grid-template-columns:minmax(200px,250px) repeat(${nB},minmax(${wk?66:60}px,1fr)) minmax(86px,auto)"`;
  const head=lab=>`<div class="lg-row lg-h" ${cols}><span>${lab}</span>${B.map(b=>`<span><b class="mono">${b.top}</b><br>${b.sub}</span>`).join('')}<span><b>Total</b><br>period</span></div>`;
  const isSel=(byk,k,i)=>sel&&sel.by===byk&&sel.k===k&&sel.w===i;
  const cell=(byk,k,i,lo,ca,label,bh)=>`<button type="button" class="lc ${utilCls(lo,ca)} ${isSel(byk,k,i)?'sel':''} ${bh>0.05?'behind':''}" data-action="load-cell" data-by="${byk}" data-k="${k}" data-w="${i}" title="${h(label)} · ${B[i].lab}: ${fh(lo)} h booked of ${fh(ca)} h${bh>0.05?` · ${fh(bh)} h planned here not done yet (no log, task progress behind plan); it is counted in the weeks ahead instead`:''}"><b>${pctTxt(lo,ca)}</b><span>${fh(lo)}/${fh(ca)} h</span></button>`;
  const totCell=(lo,ca)=>`<span class="lc lt ${utilCls(lo,ca)}"><b>${pctTxt(lo,ca)}</b><span>${fh(lo)}/${fh(ca)} h</span></span>`;
  let body='';
  if(by==='person'){
    body=head('Team member')+(ppl.map(P=>{const m=P.m;return `<div class="lg-row ${ui.afPerson===m.id?'rsel':''}" ${cols}><div class="lname">${av(m.id)}<div style="min-width:0"><b>${h(m.name)}</b><button type="button" class="psum" data-action="af-person" data-id="${m.id}" aria-expanded="${ui.afPerson===m.id}">${pSum(P)}</button></div></div>${B.map((b,i)=>cell('person',m.id,i,P.load[i],P.cap[i],m.name,P.behind[i])).join('')}${totCell(P.hours,P.capT)}</div>`}).join('')||'<div class="empty-note" style="padding:14px">No one matches these filters.</div>');
  }else if(by==='project'){
    const L=[...A.projects.values()].filter(x=>x.tasks||x.hours).sort((a,b)=>b.hours-a.hours||projRank(a.p)-projRank(b.p));
    body=head('Project')+(L.map(x=>{const p=x.p;return `<div class="lg-row" ${cols}><div class="lname"><div style="min-width:0"><button type="button" class="plink" data-action="open-project" data-id="${p.id}"><b class="mono">${h(p.code||'')}</b> <b class="pn">${h(p.name)}</b></button><div class="as">${prioTxt(p)}${p.owner?' · Lead '+h(mName(p.owner)):''} · ${x.people.size} ${x.people.size===1?'person':'people'} · ${x.tasks} task${x.tasks===1?'':'s'}</div></div></div>${B.map((b,i)=>{const lo=x.load[i],c=x.cnt[i];return `<button type="button" class="lc ${lo>0||c?'pv':'ue'} ${isSel('project',p.id,i)?'sel':''}" data-action="load-cell" data-by="project" data-k="${p.id}" data-w="${i}" title="${h(p.name)} · ${b.lab}: ${fh(lo)} h · ${c} task${c===1?'':'s'}"><b>${lo?fh(lo)+' h':'—'}</b><span>${c?c+' task'+(c===1?'':'s'):''}</span></button>`}).join('')}<span class="lc lt pv"><b>${fh(x.hours)} h</b><span>${x.tasks} tasks</span></span></div>`}).join('')||'<div class="empty-note" style="padding:14px">No tasks in this period for these projects.</div>');
  }else if(by==='skill'){
    const keys=[...skillList().map(s=>s.id),...(A.skills.has('general')?['general']:[]),...(A.skills.has('none')?['none']:[])];
    body=head('Skill')+keys.map(k=>{const S2=A.skills.get(k);if(!S2)return '';const who=[...A.people.values()].filter(P=>k==='general'||(P.m.skills||{})[k]).map(P=>P.m);const lt=S2.load.reduce((a,b)=>a+b,0),ct=S2.cap.reduce((a,b)=>a+b,0);
      return `<div class="lg-row" ${cols}><div class="lname"><span class="skdot ${k==='none'?'none':''}"></span><div style="min-width:0"><b>${h(skillName(k))}</b><div class="as">${k==='none'?'Tasks without a required skill':who.length?who.map(m=>h(m.name)+((m.skills||{})[k]==='expert'?' ★':'')).join(', '):'<span class="slip">No one has this skill</span>'}</div></div></div>${B.map((b,i)=>k==='none'?`<button type="button" class="lc ue ${isSel('skill',k,i)?'sel':''}" data-action="load-cell" data-by="skill" data-k="${k}" data-w="${i}"><b>${fh(S2.load[i])} h</b><span>demand</span></button>`:cell('skill',k,i,S2.load[i],S2.cap[i],skillName(k))).join('')}${k==='none'?`<span class="lc lt ue"><b>${fh(lt)} h</b><span>demand</span></span>`:totCell(lt,ct)}</div>`}).join('');
  }else body=matrixHtml(A,ppl);
  const lgrid=by==='matrix'?body:`<div class="lgrid">${body}</div>`;
  const seg=(v,l)=>`<button class="${by===v?'on':''}" data-action="load-opt" data-k="loadBy" data-v="${v}">${l}</button>`;
  const unitW=wk?'week':'month';
  return `<div class="phead"><div><div class="eyebrow">${h(afScopeLine(A))}</div><h1 class="ptitle">Resource load</h1></div><div class="actions"><button class="btn sm" data-action="af-csv">Export CSV</button><button class="btn sm" data-action="af-pdf">Export PDF</button><button class="btn ${overB?'primary':''} w" data-action="level">Load advisor</button></div></div>
  ${afBar(false)}
  <div class="stats">
    <div class="stat ${overloadedNow()?'bad':''}"><b>${overloadedNow()}</b><span>Overloaded this week</span></div>
    <div class="stat ${overB?'warn':''}"><b>${overB}</b><span>Overloaded person-${unitW}s</span></div>
    <div class="stat ${short.length?'bad':''}"><b>${short.length}</b><span>Short skills</span></div>
    <div class="stat"><b>${A.projs.length}</b><span>Projects in view</span></div>
    <div class="stat ${A.missing.length?'warn':''}"><b>${A.missing.length}</b><span>Tasks missing effort</span></div>
  </div>
  ${short.length?`<div class="banner bad"><span><b>Not enough capacity:</b> ${short.map(h).join(', ')}. Switch to “By skill” to see which ${unitW}s.</span></div>`:''}
  <div class="toolbar"><div class="seg" role="group" aria-label="View by">${seg('person','By person')}${seg('project','By project')}${seg('skill','By skill')}${seg('matrix','Person × Project')}</div>
    <div class="legend"><span><i class="u0"></i>Under 85%</span><span><i class="u1"></i>85–100%</span><span><i class="u2"></i>Over 100%</span></div></div>
  ${lgrid}
  <p class="hint" style="margin:0">Past days show the hours people logged in the Daily log. On days nobody logged, a finished task counts its planned hours; an open task counts only the part its progress says is done, and the rest is spread from today, so no task counts more than its effort. A dot marks a cell with planned work not done yet. Regular non-project work from the log is added to future weeks. From today on, the remaining effort of open tasks is spread over their remaining working days, minus leave and holidays. Click a person’s project summary for their project list, or a cell to see the tasks behind it.</p>
  ${personPanel(A)}${loadDetail(A)}
  ${A.missing.length?`<section class="panel"><div class="panel-h"><h2>Fill in to make the load accurate</h2><span class="muted small">${A.missing.length}</span></div><p class="hint" style="margin:0">Tasks without effort aren’t counted in anyone’s load.</p>
    <div class="alist">${A.missing.slice(0,20).map(x=>`<button class="aitem" data-action="edit-task" data-id="${x.I.t.id}">${av(x.I.t.assignee)}<span style="min-width:0"><div class="at">${h(x.I.t.title)}</div><div class="as"><span class="mono">${h(x.p.code||'')} ${x.I.wbs}</span> · ${h(mName(x.I.t.assignee))}</div></span><span class="slip small">No effort</span></button>`).join('')}${A.missing.length>20?`<div class="empty-note">and ${A.missing.length-20} more</div>`:''}</div></section>`:''}`;
}
function matrixCols(A){const L=[...A.projects.values()].filter(x=>x.tasks||x.hours).sort((a,b)=>b.hours-a.hours||projRank(a.p)-projRank(b.p));return {top:L.slice(0,12),rest:L.slice(12)}}
function matrixHtml(A,ppl){
  const {top,rest}=matrixCols(A),restIds=new Set(rest.map(x=>x.p.id)),sel=ui.loadSel;
  if(!top.length)return '<div class="lgrid"><div class="empty-note" style="padding:14px">No tasks in this period for these projects.</div></div>';
  let mx=0;const hasNP=[...A.people.values()].some(P=>P.np>0);const rowOf=P=>{const v=top.map(x=>{const e=P.proj.get(x.p.id);return e?e.hours:0});let o=0;for(const [pid,e] of P.proj)if(restIds.has(pid))o+=e.hours;const np=P.np||0;v.forEach(x=>mx=Math.max(mx,x));mx=Math.max(mx,o,np);return {v,o,np}};
  const rows=ppl.map(P=>({P,...rowOf(P)}));const U=A.unassigned.hours>0?{P:null,...rowOf(A.unassigned)}:null;
  const shade=x=>!x?'m0':x<mx*0.25?'m1':x<mx*0.6?'m2':'m3';
  const td=(pid,x,P,label)=>{const on=sel&&sel.by==='pp'&&sel.k===(P?P.m.id:'')&&sel.p===pid;return `<td><button type="button" class="mc ${shade(x)} ${on?'sel':''}" data-action="load-cell" data-by="pp" data-k="${P?P.m.id:''}" data-p="${pid}" title="${h(label)}: ${fh(x)} h">${x?fh(x):''}</button></td>`};
  const tr=r=>{const nm=r.P?r.P.m.name:'Unassigned',X=r.P||A.unassigned;return `<tr><th scope="row"><span class="mxn">${r.P?av(r.P.m.id):av('')}<span>${h(nm)}</span></span></th>${top.map((x,i)=>td(x.p.id,r.v[i],r.P,nm+' · '+(x.p.code||x.p.name))).join('')}${rest.length?td('_others',r.o,r.P,nm+' · other projects'):''}${hasNP?td('_np',r.np,r.P,nm+' · non-project work'):''}<td class="mt ${r.P?utilCls(X.hours,X.capT):'ue'}"><b>${fh(X.hours)} h</b>${r.P?`<span>${pctTxt(X.hours,X.capT)}</span>`:''}</td></tr>`};
  const tot=top.map(x=>x.hours),oT=rest.reduce((a,x)=>a+x.hours,0),npT=[...A.people.values()].reduce((a,P)=>a+(P.np||0),0),gT=tot.reduce((a,b)=>a+b,0)+oT+npT;
  return `<div class="mxwrap"><table class="mx"><thead><tr><th scope="col">Team member</th>${top.map(x=>`<th scope="col" title="${h(x.p.name)}"><button type="button" class="plink" data-action="open-project" data-id="${x.p.id}"><b class="mono">${h(x.p.code||x.p.name.slice(0,6))}</b></button><span>${prioTxt(x.p)}</span></th>`).join('')}${rest.length?`<th scope="col" title="${h(rest.map(x=>x.p.code||x.p.name).join(', '))}"><b>Others</b><span>${rest.length} projects</span></th>`:''}${hasNP?'<th scope="col" title="Non-project work from the daily log"><b>Non-project</b><span>daily log</span></th>':''}<th scope="col"><b>Total</b><span>load</span></th></tr></thead>
  <tbody>${rows.map(tr).join('')}${U?tr(U):''}</tbody>
  <tfoot><tr><th scope="row">Project total</th>${tot.map(v=>`<td><b>${fh(v)} h</b></td>`).join('')}${rest.length?`<td><b>${fh(oT)} h</b></td>`:''}${hasNP?`<td><b>${fh(npT)} h</b></td>`:''}<td><b>${fh(gT)} h</b></td></tr></tfoot></table></div>
  <p class="hint" style="margin:0">Hours in the selected period. The ${top.length} busiest projects get their own column${rest.length?`; the other ${rest.length} are grouped under Others`:''}. Total compares each person’s hours with their capacity for the period.</p>`;
}
function personPanel(A){
  const id=ui.afPerson;if(!id)return '';const P=A.people.get(id);if(!P){return ''}
  const k=ui.ppSort||'hours';const L=[...P.proj.values()];
  const cmp={hours:(a,b)=>b.hours-a.hours,code:(a,b)=>String(a.p.code||'').localeCompare(String(b.p.code||'')),prio:(a,b)=>projRank(a.p)-projRank(b.p),tasks:(a,b)=>b.open-a.open||b.tasks-a.tasks,next:(a,b)=>(a.next??1e9)-(b.next??1e9)}[k]||((a,b)=>b.hours-a.hours);L.sort(cmp);
  const th=(key,l,cls)=>`<th scope="col" class="${cls||''}"><button type="button" class="thb ${k===key?'on':''}" data-action="af-psort" data-v="${key}">${l}${k===key?' ↓':''}</button></th>`;
  const ST={active:'Active',planning:'Planning',hold:'On hold',done:'Done'};
  return `<section class="panel pdet"><div class="panel-h"><h2>${av(id)} ${h(P.m.name)} <span class="muted small">${pSum(P)} · ${fh(P.hours)} h of ${fh(P.capT)} h (${pctTxt(P.hours,P.capT)})</span></h2><button type="button" class="icon-btn" data-action="af-person" data-id="" aria-label="Close project list"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
  ${L.length?`<div class="ptabw"><table class="ptab"><thead><tr>${th('code','Project')}${th('prio','Priority')}<th scope="col">Status</th><th scope="col">Role</th>${th('tasks','Open / tasks','n')}${th('hours','Hours','n')}${th('next','Next due')}</tr></thead><tbody>
  ${L.map(e=>`<tr><td><button type="button" class="plink" data-action="open-project" data-id="${e.p.id}"><b class="mono">${h(e.p.code||'')}</b> ${h(e.p.name)}</button></td><td>${prioTxt(e.p)}</td><td>${ST[e.p.status]||h(e.p.status||'')}</td><td>${e.roles.length?e.roles.join(', ')+(e.tasks?' + tasks':''):'Task owner'}</td><td class="n">${e.open} / ${e.tasks}</td><td class="n">${fh(e.hours)} h</td><td class="${e.next!=null&&e.next<TODAY?'slip':''}">${e.next!=null?fmtY(e.next):'—'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-note">No projects in this view.</div>'}${P.np>0?`<p class="hint" style="margin:0">Plus <b>${fh(P.np)} h</b> of non-project work from the daily log${P.npAvg?` (about ${fh(P.npAvg)} h per working day ahead)`:''}.</p>`:''}</section>`;
}
function loadDetail(A){
  const sel=ui.loadSel;if(!sel)return '';const B=A.buckets;let items=[],title='',sub='',grpBy='project',head='';
  if(sel.by==='pp'){const P=sel.k?A.people.get(sel.k):A.unassigned;if(!P)return '';const restIds=new Set(matrixCols(A).rest.map(x=>x.p.id));const map=new Map();
    for(const lst of P.items)for(const x of lst){if(sel.p==='_others'?!restIds.has(x.p.id):x.p.id!==sel.p)continue;const kk=x.log?'L'+x.log.id:x.routine?(x.booked?'B':'R'):x.I.t.id;const o=map.get(kk)||{...x,h:0};o.h+=x.h;map.set(kk,o)}
    items=[...map.values()];const pp=A.projects.get(sel.p);title=`${sel.k?h(P.m.name):'Unassigned'} · ${sel.p==='_others'?'Other projects':sel.p==='_np'?'Non-project work':h(pp?(pp.p.code||'')+' '+pp.p.name:'')}`;sub=A.per.label;}
  else{const w=sel.w,b=B[w];if(!b)return '';const src=sel.by==='person'?A.people.get(sel.k):sel.by==='project'?A.projects.get(sel.k):A.skills.get(sel.k);if(!src)return '';items=src.items[w];
    const nm=sel.by==='person'?src.m.name:sel.by==='project'?(src.p.code||'')+' '+src.p.name:skillName(sel.k);title=`${h(nm)} · ${b.top}${A.per.unit==='week'?'':' '+b.sub}`;sub=`${fmt(b.a)} – ${fmtY(b.b)}`;
    if(sel.by==='project')grpBy='person';
    if(sel.by!=='project'&&src.cap){const lo=src.load[w],ca=src.cap[w];head=`<div class="pc-row"><span><span class="lc-inline ${utilCls(lo,ca)}">${pctTxt(lo,ca)}</span> ${fh(lo)} h booked of ${fh(ca)} h available${sel.by==='skill'?' (everyone with this skill)':''}</span></div>`}
    if(sel.by==='person'){const m=src.m,ds=[],hol=new Set(holidayList().map(x=>x.date));for(let n=b.a;n<=b.b&&ds.length<12;n++){if(hol.has(n2d(n)))ds.push(`${WD[dow(n)]} ${fmt(n)} holiday`);else if(onLeave(m,n)&&memberCap(m).wd.includes(dow(n)))ds.push(`${WD[dow(n)]} ${fmt(n)} leave`)}if(ds.length)head+=`<div class="as">Not available: ${ds.join(', ')}</div>`}}
  const G=new Map();for(const x of items){const as=x.log?x.log.mid:x.I?x.I.t.assignee:'';const gk=grpBy==='project'?x.p.id:(as&&S.members.has(as)?as:'');const g=G.get(gk)||{k:gk,p:x.p,h:0,list:[]};g.h+=x.h;g.list.push(x);G.set(gk,g)}
  const gs=[...G.values()].sort((a,b)=>b.h-a.h||b.list.length-a.list.length),lim=ui.detAll?gs.length:5;
  const itm=x=>x.routine?`<div class="aitem"><span class="av">NP</span><span style="min-width:0"><div class="at">${x.booked?'Booked time ahead':'Routine non-project work'}</div><div class="as">${x.booked?'Non-project time booked in the Daily log':'Average of the last 4 weeks in the daily log'}</div></span><span class="mono">${fh(x.h)} h</span></div>`:x.log?`<button class="aitem" data-action="open-log" data-id="${x.log.id}">${av(x.log.mid)}<span style="min-width:0"><div class="at">${h(String(x.log.what||'').slice(0,120))}</div><div class="as">Daily log · ${h(logType(x.log))} · ${h(mName(x.log.mid))} · ${fmt(d2n(x.log.date))}</div></span><span class="mono">${fh(x.h)} h</span></button>`:`<button class="aitem" data-action="edit-task" data-id="${x.I.t.id}">${av(x.I.t.assignee)}<span style="min-width:0"><div class="at">${h(x.I.t.title)}</div><div class="as"><span class="mono">${h(x.p.code||'')} ${x.I.wbs}</span> · ${h(skillName(x.I.t.skill))} · ${h(mName(x.I.t.assignee))} · ${fmt(x.I.s)} – ${fmt(x.I.e)}${x.I.status==='done'?' · Done':''}</div></span><span class="mono">${fh(x.h)} h</span></button>`;
  const grp=(g,i)=>{const lab=grpBy==='project'?`<b class="mono">${h(g.p.code||'')}</b> ${h(g.p.name)}`:`${av(g.k)} ${h(g.k?mName(g.k):'Unassigned')}`;return `<details class="dgrp" ${i===0||gs.length===1?'open':''}><summary><span class="dgl">${lab}</span><span class="muted small">${(()=>{const nt=g.list.filter(x=>x.I&&!x.log).length,nl=g.list.filter(x=>x.log).length,r=g.list.some(x=>x.routine);return [nt?nt+' task'+(nt===1?'':'s'):'',nl?nl+' log entr'+(nl===1?'y':'ies'):'',r?'routine (avg)':''].filter(Boolean).join(' · ')})()}</span><span class="mono">${fh(g.h)} h</span></summary><div class="alist">${g.list.slice().sort((a,b)=>b.h-a.h).map(itm).join('')}</div></details>`};
  return `<section class="panel ldetail"><div class="panel-h"><h2>${title} <span class="muted small">${sub}</span></h2><button type="button" class="icon-btn" data-action="load-cell" data-by="" aria-label="Close details"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>${head}
  ${gs.length?gs.slice(0,lim).map(grp).join(''):'<div class="empty-note">Nothing booked here.</div>'}
  ${gs.length>5?`<button type="button" class="btn sm" data-action="af-detall">${ui.detAll?'Show top 5 only':`Show all ${gs.length} ${grpBy==='project'?'projects':'people'}`}</button>`:''}</section>`;
}
function heatmap(){
  const ms=workList();if(!ms.length)return '';const A=analysis(),B=A.buckets,wk=A.per.unit==='week';
  const lv=c=>c===0?'l0':c<=2?'l1':c<=4?'l2':'l3';
  const tip=(X,i)=>{const m=new Map();for(const x of X.items[i])if(x.c){const c=x.p.code||x.p.name;m.set(c,(m.get(c)||0)+1)}return [...m].sort((a,b)=>b[1]-a[1]).map(([c,n])=>`${c}: ${n}`).join(', ')};
  const rows=ms.map(m=>A.people.get(m.id)).filter(Boolean);const U=A.unassigned;
  const tr=(X,P)=>`<tr><td class="nm">${P?av(P.m.id):av('')}<div class="nmw"><span>${P?h(P.m.name):'Unassigned'}</span>${P?`<button type="button" class="psum" data-action="af-person" data-id="${P.m.id}" data-go="load">${pSum(P)}</button>`:''}</div></td>${X.cnt.map((c,i)=>{const t=tip(X,i);return `<td class="c ${lv(c)}" ${t?`title="${h(t)}"`:''}>${c||''}</td>`}).join('')}</tr>`;
  return `<section class="panel"><div class="panel-h"><h2>Tasks per ${wk?'week':'month'}</h2><div class="legend"><span><i class="l1"></i>1–2 tasks</span><span><i class="l2"></i>3–4</span><span><i class="l3"></i>5+ overloaded</span></div></div>
  ${afBar(true)}
  <p class="hint" style="margin:0">${h(afScopeLine(A))}. From this ${wk?'week':'month'} on, open tasks are counted; earlier ${wk?'weeks':'months'} count every task that was scheduled then. Hover a cell for the projects behind it; click a person’s summary for their project list.</p>
  <div class="heat"><table><thead><tr><th>Member</th>${B.map(b=>`<th><span class="mono">${b.top}</span><br>${b.sub}</th>`).join('')}</tr></thead>
  <tbody>${rows.map(P=>tr(P,P)).join('')}${U.cnt.some(x=>x)?tr(U,null):''}</tbody></table></div></section>`;
}
/* ---- export of the current Resource load view ---- */
function afTable(){
  const A=analysis(),by=ui.loadBy||'person',B=A.buckets,ppl=afPeople(A),pc=(lo,ca)=>ca>0?Math.round(lo/ca*100)+'%':'';const r1=x=>Math.round(x*10)/10;
  const T={title:'Resource load – '+({person:'by person',project:'by project',skill:'by skill',matrix:'person × project'}[by]),sub:afScopeLine(A)+' · exported '+fmtY(TODAY),head:[],rows:[],foot:null,shade:false};
  if(by==='person'){T.head=['Team member','Projects',...B.map(b=>b.lab),'Total h','Capacity h','Load'];T.rows=ppl.map(P=>[P.m.name,P.proj.size,...P.load.map(r1),r1(P.hours),r1(P.capT),pc(P.hours,P.capT)])}
  else if(by==='project'){T.head=['Project','Priority','Lead',...B.map(b=>b.lab),'Total h','Tasks'];T.rows=[...A.projects.values()].filter(x=>x.tasks||x.hours).sort((a,b)=>b.hours-a.hours).map(x=>[`${x.p.code||''} ${x.p.name}`.trim(),prioTxt(x.p),x.p.owner?mName(x.p.owner):'',...x.load.map(r1),r1(x.hours),x.tasks])}
  else if(by==='skill'){T.head=['Skill',...B.map(b=>b.lab),'Total h','Capacity h','Load'];T.rows=[...A.skills.entries()].map(([k,S2])=>{const lo=S2.load.reduce((a,b)=>a+b,0),ca=S2.cap.reduce((a,b)=>a+b,0);return [skillName(k),...S2.load.map(r1),r1(lo),k==='none'?'':r1(ca),k==='none'?'':pc(lo,ca)]})}
  else{const {top,rest}=matrixCols(A),ri=new Set(rest.map(x=>x.p.id));T.shade=true;const hasNP=[...A.people.values()].some(P=>P.np>0);T.head=['Team member',...top.map(x=>x.p.code||x.p.name),...(rest.length?['Others']:[]),...(hasNP?['Non-project']:[]),'Total h','Load'];T.long=['Team member',...top.map(x=>`${x.p.code||''} ${x.p.name}`.trim()),...(rest.length?['Others ('+rest.map(x=>x.p.code||x.p.name).join(' ')+')']:[]),...(hasNP?['Non-project work (daily log)']:[]),'Total h','Load'];
    const row=(nm,X,cap)=>{const v=top.map(x=>{const e=X.proj.get(x.p.id);return r1(e?e.hours:0)});let o=0;for(const [pid,e] of X.proj)if(ri.has(pid))o+=e.hours;return [nm,...v,...(rest.length?[r1(o)]:[]),...(hasNP?[r1(X.np||0)]:[]),r1(X.hours),cap==null?'':pc(X.hours,cap)]};
    T.rows=ppl.map(P=>row(P.m.name,P,P.capT));if(A.unassigned.hours>0)T.rows.push(row('Unassigned',A.unassigned,null));
    T.foot=['Project total',...top.map(x=>r1(x.hours)),...(rest.length?[r1(rest.reduce((a,x)=>a+x.hours,0))]:[]),...(hasNP?[r1([...A.people.values()].reduce((a,P)=>a+(P.np||0),0))]:[]),r1([...A.projects.values()].reduce((a,x)=>a+x.hours,0)+[...A.people.values()].reduce((a,P)=>a+(P.np||0),0)),'']}
  return T;
}
async function afDl(){let dl=null;try{dl=window.claude&&window.claude.use?await window.claude.use('downloads'):null}catch(e){}if(!dl)toast('Downloads aren’t available in this view.');return dl}
const afFile=ext=>`Resource_load_${ui.loadBy||'person'}_${n2d(TODAY)}.${ext}`;
async function afCsv(){const dl=await afDl();if(!dl)return;const T=afTable(),esc=v=>`"${String(v??'').replace(/"/g,'""')}"`;
  const lines=[[T.title],[T.sub],[],T.long||T.head,...T.rows,...(T.foot?[T.foot]:[])].map(r=>r.map(esc).join(','));
  try{await dl.save({filename:afFile('csv'),data:'﻿'+lines.join('\r\n')});toast('CSV saved')}catch(e){if(!(e&&e.code==='declined'))toast('Couldn’t save the file. Try again.')}}
async function afPdf(){return tablePdf(afTable(),afFile('pdf'))}
async function tablePdf(T,fname){const dl=await afDl();if(!dl)return;
  try{await loadJsPDF()}catch(e){return toast('Couldn’t load the PDF maker. Check the connection and try again.')}
  const {jsPDF}=window.jspdf,big=T.head.length>16,pdf=new jsPDF({orientation:'landscape',unit:'mm',format:big?'a3':'a4',compress:true});
  const W=pdf.internal.pageSize.getWidth(),H=pdf.internal.pageSize.getHeight(),M=10,n=T.head.length,c0=Math.min(62,(W-2*M)*0.24),cw=(W-2*M-c0)/(n-1),rh=6.4,fs=n>20?6.5:n>14?7.5:8.5;
  const asc=s=>String(s??'').replace(/[–—]/g,'-').replace(/×/g,'x').replace(/[^\x20-\x7E -ÿ]/g,'');
  let mx=0;if(T.shade)for(const r of T.rows)for(let i=1;i<n-2;i++)if(typeof r[i]==='number')mx=Math.max(mx,r[i]);
  let y=0,page=0;
  const top=()=>{page++;pdf.setFont('helvetica','bold');pdf.setFontSize(14);pdf.setTextColor(21,32,48);pdf.text(asc(T.title),M,14);pdf.setFont('helvetica','normal');pdf.setFontSize(8.5);pdf.setTextColor(90,100,115);pdf.text(asc(T.sub),M,19.5);pdf.text('RFID R&D Planner · page '+page,W-M,19.5,{align:'right'});y=27};
  const cx=i=>i?M+c0+(i-1)*cw:M;
  const hdr=()=>{pdf.setFillColor(232,236,242);pdf.rect(M,y-4.4,W-2*M,rh*1.7,'F');pdf.setFont('helvetica','bold');pdf.setFontSize(fs);pdf.setTextColor(30,40,55);
    T.head.forEach((t,i)=>{const s=asc(t);if(i){const ls=pdf.splitTextToSize(s,cw-1.5).slice(0,2);ls.forEach((l,j)=>pdf.text(l,cx(i)+cw-1,y+j*3.4,{align:'right'}))}else pdf.text(s,M+1.5,y)});pdf.setFont('helvetica','normal');y+=rh*1.7+0.4};
  top();hdr();
  const all=[...T.rows,...(T.foot?[T.foot]:[])];
  all.forEach((r,ri)=>{if(y>H-12){pdf.addPage(big?'a3':'a4','landscape');top();hdr()}
    const foot=T.foot&&ri===all.length-1;if(foot){pdf.setDrawColor(150);pdf.line(M,y-4.6,W-M,y-4.6);pdf.setFont('helvetica','bold')}else if(ri%2){pdf.setFillColor(247,248,250);pdf.rect(M,y-4.4,W-2*M,rh,'F')}
    r.forEach((v,i)=>{const sh=T.shade&&!foot&&i>0&&i<n-2&&typeof v==='number'&&v>0&&mx>0;if(sh){const f=Math.min(1,v/mx);pdf.setFillColor(Math.round(255-f*(255-39)),Math.round(255-f*(255-71)),Math.round(255-f*(255-201)));pdf.rect(cx(i)+0.4,y-4.2,cw-0.8,rh-0.4,'F')}
      const s=asc(typeof v==='number'?(v?String(v):''):v),wt=sh&&v/mx>0.55;pdf.setTextColor(wt?255:30,wt?255:40,wt?255:55);
      pdf.setFontSize(fs);if(i)pdf.text(s,cx(i)+cw-1,y,{align:'right'});else pdf.text(pdf.splitTextToSize(s,c0-3)[0],M+1.5,y)});
    if(foot)pdf.setFont('helvetica','normal');y+=rh});
  if(T.long&&T.long.length){y+=4;pdf.setFontSize(7.5);pdf.setTextColor(90,100,115);const key=T.long.slice(1,-2).map((l,i)=>{const hd=T.head[i+1];return hd===l?'':`${hd} = ${l.startsWith(hd+' ')?l.slice(hd.length+1):l}`}).filter(Boolean).join('   ');for(const ln of pdf.splitTextToSize(asc(key),W-2*M)){if(y>H-8){pdf.addPage(big?'a3':'a4','landscape');top()}pdf.text(ln,M,y);y+=4}}
  pdf.setProperties({title:asc(T.title),creator:'RFID R&D Planner'});
  try{await dl.save({filename:fname,data:pdf.output('blob')});toast('PDF saved')}catch(e){if(!(e&&e.code==='declined'))toast('Couldn’t save the file. Try again.')}}

/* admin: skills & calendar */
function viewSkills(){
  const manage=canManage(),dis=manage?'':' disabled';const L=computeLoad();
  const used=id=>{let t=0;for(const x of S.tasks.values())if(x.skill===id)t++;return t};
  const ppl=id=>memberList().filter(m=>(m.skills||{})[id]);
  return `<div class="phead"><div><h1 class="ptitle">Skills &amp; calendar</h1><div class="psub">The skills your projects need, and company holidays that reduce capacity.</div></div></div>
  ${manage?'':'<div class="banner bad">Only the owner, or an admin shared as Editor, can change skills and holidays.</div>'}
  <section class="panel"><div class="panel-h"><h2>Skills</h2><span class="muted small">${S.skills.size}</span></div>
    <div class="alist">${skillList().map(s=>{const p=ppl(s.id);return `<div class="skrow2"><span class="skdot"></span><div style="min-width:0"><b>${h(s.name)}</b>${+s.dur>0?` <span class="skdur" title="Standard time: new tasks needing this skill get this length">⏱ ${durTxt(s)}</span>`:''}<div class="as">${p.length?p.map(m=>h(m.name)+((m.skills||{})[s.id]==='expert'?' ★':'')).join(', '):'<span class="slip">No one has this skill</span>'} · ${used(s.id)} task${used(s.id)===1?'':'s'}</div></div><div class="actions"><button class="btn" data-action="rename-skill" data-id="${s.id}"${dis}>Edit</button><button class="btn danger" data-action="del-skill" data-id="${s.id}" data-two="Confirm delete"${dis}>Delete</button></div></div>`}).join('')||'<div class="empty-note">No skills yet. Add the skills your projects need, for example Antenna design, RF hardware, Firmware, Mould design.</div>'}</div>
    <form id="skillForm" class="addrow skadd" novalidate><input type="text" id="newSkill" placeholder="New skill, e.g. Antenna design" maxlength="60" aria-label="New skill"${dis}><span class="skdurin"><input type="number" id="newSkillDur" min="0" step="0.5" inputmode="decimal" placeholder="Standard time" aria-label="Standard time (optional)"${dis}><select id="newSkillUnit" class="sel" aria-label="Unit"${dis}><option value="h">hours</option><option value="d" selected>days</option><option value="w">weeks</option></select></span><button type="submit" class="btn primary"${dis}>Add skill</button></form>
    <p class="hint" style="margin:0">Standard time is optional: the usual length of a task that needs this skill, in working days (weekends, holidays and leave are skipped; 1 week = 5 working days; hours use the owner’s hours per day). New tasks get their end date from it.</p>
    <p class="hint" style="margin:0">Set each person’s skills and level (Expert or Can assist) in their Team profile.</p>
  </section>
  <section class="panel"><div class="panel-h"><h2>Financial year</h2><span class="muted small">Now: ${fyLabel(curFy())}</span></div>
    <div class="fyrow"><label for="fy-start">Financial year starts in</label><select id="fy-start" class="sel"${dis}>${MON.map((m,i)=>`<option value="${i+1}" ${fyStart()===i+1?'selected':''}>${m}</option>`).join('')}</select><span class="muted small">${fyMonths()} · ${(()=>{const [a,b]=fyRange(curFy());return `${fmtY(a)} – ${fmtY(b)}`})()}</span></div>
    <p class="hint" style="margin:0">Used wherever the planner shows a year: <b>Resource load</b> (Financial year and This quarter), the <b>Overview</b> year filter, the <b>Team diary</b> and the <b>Excel export</b>. Nothing is moved or hidden; the year only chooses what you see. A project counts in a year when it was running at any time in it.</p>
  </section>
  <section class="panel"><div class="panel-h"><h2>Company holidays</h2><span class="muted small">${holidayList().filter(x=>x.date>=n2d(TODAY)).length} upcoming</span></div>
    <div class="alist">${holidayList().map((x,i)=>`<div class="skrow2"><span class="mono small">${WD[dow(d2n(x.date))]} ${fmtY(d2n(x.date))}</span><div style="min-width:0">${h(x.name||'Holiday')}${x.type?` <span class="tag">${h(x.type)}</span>`:''}</div><div class="actions"><button class="btn danger" data-action="del-hol" data-v="${x.date}" data-two="Remove"${dis}>Remove</button></div></div>`).join('')||'<div class="empty-note">No holidays added.</div>'}</div>
    <form id="holForm" class="addrow" novalidate><input type="date" id="holDate" aria-label="Holiday date"${dis}><input type="text" id="holName" placeholder="e.g. Diwali" maxlength="60" aria-label="Holiday name"${dis}><button type="submit" class="btn primary"${dis}>Add holiday</button></form>
    ${canManage()?holImportHtml():''}
  </section>`;
}
function wireSkills(){
  wireHolImport();
  const f=$('#skillForm');if(f)f.addEventListener('submit',ev=>{ev.preventDefault();const n=$('#newSkill').value.trim();if(!n)return;
    if(skillList().some(s=>s.name.toLowerCase()===n.toLowerCase()))return toast('That skill already exists.');
    const dv=+$('#newSkillDur').value,du=$('#newSkillUnit').value;const rec={name:n,order:Date.now()};if(dv>0){rec.dur=dv;rec.durUnit=du}
    put('skills',uid('s'),rec,{sys:true});logH({act:'changed',kind:'settings',title:`added the skill “${n}”${dv>0?` (standard time ${durTxt(rec)})`:''}`});toast('Skill added')});
  const g=$('#holForm');if(g)g.addEventListener('submit',ev=>{ev.preventDefault();const d=$('#holDate').value,n=$('#holName').value.trim();if(!d)return toast('Pick a date for the holiday.');
    const days=holidayList().filter(x=>x.date!==d);days.push({date:d,name:n||'Holiday'});put('calendar','holidays',{days},{sys:true});logH({act:'changed',kind:'settings',title:`added the holiday ${n||'Holiday'} on ${fmtY(d2n(d))}`});toast('Holiday added')});
}
function drSkill(d){const s=S.skills.get(d.id)||{name:''};const u=s.durUnit||'d';return `<form id="f" novalidate>${dHead('Skills','Edit skill')}<div class="dr-b"><div class="fld"><label for="sk-name">Skill name</label><input type="text" id="sk-name" value="${h(s.name)}" maxlength="60" autofocus></div>
  <div class="fld"><label for="sk-dur">Standard time <span class="muted">(optional)</span></label><div class="codebox"><input type="number" id="sk-dur" min="0" step="0.5" inputmode="decimal" value="${+s.dur>0?+s.dur:''}" placeholder="e.g. 3"><select id="sk-unit" class="sel" aria-label="Unit"><option value="h" ${u==='h'?'selected':''}>hours</option><option value="d" ${u==='d'?'selected':''}>days</option><option value="w" ${u==='w'?'selected':''}>weeks</option></select></div>
  <span class="hint">The usual length of a task that needs this skill, in working days. New tasks with this skill get their end date from it. Leave empty for no standard time. Existing tasks don’t change.</span></div><div class="err" id="fErr" hidden></div></div><div class="dr-f"><button type="submit" class="btn primary">Save</button><button type="button" class="btn" data-action="close-drawer">Cancel</button></div></form>`}
function saveSkill(d){const n=$('#sk-name').value.trim();if(!n)return formErr('Enter a name.');if(skillList().some(s=>s.id!==d.id&&s.name.toLowerCase()===n.toLowerCase()))return formErr('Another skill already has this name.');const s=S.skills.get(d.id);const dv=+$('#sk-dur').value,du=$('#sk-unit').value;const rec={...clean(s),name:n};if(dv>0){rec.dur=dv;rec.durUnit=du}else{delete rec.dur;delete rec.durUnit}
  put('skills',d.id,rec,{sys:true});const ch=[];if(s.name!==n)ch.push(`renamed “${s.name}” to “${n}”`);const od=+s.dur>0?durTxt(s):'none',nd=dv>0?durTxt(rec):'none';if(od!==nd)ch.push(`standard time ${od} → ${nd}`);
  if(ch.length)logH({act:'changed',kind:'settings',title:`edited the skill “${n}”: ${ch.join(', ')}`});closeDrawer();toast('Skill saved')}
function deleteSkill(id){const s=S.skills.get(id);if(!s||!canManage())return;
  for(const m of S.members.values())if((m.skills||{})[id]){const sk={...m.skills};delete sk[id];put('members',m.id,{...clean(m),skills:sk})}
  for(const t of S.tasks.values())if(t.skill===id)put('tasks',t.id,{...clean(t),skill:''});
  del('skills',id,{sys:true});logH({act:'changed',kind:'settings',title:`deleted the skill “${s.name}”`});toast('Skill deleted. Tasks that needed it now show “No skill”.')}



/* ---------- DD/MM/YYYY date fields (the native picker stays available behind the calendar button) ---------- */
const VDESC=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
function enhanceDate(inp){
  if(inp.dataset.dmy)return;inp.dataset.dmy='1';
  const wrap=document.createElement('span');wrap.className='dmy';
  const txt=document.createElement('input');txt.type='text';txt.className='dmy-t '+[...inp.classList].filter(c=>c==='afsel'||c==='sel').join(' ');txt.inputMode='numeric';txt.placeholder='DD/MM/YYYY';txt.autocomplete='off';txt.maxLength=10;
  const lab=inp.id&&document.querySelector(`label[for="${inp.id}"]`);txt.setAttribute('aria-label',inp.getAttribute('aria-label')||(lab?lab.textContent.trim():'Date')+' (DD/MM/YYYY)');
  const btn=document.createElement('span');btn.className='dmy-b';btn.setAttribute('aria-hidden','true');btn.innerHTML='<svg width="14" height="14" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  inp.parentNode.insertBefore(wrap,inp);wrap.append(txt,btn);btn.appendChild(inp);inp.classList.add('dmy-n');inp.tabIndex=-1;
  const sync=()=>{const v=VDESC.get.call(inp);if(document.activeElement!==txt||!txt.value)txt.value=v?isoToDmy(v):'';txt.disabled=inp.disabled;txt.classList.remove('bad')};
  Object.defineProperty(inp,'value',{configurable:true,get(){return VDESC.get.call(this)},set(v){VDESC.set.call(this,v);sync()}});
  inp.addEventListener('change',sync);inp.addEventListener('input',sync);
  new MutationObserver(sync).observe(inp,{attributes:true,attributeFilter:['disabled']});
  txt.addEventListener('input',()=>{txt.classList.remove('bad');const v=txt.value;if(/^\d{0,2}(\/\d{0,2}(\/\d{0,4})?)?$/.test(v))return;const d=v.replace(/\D/g,'').slice(0,8);txt.value=d.slice(0,2)+(d.length>2?'/'+d.slice(2,4):'')+(d.length>4?'/'+d.slice(4):'')});
  const commit=()=>{const raw=txt.value.trim();if(!raw){if(VDESC.get.call(inp)){VDESC.set.call(inp,'');inp.dispatchEvent(new Event('change',{bubbles:true}))}return}
    const iso=dmyToIso(raw);if(!iso){txt.classList.add('bad');txt.title='Type the date as DD/MM/YYYY';return}
    txt.title='';if(iso!==VDESC.get.call(inp)){VDESC.set.call(inp,iso);inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}))}txt.value=isoToDmy(iso)};
  if(lab)lab.addEventListener('click',e=>{e.preventDefault();if(!txt.disabled)txt.focus()});
  txt.addEventListener('change',commit);txt.addEventListener('keydown',e=>{if(e.key==='Enter'){commit()}});
  sync();
}
function enhanceDates(root){(root||document).querySelectorAll('input[type=date]:not([data-dmy])').forEach(enhanceDate)}
new MutationObserver(ms=>{for(const m of ms)for(const n of m.addedNodes)if(n.nodeType===1){if(n.matches&&n.matches('input[type=date]'))enhanceDate(n);else if(n.querySelectorAll)enhanceDates(n)}}).observe(document.body,{childList:true,subtree:true});
enhanceDates();


/* ---------- milestones inside a task ---------- */
const msList=t=>Array.isArray(t&&t.ms)?t.ms:[];
const msDoneN=t=>msList(t).filter(x=>x.done).length;
const msProg=t=>{const L=msList(t);return L.length?Math.round(msDoneN(t)/L.length*100):null};
function withMsProgress(t){const p=msProg(t);if(p==null)return t;const st=p>=100?'done':(t.status==='done'?'active':((t.status||'todo')==='todo'&&p>0?'active':t.status||'todo'));return {...t,progress:p,status:st}}
function msDay(I,k,n,x){const d=x.due?d2n(x.due):null;if(d!=null)return d;if(!isFinite(I.s)||!isFinite(I.e))return null;const len=I.e-I.s+1;return Math.min(I.e,I.s+Math.floor((k+1)*len/(n+1)))}
const msOver=x=>!x.done&&x.due&&d2n(x.due)!=null&&d2n(x.due)<TODAY;
function msState(x){return x.done?'done':msOver(x)?'over':'open'}
function msRow(x,i,dis){return `<div class="msrow" data-id="${h(x.id)}"><span class="msn">${i+1}</span>
  <input type="text" class="ms-name" value="${h(x.name||'')}" maxlength="120" placeholder="Milestone name, e.g. Prototype tuned" aria-label="Milestone ${i+1} name"${dis}>
  <div class="ms-sub"><span class="ms-due"><input type="date" class="ms-date" value="${h(x.due||'')}" aria-label="Milestone ${i+1} target date (optional)"${dis}></span>
  <label class="chk ms-done" title="${x.done&&x.doneAt?`Completed ${fmtTs(x.doneAt)} by ${h(pName(x.doneBy))}`:''}"><input type="checkbox" class="ms-ck" ${x.done?'checked':''}${dis}> Done</label>
  <span class="ms-btns"><button type="button" class="icon-btn ms-up" aria-label="Move up"${dis}>↑</button><button type="button" class="icon-btn ms-dn" aria-label="Move down"${dis}>↓</button><button type="button" class="icon-btn ms-del" aria-label="Remove milestone"${dis}>✕</button></span></div></div>`}
function msBox(t){const L=msList(t),on=L.length>0;
  return `<div class="fld msbox"><label class="chk msswitch"><input type="checkbox" id="ms-on" ${on?'checked':''}> <b>Milestones</b> · the task’s progress is worked out from completed milestones</label>
  <div id="msFields" ${on?'':'hidden'}><div class="msrows" id="msRows">${L.map((x,i)=>msRow(x,i,'')).join('')}</div>
  <button type="button" class="btn sm" id="msAdd">+ Add milestone</button>
  <div class="hint" id="msHint"></div></div></div>`}
function wireMilestones(){
  const on=$('#ms-on');if(!on)return;const box=$('#msFields'),rows=$('#msRows'),pr=$('#f-progress'),po=$('#progOut'),ss=$('#f-status');
  const renum=()=>{[...rows.children].forEach((r,i)=>{r.querySelector('.msn').textContent=i+1})};
  const upd=()=>{const R=[...rows.querySelectorAll('.msrow')],n=R.length,dn=R.filter(r=>r.querySelector('.ms-ck').checked).length,act=on.checked&&n>0;
    if(pr){pr.disabled=act||pr.dataset.lock==='1';if(act){const p=Math.round(dn/n*100);pr.value=p;if(po)po.textContent=p+'%';if(ss){if(p>=100)ss.value='done';else if(ss.value==='done')ss.value='active';else if(p>0&&ss.value==='todo')ss.value='active'}}}
    $('#msHint').innerHTML=act?`<b>${dn} of ${n}</b> milestone${n>1?'s':''} completed = <b>${Math.round(dn/n*100)}%</b>. The progress slider follows the milestones; completing them in any order counts the same.`:on.checked?'Add the first milestone. They keep the order you add them in, here and on the Gantt.':''};
  const add=()=>{rows.insertAdjacentHTML('beforeend',msRow({id:uid('ms'),name:'',due:'',done:false},rows.children.length,''));renum();upd();const last=rows.lastElementChild.querySelector('.ms-name');if(last)last.focus()};
  on.addEventListener('change',()=>{box.hidden=!on.checked;if(on.checked&&!rows.children.length)add();upd()});
  $('#msAdd').addEventListener('click',add);
  rows.addEventListener('click',e=>{const r=e.target.closest('.msrow');if(!r)return;
    if(e.target.closest('.ms-del')){r.remove();renum();upd()}
    else if(e.target.closest('.ms-up')&&r.previousElementSibling){rows.insertBefore(r,r.previousElementSibling);renum()}
    else if(e.target.closest('.ms-dn')&&r.nextElementSibling){rows.insertBefore(r.nextElementSibling,r);renum()}});
  rows.addEventListener('change',e=>{if(e.target.classList.contains('ms-ck'))upd()});
  if(pr&&pr.disabled)pr.dataset.lock='1';
  upd();
}
function readMilestones(old){
  const on=$('#ms-on');if(!on)return {ms:msList(old)};if(!on.checked)return {ms:[]};
  const prev=new Map(msList(old).map(x=>[x.id,x])),out=[];
  for(const r of document.querySelectorAll('#msRows .msrow')){const name=r.querySelector('.ms-name').value.trim(),due=r.querySelector('input[type=date].ms-date').value||'',done=r.querySelector('.ms-ck').checked;
    if(!name){if(due||done)return {err:'Give every milestone a name, or remove the empty row.'};continue}
    const p=prev.get(r.dataset.id)||{};out.push({id:r.dataset.id,name,due,done,doneAt:done?(p.done?p.doneAt:Date.now()):0,doneBy:done?(p.done?p.doneBy:meKey()):''})}
  return {ms:out};
}
function msChanges(a,b){const A=msList(a),B=msList(b);if(JSON.stringify(A)===JSON.stringify(B))return [];const ch=[];
  const am=new Map(A.map(x=>[x.id,x]));for(const x of B){const o=am.get(x.id);if(!o)ch.push(`Milestone added: ${x.name}`);else{if(o.name!==x.name)ch.push(`Milestone renamed: ${o.name} → ${x.name}`);if(!o.done&&x.done)ch.push(`Milestone completed: ${x.name}`);if(o.done&&!x.done)ch.push(`Milestone reopened: ${x.name}`);if((o.due||'')!==(x.due||''))ch.push(`Milestone ${x.name}: target ${o.due?dLab(o.due):'none'} → ${x.due?dLab(x.due):'none'}`)}am.delete(x.id)}
  for(const o of am.values())ch.push(`Milestone removed: ${o.name}`);if(B.length)ch.push(`Milestones: ${B.filter(x=>x.done).length} of ${B.length} done`);return ch}
// Mark milestones complete (from Follow-ups or the Milestones tab); records a follow-up update too.
function completeMilestones(tid,ids,remarks){
  const t=S.tasks.get(tid);if(!t||!canEditTask(t)||!ids.length)return false;
  const now=Date.now(),names=[];const ms=msList(t).map(x=>{if(ids.includes(x.id)&&!x.done){names.push(x.name);return {...x,done:true,doneAt:now,doneBy:meKey()}}return x});
  if(!names.length)return false;const nt=withMsProgress({...clean(t),ms});
  put('tasks',t.id,nt);
  put('updates',uid('u'),{taskId:t.id,pid:t.projectId,t:now,by:meKey(),event:'Milestone completed',remarks:remarks||('Milestone completed: '+names.join(', ')),progress:nt.progress,ms:names});
  logH({act:'edited',kind:'task',id:t.id,pid:t.projectId,title:t.title,code:(S.projects.get(t.projectId)||{}).code||'',ch:names.map(n=>'Milestone completed: '+n).concat([`Progress: ${+t.progress||0}% → ${nt.progress}%`])});
  return true;
}
function reopenMilestone(tid,mid,remark){
  const t=S.tasks.get(tid);if(!t||!canEditTask(t))return false;const now=Date.now();let nm='';
  const ms=msList(t).map(x=>{if(x.id!==mid||!x.done)return x;nm=x.name;const ro=Array.isArray(x.reopened)?x.reopened:[];return {...x,done:false,doneAt:0,doneBy:'',reopened:[...ro,{at:now,by:meKey(),remark,was:x.doneAt||0,wasBy:x.doneBy||''}]}});
  if(!nm)return false;const nt=withMsProgress({...clean(t),ms});put('tasks',t.id,nt);
  put('updates',uid('u'),{taskId:t.id,pid:t.projectId,t:now,by:meKey(),event:'Milestone reopened',remarks:`Reopened “${nm}”: ${remark}`,progress:nt.progress,msReopened:nm});
  logH({act:'edited',kind:'task',id:t.id,pid:t.projectId,title:t.title,code:(S.projects.get(t.projectId)||{}).code||'',ch:[`Milestone reopened: ${nm}`,`Reason: ${remark.length>80?remark.slice(0,80)+'…':remark}`,`Progress: ${+t.progress||0}% → ${nt.progress}%`]});
  return nt;
}
function drMsReopen(d){const t=S.tasks.get(d.tid),x=t&&msList(t).find(y=>y.id===d.mid);if(!t||!x)return `${dHead('Milestones','Not found')}<div class="dr-b"><p>This milestone no longer exists.</p></div>`;
  const L=msList(t),k=L.indexOf(x),after=Math.round((L.filter(y=>y.done).length-1)/L.length*100);
  return `<form id="f" novalidate>${dHead(`${h((S.projects.get(t.projectId)||{}).code||'')} · ${h(t.title)}`,'Reopen milestone')}
  <div class="dr-b">
    <div class="rollup"><span class="msn">${k+1}</span> <b>${h(x.name)}</b><br><span class="as">Completed ${x.doneAt?fmtTs(x.doneAt):''}${x.doneBy?' by '+h(pName(x.doneBy)):''}${x.due?` · target ${dLab(x.due)}`:''}</span></div>
    <div class="fld"><label for="ro-rem">Why is it being reopened?</label><textarea id="ro-rem" maxlength="1000" placeholder="e.g. Read-range retest failed at 85 °C; antenna needs retuning" autofocus></textarea><span class="hint">Required. Saved with the milestone, in the task’s follow-up updates and in History.</span></div>
    <div class="hint">The task’s progress will go from ${msProg(t)}% to <b>${after}%</b>${t.status==='done'?', and the task will no longer be marked Done':''}.</div>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary w">Reopen milestone</button><button type="button" class="btn" data-action="close-drawer">Cancel</button></div></form>`}
function saveMsReopen(d){const rem=$('#ro-rem').value.trim();if(!rem)return formErr('Add a remark saying why the milestone is reopened.');
  const t=S.tasks.get(d.tid);if(!t||!canEditTask(t))return formErr('Only the task owner, the project lead or an admin can reopen milestones.');
  const x=msList(t).find(y=>y.id===d.mid);const nt=reopenMilestone(d.tid,d.mid,rem);if(!nt)return formErr('This milestone is not completed.');
  closeDrawer();toast(`“${x?x.name:'Milestone'}” reopened · task now ${nt.progress}%`)}
function viewMilestones(){
  const ps=projList(),ms=workList(),show=ui.msShow||'open',rows=[];
  for(const p of ps){if(ui.fuProject&&p.id!==ui.fuProject)continue;const m=model(p.id);
    for(const id of m.flat){const I=m.info.get(id),L=msList(I.t);if(!L.length)continue;if(ui.fuPerson&&I.t.assignee!==ui.fuPerson)continue;L.forEach((x,k)=>rows.push({p,I,x,k,n:L.length,st:msState(x)}))}}
  const c=k=>rows.filter(r=>r.st===k).length,soon=rows.filter(r=>r.st==='open'&&r.x.due&&d2n(r.x.due)<=TODAY+7).length;
  const vis=rows.filter(r=>show==='all'?true:show==='open'?r.st!=='done':r.st===show);
  const groups=new Map();for(const r of vis){const k=r.I.t.id;if(!groups.has(k))groups.set(k,{p:r.p,I:r.I,rows:[]});groups.get(k).rows.push(r)}
  const opt=(v,l)=>`<button class="${show===v?'on':''}" data-action="ms-show" data-v="${v}">${l}</button>`;
  const byP=new Map();for(const g of groups.values()){if(!byP.has(g.p.id))byP.set(g.p.id,{p:g.p,tasks:[]});byP.get(g.p.id).tasks.push(g)}
  const chip=r=>r.st==='done'?`<span class="mschip done">✓ Completed ${r.x.doneAt?fmt(dayOf(r.x.doneAt)):''}</span>`:r.st==='over'?`<span class="mschip over">Overdue · due ${dLab(r.x.due)}</span>`:`<span class="mschip open">${r.x.due?'Due '+dLab(r.x.due):'Open'}</span>`;
  const sections=[...byP.values()].map(P=>`<section class="panel"><div class="panel-h"><h2><span class="mono muted" style="font-size:13px">${h(P.p.code||'')}</span> ${h(P.p.name)}</h2></div>
    ${P.tasks.map(g=>{const ed=canEditTask(g.I.t),L=msList(g.I.t);return `<div class="mstask"><div class="mst-h"><button class="hlink" data-action="edit-task" data-id="${g.I.t.id}"><span class="wbs">${g.I.wbs}</span> ${h(g.I.t.title)}</button><span class="as">${h(mName(g.I.t.assignee))} · ${msDoneN(g.I.t)} of ${L.length} done · <b>${msProg(g.I.t)}%</b></span><span class="msbar"><i style="width:${msProg(g.I.t)}%"></i></span></div>
      ${g.rows.map(r=>`<div class="msline ${r.st}"><span class="msn">${r.k+1}</span><span class="msnm">${h(r.x.name)}</span>${chip(r)}<span class="as">${r.st==='done'&&r.x.doneBy?h(pName(r.x.doneBy)):''}</span>${r.st!=='done'&&ed?`<button type="button" class="btn sm primary w" data-action="ms-complete" data-tid="${g.I.t.id}" data-id="${h(r.x.id)}">Mark completed</button>`:r.st==='done'&&ed?`<button type="button" class="btn sm w" data-action="ms-reopen" data-tid="${g.I.t.id}" data-id="${h(r.x.id)}">Reopen</button>`:'<span></span>'}</div>${(()=>{const ro=Array.isArray(r.x.reopened)?r.x.reopened:[];if(!ro.length)return '';const last=ro[ro.length-1];return `<div class="msro"><span class="mschip reo">↺ Reopened${ro.length>1?' ×'+ro.length:''}</span> <span class="as">${fmtTs(last.at)} · ${h(pName(last.by))}:</span> ${h(last.remark)}</div>`})()}`).join('')}</div>`}).join('')}</section>`).join('');
  return `<div class="stats">
    <div class="stat"><b>${rows.length}</b><span>Milestones</span></div>
    <div class="stat"><b>${c('done')}</b><span>Completed</span></div>
    <div class="stat ${c('over')?'bad':''}"><b>${c('over')}</b><span>Overdue</span></div>
    <div class="stat ${soon?'warn':''}"><b>${soon}</b><span>Due in 7 days</span></div></div>
  <div class="toolbar"><div class="seg" role="group" aria-label="Show">${opt('open','Open')}${opt('over','Overdue')}${opt('done','Completed')}${opt('all','All')}</div>
    <select class="sel" data-change="fuPerson" aria-label="Filter by owner"><option value="">Everyone</option>${ms.map(x=>`<option value="${x.id}" ${ui.fuPerson===x.id?'selected':''}>${h(x.name)}</option>`).join('')}</select>
    <select class="sel" data-change="fuProject" aria-label="Filter by project"><option value="">All projects</option>${ps.map(p=>`<option value="${p.id}" ${ui.fuProject===p.id?'selected':''}>${h(p.code||'')} ${h(p.name)}</option>`).join('')}</select>
    <span class="spacer"></span><button class="btn" data-action="ms-csv" ${rows.length?'':'disabled'}>Export CSV</button></div>
  ${sections||`<section class="panel"><div class="empty-note">${rows.length?'No milestones match this filter.':'No milestones yet. Open a task, tick <b>Milestones</b> and add them.'}</div></section>`}
  <p class="hint" style="margin:0">A task’s progress is the share of its milestones completed, in any order: 7 of 10 completed = 70%. Marking a milestone completed here also adds a follow-up update to the task.</p>`;
}
function msCsv(){const out=[['Project code','Project','Task','Task owner','No.','Milestone','Target date','Status','Completed on','Completed by','Task progress %','Times reopened','Last reopen remark']];
  for(const p of projList()){const m=model(p.id);for(const id of m.flat){const I=m.info.get(id),L=msList(I.t);L.forEach((x,k)=>out.push([p.code||'',p.name,`${I.wbs} ${I.t.title}`,mName(I.t.assignee),k+1,x.name,x.due||'',x.done?'Completed':msOver(x)?'Overdue':'Open',x.doneAt?n2d(dayOf(x.doneAt)):'',x.done?pName(x.doneBy):'',msProg(I.t),(x.reopened||[]).length||'',(x.reopened||[]).length?x.reopened[x.reopened.length-1].remark:'']))}}
  csvSave(out,`Milestones_${n2d(TODAY)}.csv`)}


/* ---------- stretching a main task when a subtask runs outside it ---------- */
// Main tasks (and their main tasks) that must grow so a subtask on s..e fits. Main tasks without own dates just pass the check upwards.
function stretchNeeds(parentId,s,e,cause){const out=[],seen=new Set();let pid=parentId,cs=s,ce=e;
  while(pid&&!seen.has(pid)){seen.add(pid);const P=S.tasks.get(pid);if(!P)break;const ps=d2n(P.start),pe=d2n(P.end);
    if(ps!=null&&pe!=null){if(cs<ps||ce>pe){const ns=Math.min(ps,cs),ne=Math.max(pe,ce);out.push({id:pid,t:P,ps,pe,ns,ne,cause});cs=ns;ce=ne}else{cs=ps;ce=pe}}
    pid=P.parentId}
  return out}
function stretchText(x){const a=x.ps-x.ns,b=x.ne-x.pe;return `“${h(x.t.title)}” ${fmt(x.ps)} – ${fmt(x.pe)} → <b>${fmt(x.ns)} – ${fmt(x.ne)}</b> (${[a?a+' day'+(a>1?'s':'')+' earlier':'',b?b+' day'+(b>1?'s':'')+' later':''].filter(Boolean).join(', ')})`}
function applyStretch(list){
  for(const x of list){const P=S.tasks.get(x.id);if(!P)continue;const st=P.stretch&&P.stretch.s0?P.stretch:{s0:P.start,e0:P.end,by:[]};
    const by=[...(st.by||[]),{tid:x.cause.id||'',title:x.cause.title||'',at:Date.now(),who:meKey(),from:[P.start,P.end],to:[n2d(x.ns),n2d(x.ne)]}].slice(-30);
    put('tasks',x.id,{...clean(P),start:n2d(x.ns),end:n2d(x.ne),stretch:{s0:st.s0,e0:st.e0,by}});
    logH({act:'edited',kind:'task',id:x.id,pid:P.projectId,title:P.title,code:(S.projects.get(P.projectId)||{}).code||'',ch:[`Stretched by subtask “${x.cause.title||''}”: ${fmt(x.ps)} – ${fmt(x.pe)} → ${fmt(x.ns)} – ${fmt(x.ne)}`]})}}
// After tasks were moved in bulk: stretch their main tasks where allowed.
function stretchAfterMoves(ids){let n=0,blocked=[];
  for(const id of ids){const t=S.tasks.get(id);if(!t||!t.parentId||!t.start||!t.end)continue;const need=stretchNeeds(t.parentId,d2n(t.start),d2n(t.end),{id,title:t.title});if(!need.length)continue;
    if(need.every(x=>canEditTask(x.t))){applyStretch(need);n+=need.length}else blocked.push(t.title)}
  if(n)toast(`${n} main task${n>1?'s were':' was'} stretched so ${n>1?'their':'its'} subtasks fit`);
  if(blocked.length)toast(`${blocked.join(', ')} now run${blocked.length>1?'':'s'} outside the main task. Ask the project lead to extend it.`)}
function stretchInfo(t){const st=t&&t.stretch;if(!st||!st.s0||!st.e0)return null;const s0=d2n(st.s0),e0=d2n(st.e0),s=d2n(t.start),e=d2n(t.end);if(s0==null||e0==null||s==null||e==null)return null;
  const before=s<s0?[s,Math.min(s0-1,e)]:null,after=e>e0?[Math.max(e0+1,s),e]:null;const last=(st.by||[])[st.by.length-1];return {s0,e0,before,after,by:st.by||[],last}}


/* ---------- change my own password (server version) ---------- */
function drMyPw(){const c=myCreds();return `<form id="f" novalidate>${dHead('Your account','Change my password')}
  <div class="dr-b">
    <div class="rollup">Login ID <b>${h(c?c.loginId:'')}</b></div>
    <div class="fld"><label for="mp-cur">Current password</label><input type="password" id="mp-cur" autocomplete="current-password" autofocus></div>
    <div class="fld"><label for="mp-new">New password</label><input type="password" id="mp-new" autocomplete="new-password" minlength="8" maxlength="128"><span class="hint">At least 8 characters.</span></div>
    <div class="fld"><label for="mp-new2">Type the new password again</label><input type="password" id="mp-new2" autocomplete="new-password" maxlength="128"></div>
    <label class="chk"><input type="checkbox" id="mp-show"> Show passwords</label>
    <div class="hint">Admins can see the password you set (Admin settings → Users &amp; access). After the change, other devices where you’re signed in are signed out; this one stays signed in.</div>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary">Change password</button><button type="button" class="btn" data-action="close-drawer">Cancel</button></div></form>`}
async function saveMyPw(){const cur=$('#mp-cur').value,nw=$('#mp-new').value,nw2=$('#mp-new2').value;
  if(!cur)return formErr('Enter your current password.');if(nw.length<8)return formErr('The new password must be at least 8 characters.');if(nw!==nw2)return formErr('The two new passwords don’t match.');if(nw===cur)return formErr('The new password is the same as the current one.');
  const b=$('#drawer button[type=submit]');b.disabled=true;b.textContent='Saving…';
  try{const r=await fetch('/api/auth/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current:cur,next:nw})});const j=await r.json().catch(()=>({}));
    if(!r.ok){b.disabled=false;b.textContent='Change password';return formErr(j.error||'Couldn’t change the password. Try again.')}
    logH({act:'reset',kind:'access',who:ME.id,ch:['Changed their own password']});closeDrawer();toast('Password changed');if(window.__plannerSync)window.__plannerSync()}
  catch(e){b.disabled=false;b.textContent='Change password';formErr('Couldn’t reach the server. Check the connection and try again.')}}

/* ---------- who may change which project and task ---------- */
const myMid=()=>{const m=myMember();return m?m.id:null};
function isLead(pid){const p=S.projects.get(pid),mid=myMid();return !!(p&&mid&&p.owner===mid)}
function canEditProject(pid){return canWrite()&&(isAdmin()||isLead(pid))&&!projFrozen(pid)}
/* View only people an admin allows to add projects: they create projects and edit the ones they added while those stay visible to them (no tasks, no delete) */
function canAddProj(){if(readOnly||mode!=='live'||role()!=='read')return false;const m=myMember();return !!(m&&m.canAddProjects)}
function isProjCreatorRO(pid){const p=S.projects.get(pid);return !!(p&&canAddProj()&&ME.id&&p.createdBy===ME.id&&canSeeProject(pid))}
function canEditProjInfo(pid){return !projFrozen(pid)&&(canEditProject(pid)||isProjCreatorRO(pid))}
const canNewProject=()=>canWrite()||canAddProj();
function isTaskOwner(t){const mid=myMid();return !!(t&&mid&&t.assignee===mid)}
function canEditTask(t){return !!t&&canWrite()&&!projFrozen(t.projectId)&&(isAdmin()||isLead(t.projectId)||isTaskOwner(t))}
function canAddTask(pid,parentId){if(projFrozen(pid)){const p=S.projects.get(pid);return p.status==='done'&&canWrite()&&(isAdmin()||isLead(pid))}if(canEditProject(pid))return true;const pt=parentId&&S.tasks.get(parentId);return !!pt&&pt.projectId===pid&&canWrite()&&isTaskOwner(pt)}
function canProjDocs(pid){if(projFrozen(pid))return false;if(canEditProjInfo(pid))return true;if(!canWrite())return false;const mid=myMid();return !!mid&&[...S.tasks.values()].some(t=>t.projectId===pid&&t.assignee===mid)}
const noEdit=(what)=>toast(`Only ${what==='project'?'the project lead or an admin can change this project':'the task owner, the project lead or an admin can change this task'}.`);

/* ---------- working-day timing: skill standard durations, linked starts ---------- */
const DUR_U={h:['hour','hours'],d:['day','days'],w:['week','weeks']};
const holS=()=>new Set(holidayList().map(x=>x.date));
const durTxt=sk=>{const n=+sk.dur,u=DUR_U[sk.durUnit||'d']||DUR_U.d;return `${fh(n)} ${n===1?u[0]:u[1]}`};
function firstWD(n,o,hol){let g=0;while(!isWorkDay(o,n,hol)&&g++<400)n++;return n}
function nextWD(n,o,hol){return firstWD(n+1,o,hol)}
function addWD(s,count,o,hol){let n=firstWD(s,o,hol),c=1,g=0;while(c<count&&g++<4000){n++;if(isWorkDay(o,n,hol))c++}return n}
function wdCount(a,b,o,hol){let c=0;for(let n=a;n<=b;n++)if(isWorkDay(o,n,hol))c++;return c}
function skillDays(sk,o){const n=+sk.dur;if(!(n>0))return 0;const u=sk.durUnit||'d';return Math.max(1,Math.ceil(u==='w'?n*5:u==='h'?n/(o?memberCap(o).hpd:6):n))}
function wireTiming(){
  if(!drawer||drawer.type!=='task')return;const st=$('#f-start'),en=$('#f-end'),fsk=$('#f-skill'),own=$('#f-assignee');if(!st||!en)return;
  const tk=drawer.id?S.tasks.get(drawer.id):drawer.draft,m=model(tk.projectId),hol=holS(),hint=$('#timHint'),dh=$('#depHint');
  let auto=!drawer.id,busy=false;
  const owner=()=>(own&&S.members.get(own.value))||null;
  const sdur=()=>{const k=fsk&&S.skills.get(fsk.value);return k&&+k.dur>0?k:null};
  const setV=(el,n)=>{busy=true;el.value=n2d(n);el.dispatchEvent(new Event('change',{bubbles:true}));busy=false};
  const fillEffort=(k,o)=>{const ef=$('#f-effort'),eu=$('#f-eunit');if(!ef||ef.value!=='')return;const u=k.durUnit||'d';
    if(u==='h'){ef.value=+k.dur;eu.value='h'}else{ef.value=skillDays(k,o);eu.value='d'}ef.dispatchEvent(new Event('input',{bubbles:true}));eu.dispatchEvent(new Event('change',{bubbles:true}))};
  const applyDur=()=>{const k=sdur(),s=d2n(st.value);if(!k)return false;if(s==null){hint.innerHTML=`<b>${h(k.name)}</b> usually takes ${durTxt(k)}. Set the start date and the end date follows.`;return false}
    const o=owner(),n=skillDays(k,o),s0=firstWD(s,o,hol),e=addWD(s0,n,o,hol);if(s0!==s)setV(st,s0);setV(en,e);auto=true;fillEffort(k,o);
    hint.innerHTML=`End date set from the skill: <b>${h(k.name)}</b> takes ${durTxt(k)}${(k.durUnit||'d')==='h'?` = ${n} working day${n>1?'s':''} at ${o?memberCap(o).hpd:6} h/day`:` = ${n} working day${n>1?'s':''}`}. You can still change it.`;return true};
  const predEnd=()=>{let best=null;for(const c of document.querySelectorAll('#deplist input[name=dep]:checked')){const I=m.info.get(c.value);if(I&&isFinite(I.e)&&(!best||I.e>best.e))best={e:I.e,I}}return best};
  const followPred=()=>{const pe=predEnd();if(!pe){if(dh)dh.textContent='';return}const o=owner(),ns=nextWD(pe.e,o,hol),s=d2n(st.value),e=d2n(en.value);
    const len=s!=null&&e!=null&&e>=s?Math.max(1,wdCount(s,e,o,hol)):5;setV(st,ns);if(!applyDur())setV(en,addWD(ns,len,o,hol));
    if(dh)dh.innerHTML=`Start moved to <b>${WD[dow(ns)]} ${fmt(ns)}</b>, the working day after <b>${pe.I.wbs} ${h(pe.I.t.title)}</b> ends (${fmt(pe.e)}).`};
  if(fsk)fsk.addEventListener('change',()=>{if(!busy)applyDur()});
  st.addEventListener('change',()=>{if(!busy&&auto)applyDur()});
  en.addEventListener('change',()=>{if(!busy&&auto){auto=false;hint.textContent='End date changed by hand.'}});
  if(own)own.addEventListener('change',()=>{const k=sdur();if(auto&&k&&(k.durUnit||'d')==='h')applyDur()});
  const dl=$('#deplist');if(dl)dl.addEventListener('change',ev=>{if(ev.target&&ev.target.name==='dep'){if(ev.target.checked)followPred();else if(dh)dh.textContent=''}});
  const k=sdur();if(k&&!drawer.id&&d2n(st.value)!=null)applyDur();else if(k)hint.innerHTML=`Standard for <b>${h(k.name)}</b>: ${durTxt(k)}.`;
}
// Tasks that wait on `root` (directly or down the chain) and should move after its dates changed.
function planFollow(pid,root){
  const m=model(pid),R=m.info.get(root);if(!R)return [];const hol=holS();
  const st=new Map(),en=new Map();for(const id of m.leaves){const I=m.info.get(id);st.set(id,I.s);en.set(id,I.e)}
  const E=id=>{const I=m.info.get(id);if(!I)return -Infinity;if(I.leaf)return en.get(id);let e=-Infinity;for(const c of I.kids)e=Math.max(e,E(c.id));return isFinite(e)?e:I.e};
  const hit=new Set([root,...R.anc]);
  for(let pass=0;pass<300;pass++){let ch=false;
    for(const id of m.leaves){if(id===root)continue;const I=m.info.get(id);if(I.status==='done'||!isFinite(st.get(id))||!isFinite(en.get(id)))continue;
      const ps=effPreds(m,id);if(!ps.some(p=>hit.has(p)))continue;
      let mx=-Infinity;for(const p of ps)mx=Math.max(mx,E(p));if(!isFinite(mx))continue;
      const o=S.members.get(I.t.assignee)||null,ns=nextWD(mx,o,hol),cur=st.get(id);if(ns===cur)continue;
      if(ns<cur&&(I.status!=='todo'||(I.prog||0)>0))continue;
      const len=Math.max(1,wdCount(cur,en.get(id),o,hol));st.set(id,ns);en.set(id,addWD(ns,len,o,hol));if(!hit.has(id)){hit.add(id);for(const a of I.anc)hit.add(a)}ch=true}
    if(!ch)break}
  return m.leaves.filter(id=>id!==root&&(st.get(id)!==m.info.get(id).s||en.get(id)!==m.info.get(id).e)).map(id=>({id,I:m.info.get(id),s:st.get(id),e:en.get(id)}));
}
/* task form: skill-aware owner picker */
function wireOwnerPicker(){
  const fsk=$('#f-skill');if(!fsk||!drawer||drawer.type!=='task')return;
  const tk=drawer.id?S.tasks.get(drawer.id):drawer.draft,sel=$('#f-assignee');sel.dataset.v=tk.assignee||'';
  const vals=()=>({sk:fsk.value,ov:!!($('#f-override')&&$('#f-override').checked),s:d2n($('#f-start').value),e:d2n($('#f-end').value),eff:+$('#f-effort').value,unit:$('#f-eunit').value,spread:$('#f-spread').value,prog:+$('#f-progress').value||0});
  const lvl=(m,sk)=>sk==='general'?'any':(m.skills||{})[sk]||'';
  const pv=(m,v)=>v.s!=null&&v.e!=null?previewFor(m.id,{id:drawer.id,s:v.s,e:Math.max(v.s,v.e),prog:v.prog,effort:v.eff,effortUnit:v.unit,spread:v.spread}):null;
  const label=(m,v)=>{const p=pv(m,v),l=lvl(m,v.sk),pc=p?(isFinite(p.peak)?Math.round(p.peak*100)+'%':'no capacity'):'';return `${m.name}${l==='expert'?' · Expert':l==='assist'?' · Can assist':''}${pc?' · '+pc:''}${p&&p.peak>1?' ⚠ overloaded':''}`};
  const build=()=>{const v=vals(),cur=sel.dataset.v,ms=workList();
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
    {const bf=$('#bestFit');if(bf){bf.innerHTML='';if(v.sk&&v.s!=null&&v.e!=null&&v.eff>0){const rk=x=>v.sk==='general'?2:lvl(x,v.sk)==='expert'?3:lvl(x,v.sk)==='assist'?1:2;
      const c=workList().filter(x=>!x.accessDisabled&&lvl(x,v.sk)).map(x=>({x,p:pv(x,v)})).filter(o=>o.p&&isFinite(o.p.peak)).sort((a,b)=>(a.p.peak>1)-(b.p.peak>1)||(a.p.peak-rk(a.x)*0.08)-(b.p.peak-rk(b.x)*0.08))[0];
      if(c&&c.x.id!==sel.value)bf.innerHTML=`<div class="bestfit"><span>Best fit: <b>${h(c.x.name)}</b>${v.sk!=='general'&&lvl(c.x,v.sk)==='expert'?' · Expert':lvl(c.x,v.sk)==='assist'?' · Can assist':''} · busiest week ${Math.round(c.p.peak*100)}%</span><button type="button" class="btn sm" id="bfUse" data-id="${c.x.id}">${sel.value?'Use instead':'Assign'}</button></div>`;
      else if(c)bf.innerHTML=`<div class="hint">✓ ${h(c.x.name)} is the best fit for this task right now.</div>`;
      const u=$('#bfUse');if(u)u.addEventListener('click',()=>{if(sel.disabled)return toast('Only the project lead or an admin can change the owner.');sel.value=u.dataset.id;sel.dataset.v=u.dataset.id;sel.dispatchEvent(new Event('change',{bubbles:true}))})}}}
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
/* open task form: show dates moved in the background (holiday / leave change) */
function liveTaskDates(before,after){
  const d=drawer;if(!d||d.type!=='task'||!d.id)return;const o=before.get(d.id),n=after.get(d.id);
  if(!o||!n||!n.calMoved||(o.calMoved&&o.calMoved.at===n.calMoved.at)||(o.start===n.start&&o.end===n.end))return;
  setTimeout(()=>{if(drawer!==d)return;const st=$('#f-start'),en=$('#f-end');if(!st||!en)return;
    const mine=st.value!==(o.start||'')||en.value!==(o.end||'');
    const rng=`${fmt(d2n(n.start))} – ${fmt(d2n(n.end))}`,why=h(n.calMoved.reason||'the calendar changed');
    if(!mine){st.value=n.start;en.value=n.end;en.dispatchEvent(new Event('change',{bubbles:true}));[st,en].forEach(x=>{const w=x.closest('.dmy')||x;w.classList.remove('flash');void w.offsetWidth;w.classList.add('flash')})}
    const b=$('#drawer .dr-b');if(!b)return;const old=b.querySelector('.livenote');if(old)old.remove();
    toast(mine?'Dates moved in the background; your typed dates were kept':`Dates updated: ${n.calMoved.reason||'calendar changed'}`);
    b.insertAdjacentHTML('afterbegin',`<div class="livenote" role="status">📅 ${mine?`Dates were moved to <b>${rng}</b> because ${why}. You changed the dates here, so they were left as you typed them; saving uses yours.`:`Dates updated because ${why}: <b>${rng}</b>.`}</div>`)},0)}

/* ---------- report a delay (task owner, lead or admin): reason, new end date, linked tasks follow ---------- */
const DELAY_CATS=[['tech','Technical issue'],['supplier','Supplier / material'],['customer','Customer input'],['test','Testing / certification failed'],['resource','Resource unavailable'],['other','Other']];
const delayCat=k=>(DELAY_CATS.find(x=>x[0]===k)||DELAY_CATS[5])[1];
const delaysOf=t=>Array.isArray(t&&t.delays)?t.delays:[];
const delayTxt=x=>x.cat==='other'&&x.catOther?x.catOther:delayCat(x.cat);
function delayPlan(t,ne){
  // what moves if this task ends on `ne`: linked tasks (finish → start) and the project forecast
  const I=model(t.projectId).info.get(t.id),old=S.tasks.get(t.id);
  S.tasks.set(t.id,{...old,end:n2d(ne)});loadCache=null;let mv=[],m2=null;
  try{mv=planFollow(t.projectId,t.id);m2=model(t.projectId)}finally{S.tasks.set(t.id,old);loadCache=null}
  const p=S.projects.get(t.projectId)||{},tg=d2n(p.target),fe=Math.max(m2&&isFinite(m2.e)?m2.e:ne,...mv.map(x=>x.e));
  return {I,mv,fe,tg,past:tg!=null&&fe>tg?fe-tg:0};
}
function drDelay(d){const t=S.tasks.get(d.tid);if(!t)return `${dHead('Delay','Not found')}`;const p=S.projects.get(t.projectId)||{},I=model(t.projectId).info.get(t.id);
  const L=delaysOf(t);
  return `<form id="f" novalidate>${dHead(`${h(p.code||'')} · Task ${I?I.wbs:''}`,'Report a delay')}
  <div class="dr-b">
    <div class="rollup"><b>${h(t.title)}</b><br>${h(mName(t.assignee))} · now ${fmt(I.s)} – <b>${fmt(I.e)}</b> · ${I.prog}% done${L.length?`<br><span class="slip small">Already delayed ${L.length} time${L.length>1?'s':''}, ${L.reduce((a,x)=>a+(+x.days||0),0)} working day${L.reduce((a,x)=>a+(+x.days||0),0)===1?'':'s'} in total</span>`:''}</div>
    <div class="fld"><label for="dl-cat">Reason</label><select id="dl-cat">${DELAY_CATS.map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>
    <div class="fld" id="dl-otherw" hidden><label for="dl-other">Describe the reason</label><input type="text" id="dl-other" maxlength="60" placeholder="e.g. Tooling breakdown"></div>
    <div class="fld"><label for="dl-det">What happened?</label><textarea id="dl-det" maxlength="1000" autofocus placeholder="e.g. Antenna detunes at 85 °C during thermal test; re-matching needed"></textarea><span class="hint">Required. Saved with the task and emailed to the project’s stakeholders.</span></div>
    <div class="fld"><span class="lab">New finish</span>
      <div class="seg dlmode" role="group"><button type="button" class="on" data-dlm="days">Add working days</button><button type="button" data-dlm="date">Pick a new end date</button></div>
      <div id="dl-dw" class="two" style="margin-top:6px"><div class="fld"><input type="number" id="dl-days" min="1" max="250" step="1" value="1" inputmode="numeric" aria-label="Working days of delay"></div><div class="fld"><span class="hint" style="align-self:center">working days after ${fmt(I.e)}</span></div></div>
      <div id="dl-dd" hidden style="margin-top:6px"><input type="date" id="dl-end" min="${n2d(I.e+1)}" aria-label="New end date"></div></div>
    <div class="fld"><label for="dl-file">Evidence <span class="muted">(optional)</span></label><input type="file" id="dl-file"><span class="hint">For example a test report or a supplier mail. It’s added to the project’s documents.</span></div>
    <div id="dlPrev"></div>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn danger">Report delay</button><button type="button" class="btn" data-action="close-drawer">Cancel</button></div></form>`}
function delayNewEnd(t){const I=model(t.projectId).info.get(t.id),o=S.members.get(t.assignee)||null,hol=holS();
  if(drawer.dlm==='date'){const n=d2n($('#dl-end').value);return n!=null&&n>I.e?n:null}
  const k=Math.round(+$('#dl-days').value);if(!(k>=1))return null;return addWD(nextWD(I.e,o,hol),k,o,hol)}
function wireDelay(d){const t=S.tasks.get(d.tid);if(!t)return;d.dlm=d.dlm||'days';
  const cat=$('#dl-cat'),ow=$('#dl-otherw');cat.addEventListener('change',()=>{ow.hidden=cat.value!=='other'});
  const prev=()=>{const ne=delayNewEnd(t),box=$('#dlPrev');if(ne==null){box.innerHTML='';return}const P=delayPlan(t,ne),o=S.members.get(t.assignee)||null,days=wdCount(P.I.e+1,ne,o,holS());
    box.innerHTML=`<div class="alert"><span><b>${h(t.title)}</b>: end ${fmt(P.I.e)} → <b>${fmt(ne)}</b> (+${days} working day${days>1?'s':''}).${P.mv.length?`<br>${P.mv.length} linked task${P.mv.length>1?'s':''} move later: ${P.mv.slice(0,4).map(x=>`${h(x.I.t.title)} → ${fmt(x.s)} – ${fmt(x.e)}`).join('; ')}${P.mv.length>4?'…':''}`:''}${P.past?`<br><span class="slip">Project forecast ${P.past} day${P.past>1?'s':''} past its target ${fmt(P.tg)}.</span>`:''}</span></div>`};
  $('#drawer').querySelectorAll('[data-dlm]').forEach(b=>b.addEventListener('click',()=>{d.dlm=b.dataset.dlm;$('#drawer').querySelectorAll('[data-dlm]').forEach(x=>x.classList.toggle('on',x===b));$('#dl-dw').hidden=d.dlm!=='days';$('#dl-dd').hidden=d.dlm!=='date';prev()}));
  $('#dl-days').addEventListener('input',prev);$('#dl-end').addEventListener('change',prev);prev()}
function saveDelay(d){const t=S.tasks.get(d.tid);if(!t||!canEditTask(t))return formErr('Only the task owner, the project lead or an admin can report a delay on this task.');
  const cat=$('#dl-cat').value,other=$('#dl-other').value.trim(),det=$('#dl-det').value.trim();
  if(cat==='other'&&!other)return formErr('Describe the reason.');if(det.length<5)return formErr('Say what happened (a short sentence is enough).');
  const ne=delayNewEnd(t);if(ne==null)return formErr(d.dlm==='date'?'Pick a new end date after the current one.':'Enter the number of working days of delay.');
  const I=model(t.projectId).info.get(t.id),o=S.members.get(t.assignee)||null,days=wdCount(I.e+1,ne,o,holS()),p=S.projects.get(t.projectId)||{};
  const rec={id:uid('dl'),at:Date.now(),by:meKey(),cat,catOther:cat==='other'?other:'',details:det,fromEnd:n2d(I.e),toEnd:n2d(ne),days};
  const file=$('#dl-file').files&&$('#dl-file').files[0];
  const nt={...clean(t),end:n2d(ne),delays:[...delaysOf(t),rec]};if(!t.plan0)nt.plan0={s:t.start||n2d(I.s),e:t.end||n2d(I.e)};
  const saved=put('tasks',t.id,nt);
  put('updates',uid('u'),{taskId:t.id,pid:t.projectId,t:Date.now(),by:meKey(),event:'Delay reported',remarks:`[${delayTxt(rec)}] ${det} · end ${fmt(I.e)} → ${fmt(ne)} (+${days} working day${days>1?'s':''})`,progress:I.prog,delay:rec.id});
  logH({act:'edited',kind:'task',id:t.id,pid:t.projectId,title:t.title,code:p.code||'',ch:[`Delay reported: ${delayTxt(rec)}`,`End: ${fmt(I.e)} → ${fmt(ne)} (+${days} working days)`,det.length>90?det.slice(0,90)+'…':det]});
  if(file)(async()=>{try{await saved;await uploadCore(t.projectId,[file],{category:'Other',other:'Delay evidence',rev:'A',remarks:`Delay ${fmt(I.e)} → ${fmt(ne)}: ${det}`.slice(0,1000),task:t.id});toast('Evidence uploaded')}catch(e){toast((e&&e.message)||'Evidence upload failed. Add it in Details & documents.')}})();
  closeDrawer();toast(`Delay reported: ${t.title} now ends ${fmt(ne)}. Linked tasks follow automatically.`);loadCache=null}
// delays across the visible projects, honouring the Follow-ups project / person filters
function delayRows(pid){const out=[];for(const t of S.tasks.values()){if(!canSeeProject(t.projectId)||!inYearP(S.projects.get(t.projectId)))continue;if(pid&&t.projectId!==pid)continue;if(!pid&&ui.fuProject&&t.projectId!==ui.fuProject)continue;if(!pid&&ui.fuPerson&&t.assignee!==ui.fuPerson)continue;
  const p=S.projects.get(t.projectId);if(!p)continue;for(const x of delaysOf(t))if(pid||inYearD(dayOf(x.at||0)))out.push({t,p,x})}return out.sort((a,b)=>b.x.at-a.x.at)}
function delayByCat(rows){const m=new Map();for(const r of rows){const k=delayTxt(r.x);const v=m.get(k)||{n:0,days:0};v.n++;v.days+=+r.x.days||0;m.set(k,v)}return [...m.entries()].sort((a,b)=>b[1].days-a[1].days||b[1].n-a[1].n)}
function paretoHtml(rows){const C=delayByCat(rows),tot=C.reduce((a,c)=>a+c[1].days,0)||1;let cum=0;
  return `<div class="pareto">${C.map(([k,v])=>{cum+=v.days;return `<div class="pr-row"><span class="pr-l">${h(k)}</span><span class="pr-bar"><i style="width:${Math.max(2,Math.round(v.days/tot*100))}%"></i></span><span class="pr-v"><b>${v.days}</b> d · ${v.n}×</span><span class="pr-c muted small">${Math.round(cum/tot*100)}%</span></div>`}).join('')}</div>`}
function viewDelays(){const rows=delayRows(''),tot=rows.reduce((a,r)=>a+(+r.x.days||0),0),ps=new Set(rows.map(r=>r.p.id)).size;
  const sel=(id,cur,opts,all)=>`<select class="sel" data-change="${id}" aria-label="${all}"><option value="">${all}</option>${opts.map(([v,l])=>`<option value="${v}" ${cur===v?'selected':''}>${h(l)}</option>`).join('')}</select>`;
  return `<div class="toolbar">${sel('fuProject',ui.fuProject||'',projList().map(p=>[p.id,`${p.code||''} · ${p.name}`]),'All projects')}${sel('fuPerson',ui.fuPerson||'',workList().map(m=>[m.id,m.name]),'Everyone')}<span class="spacer"></span><button class="btn sm" data-action="delay-csv" ${rows.length?'':'disabled'}>Export CSV</button></div>
  <div class="stats"><div class="stat ${rows.length?'warn':''}"><b>${rows.length}</b><span>Delays reported</span></div><div class="stat ${tot?'bad':''}"><b>${tot}</b><span>Working days lost</span></div><div class="stat"><b>${ps}</b><span>Projects affected</span></div></div>
  ${rows.length?`<section class="panel"><div class="panel-h"><h2>Delay days by reason</h2><span class="muted small">largest first · cumulative %</span></div>${paretoHtml(rows)}</section>
  <section class="panel"><div class="panel-h"><h2>All delays</h2></div><div class="dltab"><table class="ptab"><thead><tr><th>Reported</th><th>Project</th><th>Task</th><th>Owner</th><th>Reason</th><th class="n">Days</th><th>End</th><th>Details</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="mono small">${fmt(dayOf(r.x.at))}</td><td><span class="mono">${h(r.p.code||'')}</span></td><td><button class="linkbtn" data-action="edit-task" data-id="${r.t.id}">${h(r.t.title)}</button></td><td>${h(mName(r.t.assignee))}</td><td>${h(delayTxt(r.x))}</td><td class="n">${r.x.days}</td><td class="mono small">${fmt(d2n(r.x.fromEnd))} → ${fmt(d2n(r.x.toEnd))}</td><td class="small">${h(r.x.details)}<br><span class="muted">by ${h(pName(r.x.by))}</span></td></tr>`).join('')}</tbody></table></div></section>`:'<div class="panel"><div class="empty-note">No delays reported for these filters. Use “Report delay” on a task when work will finish later than planned.</div></div>'}`}
async function delayCsv(){const dl=await afDl();if(!dl)return;const rows=delayRows('');const q=v=>`"${String(v??'').replace(/"/g,'""')}"`;
  const L=[['Reported','Project code','Project','Task','Owner','Reason','Working days','Old end','New end','Details','Reported by'].map(q).join(',')];
  for(const r of rows)L.push([fmtY(dayOf(r.x.at)),r.p.code,r.p.name,r.t.title,mName(r.t.assignee),delayTxt(r.x),r.x.days,fmtY(d2n(r.x.fromEnd)),fmtY(d2n(r.x.toEnd)),r.x.details,pName(r.x.by)].map(q).join(','));
  try{await dl.save({filename:`Delays_${n2d(TODAY)}.csv`,data:'﻿'+L.join('\r\n')});toast('Delay report saved')}catch(e){if(!(e&&e.code==='declined'))toast('Couldn’t save the report.')}}
function projDelaysHtml(p){const rows=delayRows(p.id);if(!rows.length)return '';const tot=rows.reduce((a,r)=>a+(+r.x.days||0),0);
  return `<section class="panel"><div class="panel-h"><h2>Delays</h2><span class="muted small">${rows.length} reported · ${tot} working day${tot===1?'':'s'}</span></div>${paretoHtml(rows)}
    <div class="alist">${rows.slice(0,8).map(r=>`<button class="aitem" data-action="edit-task" data-id="${r.t.id}"><span style="min-width:0"><div class="at">${h(r.t.title)} <span class="slip small">+${r.x.days} d</span></div><div class="as">${fmt(dayOf(r.x.at))} · ${h(delayTxt(r.x))} · ${h(r.x.details)}</div></span></button>`).join('')}</div></section>`}

/* ---------- my leave: every user with a team profile; takes effect straight away ---------- */
function drMyLeave(d){const m=myMember();if(!m)return `${dHead('My leave','Not linked')}<div class="dr-b"><p>Your login isn’t linked to a team member.</p></div>`;
  const L=(m.leave||[]).slice().sort((a,b)=>a.from<b.from?-1:1),today=n2d(TODAY);
  const row=(r,i)=>{const past=(r.to||r.from)<today;return `<div class="lvrow ${past?'past':''}"><span class="mono small">${fmt(d2n(r.from))}${r.to&&r.to!==r.from?' – '+fmt(d2n(r.to)):''}${r.half?' · ½ day':''}</span><span class="small">${h(r.note||'Leave')}</span>${past?'<span class="muted small">Past</span>':`<button type="button" class="linkbtn" data-mylv="${h(r.from)}|${h(r.to||r.from)}">Cancel</button>`}</div>`};
  return `<form id="f" novalidate>${dHead('Your account','My leave')}
  <div class="dr-b">
    <div class="rollup">Leave takes effect straight away: the end dates of your open tasks move out by the leave days (and linked tasks follow), and your capacity drops in Resource load. Cancelling leave moves them back. Your project leads and admins are told by email. Half days don’t move dates.</div>
    <div class="two"><div class="fld"><label for="ml-from">From</label><input type="date" id="ml-from" min="${today}"></div><div class="fld"><label for="ml-to">To</label><input type="date" id="ml-to" min="${today}"></div></div>
    <label class="chk"><input type="checkbox" id="ml-half"> Half day (one day only)</label>
    <div class="fld"><label for="ml-note">Reason</label><input type="text" id="ml-note" maxlength="120" placeholder="e.g. Annual leave, family function, medical"></div>
    <div id="mlWarn"></div>
    <div class="err" id="fErr" hidden></div>
    <div class="fld"><span class="lab">Your leave</span><div class="lvlist">${L.length?L.map(row).join(''):'<span class="hint">No leave added.</span>'}</div><span class="hint">Past leave is kept and can’t be changed here; ask an admin to correct it.</span></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary">Add leave</button><button type="button" class="btn" data-action="close-drawer">Close</button></div></form>`}
function myLeaveClash(m,a,b){const out=[];for(const t of S.tasks.values()){if(t.assignee!==m.id||projFrozen(t.projectId))continue;const s=d2n(t.start),e=d2n(t.end);if(s==null||e==null||(+t.progress||0)>=100||t.status==='done')continue;if(s<=b&&e>=a)out.push(t)}return out}
function wireMyLeave(d){const m=myMember();if(!m)return;const f=$('#ml-from'),t=$('#ml-to'),hf=$('#ml-half'),w=$('#mlWarn');
  const upd=()=>{const a=d2n(f.value),b=d2n(t.value)??a;if(hf.checked&&f.value)t.value=f.value;if(a==null){w.innerHTML='';return}
    const c=myLeaveClash(m,a,b);w.innerHTML=c.length?`<div class="alert"><span>You own <b>${c.length}</b> open task${c.length>1?'s':''} in these days: ${c.slice(0,4).map(x=>`${h((S.projects.get(x.projectId)||{}).code||'')} ${h(x.title)}`).join(', ')}${c.length>4?'…':''}. Your lead will see it in the Load advisor.</span></div>`:''};
  f.addEventListener('change',()=>{if(!t.value||d2n(t.value)<d2n(f.value))t.value=f.value;upd()});t.addEventListener('change',upd);hf.addEventListener('change',upd);
  $('#drawer').querySelectorAll('[data-mylv]').forEach(b=>b.addEventListener('click',()=>{const [a,z]=b.dataset.mylv.split('|');const mm=myMember();const L=(mm.leave||[]).filter(r=>!(r.from===a&&(r.to||r.from)===z));saveMyLeaveList(mm,L,`Cancelled leave ${fmt(d2n(a))}${z!==a?' – '+fmt(d2n(z)):''}`);renderDrawer()}))}
function saveMyLeaveList(m,L,what){put('members',m.id,{...clean(m),leave:L},{sys:true});logH({act:'changed',kind:'leave',title:what,ch:[]});loadCache=null;toast(what)}
function saveMyLeave(d){const m=myMember();if(!m)return formErr('Your login isn’t linked to a team member.');
  const a=$('#ml-from').value,half=$('#ml-half').checked,b=half?a:($('#ml-to').value||a),note=$('#ml-note').value.trim();
  if(!a)return formErr('Pick the first day of leave.');if(a<n2d(TODAY))return formErr('Leave can’t start in the past. Ask an admin to record past leave.');if(d2n(b)<d2n(a))return formErr('Leave ends before it starts.');
  if(d2n(b)-d2n(a)>90)return formErr('Add at most 90 days at a time.');
  if((m.leave||[]).some(r=>!(d2n(r.to||r.from)<d2n(a)||d2n(r.from)>d2n(b))))return formErr('You already have leave in these days. Cancel it first to change it.');
  const rec={from:a,to:b,note,by:meKey(),at:Date.now()};if(half)rec.half=true;
  saveMyLeaveList(m,[...(m.leave||[]),rec],`Leave added: ${fmt(d2n(a))}${b!==a?' – '+fmt(d2n(b)):''}${half?' (½ day)':''}`);renderDrawer()}

/* ---------- import company holidays from Excel / CSV (admins) ---------- */
const HOL_TYPES=['National','Office','Optional'];
function holImportHtml(){const P=ui.holPlan;
  return `<div class="holimp"><div class="bkacts"><label class="btn bkfile">Import holidays (.xlsx / .csv)<input type="file" accept=".xlsx,.xls,.csv" id="hol-file" hidden></label><button type="button" class="btn" data-action="hol-template">Download template</button></div>
    <span class="hint">Columns: <b>Date</b> (DD/MM/YYYY), <b>Holiday name</b>, <b>Type</b> (National, Office or Optional; optional). A sheet copied from HR works too if it has a date column and a name column.</span>
    ${P&&P.err?`<div class="banner bad"><span>${h(P.err)}</span></div>`:''}
    ${P&&P.rows?`<div class="bkplan"><div><b>${h(P.name)}</b>: <b>${P.add.length}</b> new · ${P.same} already here · ${P.upd.length} with a different name or type${P.bad.length?` · <span class="slip">${P.bad.length} row${P.bad.length>1?'s':''} skipped</span>`:''}</div>
      ${P.add.length?`<div class="alist">${P.add.slice(0,40).map(x=>`<div class="skrow2"><span class="mono small">${WD[dow(d2n(x.date))]} ${fmtY(d2n(x.date))}</span><div>${h(x.name)}${x.type?` <span class="tag">${h(x.type)}</span>`:''}</div></div>`).join('')}${P.add.length>40?`<div class="empty-note">and ${P.add.length-40} more</div>`:''}</div>`:''}
      ${P.bad.length?`<p class="hint" style="margin:0">Skipped: ${P.bad.slice(0,6).map(b=>`row ${b.row} (${h(b.why)})`).join(', ')}${P.bad.length>6?'…':''}</p>`:''}
      ${P.upd.length?`<label class="chk"><input type="checkbox" id="hol-upd"> Also update the ${P.upd.length} holiday${P.upd.length>1?'s':''} whose name or type differs</label>`:''}
      <div class="bkacts"><button type="button" class="btn primary" data-action="hol-apply" ${P.add.length||P.upd.length?'':'disabled'}>Import ${P.add.length} holiday${P.add.length===1?'':'s'}</button><button type="button" class="btn" data-action="hol-cancel">Cancel</button></div></div>`:''}</div>`}
const MONS={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};
function holDate(v){if(v==null||v==='')return null;
  if(v instanceof Date&&!isNaN(v))return n2d(Math.round(Date.UTC(v.getFullYear(),v.getMonth(),v.getDate())/DAY));
  if(typeof v==='number'&&v>20000&&v<80000)return n2d(Math.round(v)+Math.round(Date.UTC(1899,11,30)/DAY));
  const s=String(v).trim();let m;const mk=(y,mo,d)=>{y=+y;if(y<100)y+=2000;const n=Math.round(Date.UTC(y,mo,+d)/DAY);const back=new Date(n*DAY);return back.getUTCDate()===+d&&back.getUTCMonth()===mo?n2d(n):null};
  if((m=/^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)))return mk(m[1],+m[2]-1,m[3]);
  if((m=/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s)))return mk(m[3],+m[2]-1,m[1]);
  if((m=/^(\d{1,2})[\s\-\/]*([A-Za-z]{3,9})[\s\-\/,]*(\d{2,4})$/.exec(s))&&MONS[m[2].toLowerCase().slice(0,m[2].length>4?4:3)]!=null)return mk(m[3],MONS[m[2].toLowerCase().slice(0,3)],m[1]);
  if((m=/^([A-Za-z]{3,9})[\s\-]+(\d{1,2}),?[\s\-]+(\d{2,4})$/.exec(s))&&MONS[m[1].toLowerCase().slice(0,3)]!=null)return mk(m[3],MONS[m[1].toLowerCase().slice(0,3)],m[2]);
  return null}
async function holPick(file){if(!file)return;
  try{await loadXlsx()}catch(e){ui.holPlan={err:'Couldn’t load the Excel reader. Check the internet connection and try again.'};return render()}
  let rows;try{const X=window.XLSX,wb=X.read(await file.arrayBuffer(),{type:'array',cellDates:true});const ws=wb.Sheets[wb.SheetNames[0]];rows=X.utils.sheet_to_json(ws,{header:1,raw:true,defval:''})}catch(e){ui.holPlan={err:'This file couldn’t be read as a spreadsheet.'};return render()}
  let hi=rows.findIndex(r=>r.some(c=>/date/i.test(String(c))));if(hi<0){ui.holPlan={err:'No “Date” column found. Use the template, or add a header row with Date and Holiday name.'};return render()}
  const H=rows[hi].map(c=>String(c).toLowerCase().trim());const di=H.findIndex(c=>/date/.test(c));
  let ni=H.findIndex((c,i)=>i!==di&&/(holiday|name|occasion|festival|description|particular|event)/.test(c));if(ni<0)ni=H.findIndex((c,i)=>i!==di&&c&&!/day$|type|^s\.?\s?no|sr/.test(c));
  const ti=H.findIndex((c,i)=>i!==di&&i!==ni&&/(type|category|kind)/.test(c));
  const cur=new Map(holidayList().map(x=>[x.date,x]));const add=[],upd=[],bad=[];let same=0;const seen=new Set();
  for(let r=hi+1;r<rows.length;r++){const R=rows[r];if(!R||R.every(c=>String(c).trim()===''))continue;
    const date=holDate(R[di]),name=String(ni>=0?R[ni]:'').trim().slice(0,60)||'Holiday';let type=ti>=0?String(R[ti]).trim():'';const tt=HOL_TYPES.find(x=>x.toLowerCase()===type.toLowerCase().slice(0,x.length));type=tt||(type?type.slice(0,20):'');
    if(!date){bad.push({row:r+1,why:'date not understood'});continue}if(seen.has(date)){bad.push({row:r+1,why:'same date twice'});continue}seen.add(date);
    const c=cur.get(date),x={date,name,...(type?{type}:{})};if(!c)add.push(x);else if((c.name||'')===name&&(c.type||'')===(type||''))same++;else upd.push(x)}
  ui.holPlan={name:file.name,rows:true,add,upd,bad,same};render()}
function holApply(){const P=ui.holPlan;if(!P||!P.rows||!canManage())return;const doUpd=!!($('#hol-upd')&&$('#hol-upd').checked);
  const map=new Map(holidayList().map(x=>[x.date,x]));for(const x of P.add)map.set(x.date,x);if(doUpd)for(const x of P.upd)map.set(x.date,x);
  put('calendar','holidays',{days:[...map.values()].sort((a,b)=>a.date<b.date?-1:1)},{sys:true});loadCache=null;
  logH({act:'changed',kind:'settings',title:`imported ${P.add.length} holiday${P.add.length===1?'':'s'} from ${P.name}`,ch:[...P.add.slice(0,20).map(x=>`${fmtY(d2n(x.date))} ${x.name}`),...(doUpd&&P.upd.length?[`${P.upd.length} updated`]:[])]});
  toast(`${P.add.length} holiday${P.add.length===1?'':'s'} imported${doUpd&&P.upd.length?`, ${P.upd.length} updated`:''}`);ui.holPlan=null;render()}
async function holTemplate(){const dl=await afDl();if(!dl)return;try{await loadXlsx()}catch(e){return toast('Couldn’t load the Excel maker. Check the internet connection.')}
  const X=window.XLSX,y=+n2d(TODAY).slice(0,4)+1,XL0=Date.UTC(1899,11,30)/DAY;
  const rows=[['Date','Holiday name','Type'],[`${y}-01-26`,'Republic Day','National'],[`${y}-08-15`,'Independence Day','National'],[`${y}-10-02`,'Gandhi Jayanti','National'],[`${y}-01-01`,'New Year (office)','Office']];
  const ws=X.utils.aoa_to_sheet(rows);for(let r=2;r<=rows.length;r++){const c=ws['A'+r];const n=d2n(c.v);c.t='n';c.v=n-XL0;c.z='dd/mm/yyyy'}ws['!cols']=[{wch:14},{wch:32},{wch:12}];
  const wb=X.utils.book_new();X.utils.book_append_sheet(wb,ws,'Holidays');const out=X.write(wb,{bookType:'xlsx',type:'array'});
  try{await dl.save({filename:'Holidays_template.xlsx',data:new Blob([out],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})});toast('Template saved')}catch(e){if(!(e&&e.code==='declined'))toast('Couldn’t save the template.')}}
function wireHolImport(){const f=$('#hol-file');if(f)f.addEventListener('change',()=>{const x=f.files&&f.files[0];f.value='';holPick(x)})}

/* ---------- abort / reopen a project; Completed is set by the server when all work is done ---------- */
const CLOSE_ACT={aborted:'Aborted',reopened:'Reopened',completed:'Completed',reactivated:'Back to Active'};
function closedBanner(p){const L=Array.isArray(p.closeLog)?p.closeLog:[],last=L[L.length-1];
  if(!projClosed(p))return '';
  const who=last?(last.by==='auto'?'automatically':`by ${h(pName(last.by))}`):'';
  return `<div class="banner ${p.status==='aborted'?'bad':'okb'} closedb"><span>${p.status==='aborted'?'⛔':'✅'} <b>${PSTATUS[p.status]}</b>${last?` on ${fmtTs(last.at)} ${who}`:''}${last&&last.comment?` · “${h(last.comment)}”`:''}. ${p.status==='aborted'?'All tasks are frozen. Daily log entries can still be added.':'All tasks are frozen. The lead or an admin can still add new work, which makes the project Active again.'}</span></div>`}
function closeHistoryHtml(p){const L=Array.isArray(p.closeLog)?p.closeLog:[];if(!L.length)return '';
  return `<section class="panel"><h2>Status history</h2><div class="clog">${L.slice().reverse().map(x=>`<div class="clog-r"><span class="chip st-${x.act==='aborted'?'aborted':x.act==='completed'?'done':'active'}">${CLOSE_ACT[x.act]||x.act}</span><span>${fmtTs(x.at)} · ${x.by==='auto'?'automatic':h(pName(x.by))}${x.comment?` · ${h(x.comment)}`:''}</span></div>`).join('')}</div></section>`}
function drProjClose(d){const p=S.projects.get(d.pid);if(!p)return `${dHead('Project','Not found')}`;const ab=d.act==='abort';
  const m=model(p.id);
  return `<form id="f" novalidate>${dHead(`${h(p.code||'')} · ${h(p.name)}`,ab?'Abort project':'Reopen project')}
  <div class="dr-b">
    ${ab?`<div class="alert"><span>Aborting stops this project. All <b>${m.leaves.length}</b> task${m.leaves.length===1?'':'s'} freeze as they are now (${m.prog}% complete): no changes to dates, owners, progress, milestones, follow-ups or documents. It leaves the resource load. Daily log entries can still be added. The lead or an admin can reopen it later.</span></div>`
      :`<div class="rollup">Now <b>${PSTATUS[p.status]}</b>. Reopening sets it to <b>Active</b> and unfreezes its tasks.</div>`}
    <div class="fld"><label for="pc-rem">${ab?'Why is the project being aborted?':'Why is the project being reopened?'}</label><textarea id="pc-rem" maxlength="1000" autofocus placeholder="${ab?'e.g. Customer cancelled the order; design frozen at EVT':'e.g. Customer asked for revision B'}"></textarea><span class="hint">Required. Saved in the project’s status history and History, and emailed to the project’s stakeholders.</span></div>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn ${ab?'danger':'primary'}">${ab?'Abort project':'Reopen project'}</button><button type="button" class="btn" data-action="close-drawer">Cancel</button></div></form>`}
function saveProjClose(d){const p=S.projects.get(d.pid);if(!p||!(d.act==='abort'?canAbortProj(p.id):canManageProj0(p.id)))return formErr('Only the project lead or an admin can do this.');
  const rem=$('#pc-rem').value.trim();if(rem.length<3)return formErr('Write a short comment.');
  const ab=d.act==='abort';if(ab&&projClosed(p))return formErr('This project is already closed.');if(!ab&&!projClosed(p))return formErr('This project is already open.');
  const entry={act:ab?'aborted':'reopened',at:Date.now(),by:meKey(),comment:rem,from:p.status||'planning'};
  put('projects',p.id,{...clean(p),status:ab?'aborted':'active',closeLog:[...(Array.isArray(p.closeLog)?p.closeLog:[]),entry]},{sys:true});
  logH({act:'changed',kind:'project',id:p.id,pid:p.id,title:p.name,code:p.code||'',ch:[`Status: ${PSTATUS[p.status]||p.status} → ${ab?'Aborted':'Active'}`,`Comment: ${rem.length>100?rem.slice(0,100)+'…':rem}`]});
  closeDrawer();loadCache=null;toast(ab?'Project aborted. Its tasks are frozen.':'Project reopened');render()}

/* ---------- load advisor: finds overloads and proposes fixes (transfer by skill, shift within slack, extend) ---------- */
// Transfers never move work straight away: the lead or an admin proposes, the new owner accepts in the app.
const SKR={expert:3,assist:1};
const skRank=(m,sk)=>!sk||sk==='general'||sk==='none'?2:((m.skills||{})[sk]?(SKR[m.skills[sk]]||2):0);
const skLvlTxt=(m,sk)=>!sk||sk==='general'||sk==='none'?'':((m.skills||{})[sk]==='expert'?'Expert':(m.skills||{})[sk]==='assist'?'Can assist':'Skilled');
const trPending=t=>!!(t&&t.transfer&&t.transfer.status==='pending'&&t.transfer.to);
const canManageProj=pid=>canWrite()&&(isAdmin()||isLead(pid));
function myTransfers(){const mid=myMid();if(!mid)return [];return [...S.tasks.values()].filter(t=>trPending(t)&&t.transfer.to===mid&&S.projects.has(t.projectId))}
function pendingTransfers(){return [...S.tasks.values()].filter(t=>trPending(t)&&S.projects.has(t.projectId)&&canSeeProject(t.projectId))}
function advisorPeople(){return workList().filter(m=>!m.accessDisabled)}
function planAdvice(){
  const L=computeLoad(),H=Math.min(L.weeks.length,12),nW=L.weeks.length;
  const info=new Map();for(const p of S.projects.values()){if(projClosed(p)||!canSeeProject(p.id)||!inYearP(p))continue;const m=model(p.id);for(const id of m.leaves)info.set(id,{p,m,I:m.info.get(id)})}
  const sim=new Map();for(const [mid,P] of L.people)sim.set(mid,P.load.slice());
  const cap=mid=>(L.people.get(mid)||{}).cap||[];
  const distW=(t,I,owner,s,e)=>{const d=taskDaily(t,{s,e,prog:I.prog},owner,L.hol)||new Map(),w=new Map();for(const [n,hh] of d){const k=Math.floor((n-L.W0)/7);if(k>=0&&k<nW)w.set(k,(w.get(k)||0)+hh)}return w};
  const addW=(mid,w,sign)=>{const a=sim.get(mid);if(!a)return;for(const [k,hh] of w)a[k]+=sign*hh};
  const ppl=advisorPeople();
  // pending transfers count as done in the plan, so the same overload isn't proposed twice
  const used=new Set();
  for(const t of pendingTransfers()){const x=info.get(t.id);if(!x)continue;used.add(t.id);const from=S.members.get(t.assignee),to=S.members.get(t.transfer.to);
    if(from)addW(from.id,distW(t,x.I,from,x.I.s,x.I.e),-1);if(to)addW(to.id,distW(t,x.I,to,x.I.s,x.I.e),1)}
  const limitEnd=x=>{const {m,I,p}=x;let lim=Infinity;for(const id of [I.t.id,...I.anc])for(const sid of (m.succ.get(id)||[]))lim=Math.min(lim,m.info.get(sid).s-1);
    if(!isFinite(lim)){const tg=d2n(p.target);lim=tg!=null?Math.max(tg,I.e):m.e}return lim};
  const peakOf=(mid,w)=>{const a=sim.get(mid),c=cap(mid);let pk=0;for(const [k] of w){const u=c[k]?a[k]/c[k]:(a[k]>0?Infinity:0);if(u>pk)pk=u}return pk};
  // all fixes for one task that lower `mid`'s load in week `w`
  function optionsFor(x,mid,w){
    const {I,p}=x,t=I.t,owner=S.members.get(mid),out=[];
    const old=distW(t,I,owner,I.s,I.e),relief=old.get(w)||0;if(relief<=0.01)return out;
    const excess=Math.max(0.01,sim.get(mid)[w]-cap(mid)[w]),eff=Math.min(relief,excess);// relief beyond the overload earns nothing
    const pri=Math.min(projRank(p),20);// higher number = lower-priority project = its work moves first
    // 1) transfer to someone with the skill and room in every affected week
    for(const m2 of ppl){if(m2.id===mid||!sim.has(m2.id))continue;const rk=skRank(m2,t.skill);if(!rk)continue;
      const nw=distW(t,I,m2,I.s,I.e);if(![...nw.values()].some(v=>v>0))continue;const a=sim.get(m2.id),c=cap(m2.id);
      if([...nw].some(([k,hh])=>a[k]+hh>c[k]+0.01))continue;
      if(+m2.wip>0&&concurrent(m2.id,I.s,I.e,t.id)+1>+m2.wip)continue;
      addW(m2.id,nw,1);const pk=peakOf(m2.id,nw);addW(m2.id,nw,-1);
      out.push({kind:'transfer',x,mid,w,to:m2.id,nw,old,relief,peak:pk,rk,score:eff*2+rk*8-pk*20+pri*4+(I.prog>0?-6:0)})}
    // 2) shift later within slack (not started tasks only), same owner
    if(I.s>TODAY&&!(I.prog>0)){const lim=limitEnd(x);
      for(let k=1;k<=Math.min(lim-I.e,90);k++){const ns=I.s+k,ne=I.e+k;if(isWE(ns))continue;if(ne>lim)break;
        const nw=distW(t,I,owner,ns,ne),a=sim.get(mid),c=cap(mid);const tmp=a.slice();for(const [kk,hh] of old)tmp[kk]-=hh;for(const [kk,hh] of nw)tmp[kk]+=hh;
        if([...nw.keys()].some(kk=>kk!==w&&tmp[kk]>c[kk]+0.01&&tmp[kk]>a[kk]+0.01))continue;
        if(tmp[w]<a[w]-0.01){out.push({kind:'shift',x,mid,w,s:ns,e:ne,nw,old,relief:a[w]-tmp[w],score:Math.min(a[w]-tmp[w],excess)*2+14-k*0.4+pri*4});break}}}
    return out}
  const problems=[];let total=0;
  for(const [mid,P] of L.people){if(!ppl.some(m=>m.id===mid))continue;for(let w=0;w<H;w++)if(P.load[w]>P.cap[w]+0.01){total++;if(sim.get(mid)[w]>P.cap[w]+0.01)problems.push({mid,w,load:sim.get(mid)[w],cap:P.cap[w]})}}
  problems.sort((a,b)=>(b.cap?b.load/b.cap:99)-(a.cap?a.load/a.cap:99));
  const props=[],esc=[];
  for(const pb of problems){let guard=0;const startLoad=sim.get(pb.mid)[pb.w];
    while(sim.get(pb.mid)[pb.w]>pb.cap+0.01&&guard++<8){
      const cands=(L.people.get(pb.mid).items[pb.w]||[]).map(it=>info.get(it.I.t.id)).filter(x=>x&&!used.has(x.I.t.id)&&x.I.status!=='done'&&x.I.t.assignee===pb.mid);
      let opts=[];for(const x of cands)opts.push(...optionsFor(x,pb.mid,pb.w));
      if(!opts.length)break;
      opts.sort((a,b)=>b.score-a.score);const best=opts[0];
      const alts=[];const seen=new Set([best.kind+best.x.I.t.id+(best.to||'')]);
      for(const o of opts){const k=o.kind+o.x.I.t.id+(o.to||'');if(seen.has(k))continue;seen.add(k);alts.push(o);if(alts.length>=3)break}
      const before={from:sim.get(pb.mid)[pb.w]};
      addW(pb.mid,best.old,-1);
      if(best.kind==='transfer'){before.to=sim.get(best.to).slice();addW(best.to,best.nw,1)}else addW(pb.mid,best.nw,1);
      used.add(best.x.I.t.id);
      props.push({id:'a'+props.length,pb,best,alts,fromBefore:before.from,fromAfter:sim.get(pb.mid)[pb.w],cap:pb.cap,
        toPeak:best.kind==='transfer'?peakOf(best.to,best.nw):null});
    }
    if(sim.get(pb.mid)[pb.w]>pb.cap+0.01){
      // nothing fits: delay or extend a task in that week (may move linked tasks and the project target)
      const owner=S.members.get(pb.mid),a0=sim.get(pb.mid),cc=cap(pb.mid);
      const cands=(L.people.get(pb.mid).items[pb.w]||[]).map(it=>info.get(it.I.t.id)).filter(x=>x&&!used.has(x.I.t.id)&&x.I.status!=='done'&&x.I.t.assignee===pb.mid);
      const eopts=[];
      const fits=(old,nw)=>{const tmp=a0.slice();for(const [kk,hh] of old)tmp[kk]-=hh;for(const [kk,hh] of nw)tmp[kk]+=hh;return tmp[pb.w]<=cc[pb.w]+0.01&&![...nw.keys()].some(kk=>kk!==pb.w&&tmp[kk]>cc[kk]+0.01&&tmp[kk]>a0[kk]+0.01)?tmp:null};
      for(const x of cands){const {I,p,m}=x,t=I.t,old=distW(t,I,owner,I.s,I.e),pri=Math.min(projRank(p),20),tg=d2n(p.target),linked=[t.id,...I.anc].some(id=>(m.succ.get(id)||[]).length);
        const wt=1+(20-pri)/8;// delaying a high-priority project costs more
        if(I.s>TODAY&&!(I.prog>0))for(let k=1;k<=60;k++){const ns=I.s+k,ne=I.e+k;if(isWE(ns))continue;const nw=distW(t,I,owner,ns,ne),tmp=fits(old,nw);
          if(tmp){eopts.push({kind:'delay',x,s:ns,e:ne,days:k,tmp,tgMove:tg!=null&&ne>tg?ne:null,linked,cost:k*wt});break}}
        for(let k=1;k<=60;k++){const ne=addWD(I.e,k+1,owner,L.hol);const nw=distW(t,I,owner,I.s,ne),tmp=fits(old,nw);
          if(tmp){eopts.push({kind:'extend',x,s:I.s,e:ne,days:ne-I.e,tmp,tgMove:tg!=null&&ne>tg?ne:null,linked,cost:(ne-I.e)*wt+1});break}}}
      eopts.sort((p1,p2)=>p1.cost-p2.cost);
      if(eopts.length){const best=eopts[0];sim.set(pb.mid,best.tmp);used.add(best.x.I.t.id);
        esc.push({id:'e'+esc.length,pb,opts:eopts.slice(0,3),fromBefore:a0[pb.w],left:false})}
      else esc.push({id:'e'+esc.length,pb,left:true,load:a0[pb.w]})}
  }
  return {props,esc,problems,total,L,pending:pendingTransfers()};
}
function advOptTxt(o,L){const t=o.x.I.t,p=o.x.p,code=`${h(p.code||'')} ${o.x.I.wbs}`;
  const wk=`W${isoWeek(L.weeks[o.w])}`;
  if(o.kind==='transfer'){const m2=S.members.get(o.to),lv=skLvlTxt(m2,t.skill);
    return `<b>Transfer</b> <span class="mono">${code}</span> ${h(t.title)} <span class="muted">(${fh(o.relief)} h in ${wk})</span> to <b>${h(m2.name)}</b>${lv?` · ${h(skillName(t.skill))} ${lv}`:''} · ${h(m2.name)} peaks at ${Math.round(o.peak*100)}%`}
  return `<b>Shift later</b> <span class="mono">${code}</span> ${h(t.title)}: <s>${fmt(o.x.I.s)} – ${fmt(o.x.I.e)}</s> → <b>${fmt(o.s)} – ${fmt(o.e)}</b> (+${o.s-o.x.I.s}d, within slack, same owner)`}
function drAdvisor(d){
  if(!d.plan){d.plan=planAdvice();d.choice={}}
  const {props,esc,problems,total,L,pending}=d.plan;const done={};const applied=d.log||[];
  const head=pb=>{const P=L.people.get(pb.mid)||{},r=(P.routine||[])[pb.w]||0,lg=(P.logged||[])[pb.w]||0,bk=(P.booked||[])[pb.w]||0;return `<div class="adv-h">${av(pb.mid)}<span><b>${h(mName(pb.mid))}</b> · W${isoWeek(L.weeks[pb.w])} (${fmt(L.weeks[pb.w])}) · <span class="over">${pctTxt(pb.load,pb.cap)}</span> <span class="muted">${fh(pb.load)} h of ${fh(pb.cap)} h${r||lg||bk?` · incl. ${[lg?`${fh(lg)} h already logged`:'',bk?`${fh(bk)} h booked ahead`:'',r?`${fh(r)} h routine work`:''].filter(Boolean).join(', ')}`:''}</span></span></div>`};
  const leadTxt=pid=>{const p=S.projects.get(pid);return p&&p.owner?`the project lead (${h(mName(p.owner))})`:'the project lead'};
  const cards=props.map(a=>{const opts=[a.best,...a.alts],ch=d.choice[a.id]??0,pid=a.best.x.p.id,ok=opts.some(o=>canManageProj(o.x.p.id));
    if(done[a.id])return `<div class="adv-card done">${head(a.pb)}<div class="adv-done">✓ ${h(done[a.id])}</div></div>`;
    return `<div class="adv-card">${head(a.pb)}
      ${opts.map((o,i)=>{const can=canManageProj(o.x.p.id);return `<label class="adv-opt ${i===0?'rec':''} ${can?'':'no'}"><input type="radio" name="${a.id}" value="${i}" ${ch==i?'checked':''} ${can?'':'disabled'}><span>${i===0?'<span class="tag rec">Recommended</span> ':''}${advOptTxt(o,L)}${i===0?`<br><span class="muted small">${h(mName(a.pb.mid))} ${pctTxt(a.fromBefore,a.cap)} → ${pctTxt(a.fromAfter,a.cap)} in W${isoWeek(L.weeks[a.pb.w])}</span>`:''}${can?'':`<br><span class="muted small">Only ${leadTxt(o.x.p.id)} or an admin can apply this.</span>`}</span></label>`}).join('')}
      <label class="adv-opt"><input type="radio" name="${a.id}" value="skip" ${ch==='skip'?'checked':''}><span class="muted">Leave as it is</span></label>
      ${ok?`<div class="adv-b"><button type="button" class="btn sm primary" data-adv-apply="${a.id}">Apply</button></div>`:''}</div>`}).join('');
  const ecards=esc.map(e=>{
    if(e.left)return `<div class="adv-card warn">${head(e.pb)}<p class="small" style="margin:6px 0 0">No transfer, shift, delay or extension fits: no one else with the skill has room. Consider reducing effort, adding help, or moving other work.</p></div>`;
    const ch=d.choice[e.id]??0;
    return `<div class="adv-card warn">${head(e.pb)}
      ${e.opts.map((o,i)=>{const {I,p}=o.x,can=canManageProj(p.id),code=`<span class="mono">${h(p.code||'')} ${I.wbs}</span> ${h(I.t.title)}`;
        return `<label class="adv-opt ${i===0?'rec':''} ${can?'':'no'}"><input type="radio" name="${e.id}" value="${i}" ${ch==i?'checked':''} ${can?'':'disabled'}><span>${i===0?'<span class="tag esc">Escalation</span> ':''}${o.kind==='delay'?`<b>Delay</b> ${code}: <s>${fmt(I.s)} – ${fmt(I.e)}</s> → <b>${fmt(o.s)} – ${fmt(o.e)}</b> (+${o.days}d)`:`<b>Extend</b> ${code}: end ${fmt(I.e)} → <b>${fmt(o.e)}</b> (+${o.days}d)`} · ${h(mName(e.pb.mid))} ${pctTxt(e.fromBefore,e.pb.cap)} → ${pctTxt(o.tmp[e.pb.w],e.pb.cap)}${projRank(p)<99?` · project P${projRank(p)}`:''}
        ${o.linked?'<br><span class="slip small">Tasks that wait on it move later too.</span>':''}${o.tgMove!=null?`<br><span class="slip small">Moves the project target ${fmt(d2n(p.target))} → ${fmt(o.tgMove)} or later.</span>`:''}${can?'':`<br><span class="muted small">Only ${leadTxt(p.id)} or an admin can apply this.</span>`}</span></label>`}).join('')}
      <label class="adv-opt"><input type="radio" name="${e.id}" value="skip" ${ch==='skip'?'checked':''}><span class="muted">Leave as it is</span></label>
      ${e.opts.some(o=>canManageProj(o.x.p.id))?`<div class="adv-b"><button type="button" class="btn sm" data-adv-apply="${e.id}">Apply</button></div>`:''}</div>`}).join('');
  const nRec=props.filter(a=>!done[a.id]&&(d.choice[a.id]??0)!=='skip'&&canManageProj([a.best,...a.alts][d.choice[a.id]??0].x.p.id)).length;
  const pend=pending.length?`<section class="adv-sec"><h3>Waiting for the new owner to accept <span class="muted small">${pending.length}</span></h3>${pending.map(t=>{const p=S.projects.get(t.projectId)||{},tr=t.transfer;return `<div class="adv-pend"><span style="min-width:0"><b>${h(p.code||'')}</b> ${h(t.title)}<br><span class="muted small">${h(mName(t.assignee))} → <b>${h(mName(tr.to))}</b> · asked ${fmtTs(tr.at)} by ${h(pName(tr.by))}</span></span>${canManageProj(t.projectId)?`<button type="button" class="btn sm" data-tr-cancel="${t.id}">Cancel request</button>`:''}</div>`}).join('')}</section>`:'';
  return `${dHead('Resource load','Load advisor')}
  <div class="dr-b adv">
    ${total>problems.length?`<p class="hint" style="margin:0">${total-problems.length} overloaded person-week${total-problems.length>1?'s are':' is'} covered by a transfer waiting to be accepted.</p>`:''}
    <p style="margin:0">${problems.length?`<b>${problems.length} overloaded person-week${problems.length>1?'s':''}</b> in the next 12 weeks${total>problems.length?' still need a fix':''}. For each one the advisor looks for a teammate with the same skill and free hours, or for slack to shift the task, and puts the best fix first. Work from lower-priority projects moves first. Transfers are sent to the new owner to accept; the task moves when they accept.`:total?'':'No one is overloaded in the next 12 weeks.'}</p>
    ${applied.length?`<section class="adv-sec"><h3>Applied just now</h3>${applied.map(x=>`<div class="adv-done">✓ ${h(x)}</div>`).join('')}</section>`:''}
    ${cards?`<section class="adv-sec"><h3>Fixes</h3>${cards}</section>`:''}
    ${ecards?`<section class="adv-sec"><h3>Needs a bigger change</h3>${ecards}</section>`:''}
    ${pend}
    ${props.length?'<p class="hint">Figures assume the recommended fixes above are applied in order. After you apply fixes the plan is worked out again.</p>':''}
  </div>
  <div class="dr-f">${nRec>1?`<button type="button" class="btn primary" data-adv-all>Apply all chosen (${nRec})</button>`:''}${advUndo?`<button type="button" class="btn" data-adv-undo>Undo last (${advUndo.label})</button>`:''}<span class="spacer"></span><button type="button" class="btn" data-action="close-drawer">Close</button></div>`;
}
let advUndo=null;
function advApply(d,ids){
  const out=[],undo={tasks:new Map(),projects:new Map(),label:''};
  const keep=(c,id)=>{const m=undo[c];if(!m.has(id))m.set(id,S[c].get(id)?{...S[c].get(id)}:null)};
  for(const id of ids){
    const a=d.plan.props.find(x=>x.id===id),e=d.plan.esc.find(x=>x.id===id);
    if(a){const ch=d.choice[a.id]??0;if(ch==='skip')continue;const o=[a.best,...a.alts][+ch];if(!o||!canManageProj(o.x.p.id))continue;const t=S.tasks.get(o.x.I.t.id);if(!t)continue;
      if(o.kind==='transfer'){if(trPending(t)){out.push(`${t.title}: a transfer is already waiting`);continue}keep('tasks',t.id);
        put('tasks',t.id,{...clean(t),transfer:{to:o.to,from:t.assignee||'',by:meKey(),at:Date.now(),status:'pending',reason:`Load advisor: ${mName(o.mid)} at ${pctTxt(a.fromBefore,a.cap)} in W${isoWeek(d.plan.L.weeks[o.w])}`}});
        logH({act:'edited',kind:'task',id:t.id,pid:t.projectId,title:t.title,code:(S.projects.get(t.projectId)||{}).code||'',ch:[`Transfer requested: ${mName(t.assignee)} → ${mName(o.to)} (waiting for ${mName(o.to)} to accept)`]});
        (d.log=d.log||[]).push(`Transfer of “${t.title}” sent to ${mName(o.to)} to accept`);out.push(`transfer to ${mName(o.to)} requested`)}
      else{keep('tasks',t.id);put('tasks',t.id,{...clean(t),start:n2d(o.s),end:n2d(o.e)});stretchAfterMoves([t.id]);
        logH({act:'moved',kind:'task',id:t.id,pid:t.projectId,title:t.title,code:(S.projects.get(t.projectId)||{}).code||'',ch:[`Load advisor shift: ${fmt(o.x.I.s)} – ${fmt(o.x.I.e)} → ${fmt(o.s)} – ${fmt(o.e)}`]});
        (d.log=d.log||[]).push(`“${t.title}” moved to ${fmt(o.s)} – ${fmt(o.e)}`);out.push(`${t.title} shifted`)}}
    else if(e&&!e.left){const ch=d.choice[e.id]??0;if(ch==='skip')continue;const o=e.opts[+ch];if(!o||!canManageProj(o.x.p.id))continue;const t=S.tasks.get(o.x.I.t.id),p=S.projects.get(o.x.p.id);if(!t||!p)continue;
      keep('tasks',t.id);put('tasks',t.id,{...clean(t),start:n2d(o.s),end:n2d(o.e)});
      const mv=planFollow(p.id,t.id).filter(x=>canEditTask(x.I.t));for(const x of mv){const tt=S.tasks.get(x.id);if(!tt)continue;keep('tasks',tt.id);put('tasks',tt.id,{...clean(tt),start:n2d(x.s),end:n2d(x.e)})}
      stretchAfterMoves([t.id,...mv.map(x=>x.id)]);
      const me=model(p.id).e,tg=d2n(p.target);let tgTxt='';
      if(tg!=null&&isFinite(me)&&me>tg){keep('projects',p.id);put('projects',p.id,{...clean(p),target:n2d(me)});tgTxt=` · project target ${fmt(tg)} → ${fmt(me)}`}
      const what=o.kind==='delay'?`delayed to ${fmt(o.s)} – ${fmt(o.e)}`:`extended to ${fmt(o.e)}`;
      logH({act:'moved',kind:'task',id:t.id,pid:p.id,title:t.title,code:p.code||'',ch:[`Load advisor escalation: ${what}`,...(mv.length?[`${mv.length} linked task${mv.length>1?'s':''} moved later`]:[]),...(tgTxt?[tgTxt.slice(3)]:[])]});
      (d.log=d.log||[]).push(`“${t.title}” ${what}${mv.length?`, ${mv.length} linked task${mv.length>1?'s':''} moved`:''}${tgTxt}`);out.push(`${t.title} ${o.kind==='delay'?'delayed':'extended'}`)}}
  if(undo.tasks.size||undo.projects.size){undo.label=`${undo.tasks.size+undo.projects.size} change${undo.tasks.size+undo.projects.size>1?'s':''}`;advUndo=undo}
  if(out.length)toast(out.length===1?out[0][0].toUpperCase()+out[0].slice(1):`${out.length} fixes applied`);
  d.plan=null;loadCache=null;
}
function advUndoLast(d){const u=advUndo;if(!u)return;advUndo=null;let n=0;
  for(const c of ['tasks','projects'])for(const [id,old] of u[c]){if(!old)continue;const {id:_,...rest}=old;put(c,id,clean(rest));n++}
  logH({act:'changed',kind:'bulk',title:`Undid the last load advisor fixes (${n})`,ch:[]});toast('Undone');d.plan=null;d.log=[];loadCache=null}
function wireAdvisor(d){const el=$('#drawer');
  el.querySelectorAll('.adv-card input[type=radio]').forEach(r=>r.addEventListener('change',()=>{d.choice[r.name]=r.value==='skip'?'skip':+r.value}));
  el.querySelectorAll('[data-adv-apply]').forEach(b=>b.addEventListener('click',()=>{advApply(d,[b.dataset.advApply]);renderDrawer()}));
  const all=el.querySelector('[data-adv-all]');if(all)all.addEventListener('click',()=>{advApply(d,d.plan.props.map(a=>a.id));renderDrawer()});
  const un=el.querySelector('[data-adv-undo]');if(un)un.addEventListener('click',()=>{advUndoLast(d);renderDrawer()});
  el.querySelectorAll('[data-tr-cancel]').forEach(b=>b.addEventListener('click',()=>{const t=S.tasks.get(b.dataset.trCancel);if(!t||!trPending(t)||!canManageProj(t.projectId))return;
    const tr=t.transfer;put('tasks',t.id,{...clean(t),transfer:null,transfers:[...(t.transfers||[]),{...tr,status:'cancelled',doneAt:Date.now(),doneBy:meKey()}]});
    logH({act:'edited',kind:'task',id:t.id,pid:t.projectId,title:t.title,code:(S.projects.get(t.projectId)||{}).code||'',ch:[`Transfer to ${mName(tr.to)} cancelled`]});toast('Transfer request cancelled');d.plan=null;loadCache=null;renderDrawer()}));
}
/* transfer requests for me: accept or decline */
function drTransfers(d){const L=myTransfers();
  return `<form id="f" novalidate>${dHead('Tasks','Transfer requests for you')}
  <div class="dr-b">${L.length?L.map(t=>{const p=S.projects.get(t.projectId)||{},tr=t.transfer,I=model(t.projectId).info.get(t.id);const pv=I?previewFor(myMid(),{id:t.id,s:I.s,e:I.e,prog:I.prog,effort:t.effort,effortUnit:t.effortUnit,spread:t.spread}):null;
    return `<div class="adv-card" data-trid="${t.id}"><div><b class="mono">${h(p.code||'')}</b> ${h(p.name||'')}</div>
      <div style="font-size:15px;margin-top:4px"><b>${h(t.title)}</b></div>
      <div class="muted small">${I?`${fmt(I.s)} – ${fmt(I.e)} · ${I.prog}% done`:''}${+t.effort>0?` · effort ${t.effort} ${t.effortUnit==='d'?'day(s)':'h'}`:''}${t.skill?` · ${h(skillName(t.skill))}`:''}</div>
      <div class="small" style="margin-top:6px">From <b>${h(mName(t.assignee))}</b>, asked by ${h(pName(tr.by))} on ${fmtTs(tr.at)}${tr.reason?`<br><span class="muted">${h(tr.reason)}</span>`:''}</div>
      ${pv?`<div class="small" style="margin-top:4px">With this task your busiest week is W${isoWeek(pv.week)} at <b class="${pv.peak>1?'slip':''}">${isFinite(pv.peak)?Math.round(pv.peak*100)+'%':'no capacity'}</b>.</div>`:''}
      <div class="fld" style="margin-top:8px"><input type="text" class="tr-rem" maxlength="300" placeholder="Note (required if you decline)"></div>
      <div class="adv-b"><button type="button" class="btn sm primary" data-tr-accept="${t.id}">Accept task</button><button type="button" class="btn sm" data-tr-decline="${t.id}">Decline</button></div></div>`}).join(''):'<p>No transfer requests waiting for you.</p>'}
  </div><div class="dr-f"><button type="button" class="btn" data-action="close-drawer">Close</button></div></form>`}
function answerTransfer(tid,ok,note){const t=S.tasks.get(tid),mid=myMid();if(!t||!trPending(t)||t.transfer.to!==mid)return;
  const tr=t.transfer,p=S.projects.get(t.projectId)||{},rec={...tr,status:ok?'accepted':'declined',doneAt:Date.now(),doneBy:meKey(),note:note||''};
  const nt={...clean(t),transfer:null,transfers:[...(t.transfers||[]),rec]};if(ok)nt.assignee=mid;
  put('tasks',t.id,nt);
  logH({act:'edited',kind:'task',id:t.id,pid:t.projectId,title:t.title,code:p.code||'',ch:[ok?`Transfer accepted: ${mName(tr.from)} → ${mName(mid)}`:`Transfer to ${mName(mid)} declined${note?': '+note:''}`]});
  toast(ok?`“${t.title}” is now yours`:'Transfer declined');loadCache=null}
function wireTransfers(){const el=$('#drawer');
  el.querySelectorAll('[data-tr-accept]').forEach(b=>b.addEventListener('click',()=>{const c=b.closest('[data-trid]');answerTransfer(b.dataset.trAccept,true,c.querySelector('.tr-rem').value.trim());renderDrawer()}));
  el.querySelectorAll('[data-tr-decline]').forEach(b=>b.addEventListener('click',()=>{const c=b.closest('[data-trid]'),r=c.querySelector('.tr-rem');if(!r.value.trim()){r.classList.add('bad');r.placeholder='Say why you are declining';r.focus();return}answerTransfer(b.dataset.trDecline,false,r.value.trim());renderDrawer()}))}
function transferBanner(){const n=myTransfers().length;return n?`<div class="banner trb"><span><b>${n} task${n>1?'s are':' is'} waiting for you to accept.</b> A project lead or admin asked to transfer ${n>1?'them':'it'} to you to balance the team’s load.</span><span class="spacer"></span><button class="btn primary" data-action="transfers">Review</button></div>`:''}
function advisorBanner(){if(!canWrite())return '';const lead=isAdmin()||[...S.projects.values()].some(p=>p.owner===myMid()&&!projClosed(p));if(!lead)return '';
  const L=computeLoad(),H=Math.min(L.weeks.length,12);let n=0;for(const [mid,P] of L.people){if(!advisorPeople().some(m=>m.id===mid))continue;for(let w=0;w<H;w++)if(P.load[w]>P.cap[w]+0.01)n++}
  return n?`<div class="banner"><span><b>${n} overloaded person-week${n>1?'s':''}</b> in the next 12 weeks. The load advisor can suggest transfers to people with the right skill.</span><span class="spacer"></span><button class="btn" data-action="level">Open load advisor</button></div>`:''}

/* ---------- model ---------- */
const memberList=()=>[...S.members.values()].sort((a,b)=>(a.order||0)-(b.order||0)||String(a.name).localeCompare(b.name));
const isViewOnly=m=>!!m&&m.accessType==='read';
const workList=()=>memberList().filter(m=>!isViewOnly(m));
function myMember(){const a=ME.id&&S.access.get(ME.id);return a&&a.memberId?S.members.get(a.memberId):null}
function canSeeProject(pid){if(role()!=='read')return true;const m=myMember();return !!(m&&Array.isArray(m.visibleProjects)&&m.visibleProjects.includes(pid))}
const projList=()=>{const r={active:0,planning:1,hold:2,done:3,aborted:4};return [...S.projects.values()].filter(p=>canSeeProject(p.id)&&inYearP(p)).sort((a,b)=>(r[a.status]??1)-(r[b.status]??1)||projRank(a)-projRank(b)||(a.order||0)-(b.order||0))};
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
function render(){const ae=document.activeElement,fk=ae&&ae.dataset?(ae.dataset.af==='q'?'[data-af=q]':('afps' in ae.dataset)?'[data-afps]':null):null,pos=fk?ae.selectionStart:0;renderRail();renderMain();if(fk){const n=document.querySelector(fk);if(n&&n!==ae){n.focus();try{n.setSelectionRange(pos,pos)}catch(x){}}}}
function renderRail(){
  const ps=projList();const r=role();
  const brand=`<div class="brand">
    <div class="mark">${MARK}</div>
    <div><div class="brand-name">RFID R&amp;D Planner</div>
    <div class="brand-sub"><span class="dot ${mode==='live'?'live':''}"></span>${mode==='live'?'Shared · live':mode==='local'?'Local preview':'Connecting…'}</div></div>
  </div>`;
  const me=meReady?`<div class="me">${uav(meKey())}<div style="min-width:0"><div class="me-n">${h(pName(meKey()))}</div><div class="me-r">${mode==='local'?'Preview mode':ROLE[r]}${myCreds()&&!gateState()?' · '+h(myCreds().loginId):''}</div></div>${!gateState()&&window.__plannerSync&&myCreds()?`<button class="icon-btn" data-action="my-pw" title="Change my password" aria-label="Change my password"><svg width="14" height="14" viewBox="0 0 16 16"><circle cx="5" cy="10" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.2 8 13 2.2M11 4.2l1.8 1.8M9.6 5.6l1.4 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>`:''}${!gateState()&&mode==='live'&&myMember()?`<button class="icon-btn" data-action="my-leave" title="My leave" aria-label="My leave"><svg width="14" height="14" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3M6 10h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`:''}${!gateState()?`<button class="icon-btn" data-action="sign-out" title="Sign out" aria-label="Sign out"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M5.5 2H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.5M9 4.5 11.5 7 9 9.5M11.5 7H5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`:''}</div>`:'';
  if(gateState()){$('#rail').innerHTML=brand+me;return}
  const pend=isAdmin()?S.requests.size:0;
  $('#rail').innerHTML=`${brand}${me}
  <nav class="nav">
    <button class="nav-btn ${ui.view==='overview'?'on':''}" data-action="go" data-view="overview">Overview</button>
    ${(()=>{const mine=myAlerts().length,c=fuCounts(),n=c.due+c.missed,muted=aGet('muted','0')==='1';return `<div class="fu-navwrap"><button class="nav-btn ${ui.view==='followups'?'on':''} ${mine?'fu-alert':''}" data-action="go" data-view="followups" title="${mine?`${mine} follow-up${mine>1?'s':''} need your attention`:''}">Follow-ups ${(mine||n)?`<span class="badge">${mine||n}</span>`:''}</button>${mine?`<button type="button" class="icon-btn fu-mute" data-action="alert-mute" title="${muted?'Turn alert sound on':'Mute alert sound'}" aria-label="${muted?'Turn alert sound on':'Mute alert sound'}">${muted?'🔕':'🔔'}</button>`:''}</div>`})()}
    ${role()!=='read'?(()=>{const n=myLogBadge();return `<button class="nav-btn ${ui.view==='log'?'on':''}" data-action="go" data-view="log">Daily log ${n?`<span class="badge soft" title="${n} working day${n>1?'s':''} not logged in the last 7 days">${n}</span>`:''}</button>`})():''}
    ${(()=>{const n=S.members.size?overloadedNow():0;return `<button class="nav-btn ${ui.view==='load'?'on':''}" data-action="go" data-view="load">Resource load ${n?`<span class="badge">${n}</span>`:''}</button>`})()}
    <button class="nav-btn ${ui.view==='history'?'on':''}" data-action="go" data-view="history">History</button>
    ${isAdmin()?`<button class="nav-btn ${ui.view==='admin'?'on':''}" data-action="go" data-view="admin">Admin settings ${pend?`<span class="badge">${pend}</span>`:''}</button>`:''}
  </nav>
  <div class="rail-year"><label for="gfy-rail">Year</label>${yearSelect('gfy-rail','sel')}</div>
  <div class="rail-sec"><span>Projects</span><button class="icon-btn wp" data-action="new-project" aria-label="New project" title="New project"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
  <div class="plist">${ps.map(p=>{const m=model(p.id);return `<button class="pitem ${ui.view==='project'&&ui.pid===p.id?'on':''}" data-action="open-project" data-id="${p.id}">
      <span class="pcode">${h(p.code||'')}${projRank(p)<99?` · P${projRank(p)}`:''}</span><span class="count">${m.prog}%</span><span class="pname">${h(p.name)}</span><span class="pmeter"><i style="width:${m.prog}%"></i></span></button>`}).join('')||'<p class="muted small" style="margin:0 10px">No projects yet.</p>'}</div>`;
}
function renderMain(){
  const main=$('#main');
  document.body.classList.toggle('ro',!canWrite());document.body.classList.toggle('addp',canAddProj());
  const g=$('#gantt');
  if(g&&ui.pid)ui.scroll[ui.pid+ui.zoom]={l:g.scrollLeft,t:g.scrollTop};
  if(!isLoaded()){main.innerHTML='<div class="loading">Loading your planner…</div>';return}
  const ids=[...S.access.keys(),...S.requests.keys(),...S.history.keys()];
  for(const c of STAMPED)for(const x of S[c].values()){if(x.updatedBy)ids.push(x.updatedBy);if(x.createdBy)ids.push(x.createdBy)}
  for(const d of S.history.values())for(const e of (d.entries||[]))if(e.who)ids.push(e.who);
  for(const u of S.updates.values())ids.push(u.by);
  wantProfiles(ids);
  const gs=gateState();if(gs){if(drawer)closeDrawer();if(!(gs==='login'&&$('#loginForm'))){main.innerHTML=viewGate(gs);wireGate()}return}
  if(ui.view==='project'&&(!S.projects.has(ui.pid)||!canSeeProject(ui.pid)))ui.view='overview';
  if(ui.view==='team'||ui.view==='access'){ui.adminTab=ui.view;ui.view='admin'}
  if(ui.view==='admin'&&!isAdmin())ui.view='overview';
  if(ui.view==='admin'&&ui.adminTab==='email'&&emailDirty&&$('#emailForm'))return;
  main.classList.toggle('pro',ui.view==='project'&&!canEditProject(ui.pid));main.classList.toggle('prod',ui.view==='project'&&!canProjDocs(ui.pid));
  if(ui.view==='project')main.innerHTML=viewProject();
  else if(ui.view==='history')main.innerHTML=viewHistory();
  else if(ui.view==='followups')main.innerHTML=viewFollowups();
  else if(ui.view==='load')main.innerHTML=viewLoad();
  else if(ui.view==='log')main.innerHTML=viewLog();
  else if(ui.view==='admin'){main.innerHTML=viewAdmin();if(ui.adminTab==='access')wireAccess();if(ui.adminTab==='email')wireEmail();if(ui.adminTab==='skills')wireSkills()}
  else main.innerHTML=viewOverview();
  {const tb=mode==='live'?transferBanner():'';if(tb)main.insertAdjacentHTML('afterbegin',tb)}
  {const yb=yearBanner();if(yb)main.insertAdjacentHTML('afterbegin',yb)}
  const g2=$('#gantt');
  if(g2){const sv=ui.scroll[ui.pid+ui.zoom];
    if(sv){g2.scrollLeft=sv.l;g2.scrollTop=sv.t}
    else{g2.scrollLeft=Math.max(0,(+g2.dataset.todayx||0)-g2.clientWidth*0.25);ui.scroll[ui.pid+ui.zoom]={l:g2.scrollLeft,t:0}}
    g2.addEventListener('scroll',()=>{ui.scroll[ui.pid+ui.zoom]={l:g2.scrollLeft,t:g2.scrollTop}},{passive:true});
  }
}
const hasExamples=()=>[...S.members.values(),...S.projects.values(),...S.tasks.values()].some(x=>x.example);
function exampleBanner(){return hasExamples()?`<div class="banner"><span><b>Example data is loaded.</b> Explore it, then remove it when you start adding your own projects.</span><span class="spacer"></span><button class="btn danger w" data-action="remove-examples" data-two="Remove all example data">Remove examples</button></div>`:''}
function roBanner(){if(mode==='live'&&isAdmin()&&!myCreds()&&ME.id)return `<div class="banner"><span><b>Set your own login ID and password</b> so this account also asks for them when the planner opens.</span><span class="spacer"></span><button class="btn primary" data-action="set-login" data-id="${ME.id}">Set my login</button></div>`;return !canWrite()&&mode==='live'?`<div class="banner"><span>You have <b>view only</b> access${canAddProj()?' with permission to <b>add projects</b>. You can create projects and edit the details and documents of the projects you added':'. You can view your projects, timelines and their history'}. Ask an admin if you need to make other changes.</span></div>`:''}

function viewOverview(){
  const ps0=projList(),fyY=gFy(),ps=ps0;
  const head=`${backupBanner()}<div class="phead"><div><div class="eyebrow">${WD[dow(TODAY)]} ${fmtY(TODAY)} · Week ${isoWeek(TODAY)}</div><h1 class="ptitle">Overview</h1></div>
    <div class="actions"><button class="btn w" data-action="new-member">Add team member</button><button class="btn primary wp" data-action="new-project">New project</button></div></div>`;
  if(!ps0.length&&!S.members.size){
    return `${roBanner()}<section class="hero">
      <div class="eyebrow">Getting started</div>
      <h1>Plan every R&amp;D project down to the last subtask, and see who waits on whom.</h1>
      <p>Break projects into tasks and subtasks, give each one an owner and dates, and link tasks that must finish before others can start. Tasks without links run in parallel. Everyone on your team sees the same live schedule on desktop or phone.</p>
      <div class="steps">
        <div class="step"><b>01</b><h3>Add your team</h3><p class="muted">Name, role, and a colour that marks their bars on the timeline.</p></div>
        <div class="step"><b>02</b><h3>Create a project</h3><p class="muted">Give it a code and a target date so slips show up early.</p></div>
        <div class="step"><b>03</b><h3>Build the task tree</h3><p class="muted">Nest subtasks, set dates, and tick “depends on” to chain work in series.</p></div>
      </div>
      <div class="actions"><button class="btn primary w" data-action="new-member">Add team member</button><button class="btn wp" data-action="new-project">New project</button><button class="btn w" data-action="load-example">Load example project</button></div>
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
  const active=ps.filter(p=>!projClosed(p)).length;
  const fyBar=`<div class="fybar"><label for="ov-fy" class="muted small">Year</label>${yearSelect('ov-fy')}${fyY!=null?(()=>{const [A,B]=fyRange(fyY);let st=0,cp=0,ab=0;for(const p of ps){const [s,e]=projSpan(p);if(s>=A&&s<=B)st++;if(projClosed(p)&&e>=A&&e<=B){if(p.status==='aborted')ab++;else cp++}}return `<span class="muted small">${fmtY(A)} – ${fmtY(B)} · <b>${ps.length}</b> project${ps.length===1?'':'s'} · ${st} started · ${cp} completed · ${ab} aborted in this year</span>`})():''}</div>`;
  return `${roBanner()}${head}${exampleBanner()}${advisorBanner()}${fyBar}
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
      <h3>${h(p.name)}</h3>${p.customerName?`<div class="pc-cust">${h(p.customerName)}${p.refProduct?` · ref. ${h(p.refProduct)}`:''}</div>`:''}
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
  const ms=workList();
  const body=!m.flat.length?`<section class="hero"><h1 style="font-size:22px">Start the task tree for ${h(p.name)}</h1><p>Add top-level work packages first (for example Hardware, Firmware, Validation), then open each one to add subtasks with owners and dates.</p><div class="actions"><button class="btn primary w" data-action="new-task">Add first task</button></div></section>`
    :!rows.length?`<div class="panel"><div class="empty-note">No tasks match these filters.</div></div>`
    :(ui.mode==='timeline'?gantt(m,rows,p):listView(m,rows));
  const body2=ui.mode==='details'?viewDetails(p,m):body;
  const permNote=canWrite()&&!canEditProject(p.id)&&!projClosed(p)?`<div class="banner permnote"><span>🔒 <b>${p.owner?h(mName(p.owner)):'The project lead'}</b> (project lead) and admins manage this project. ${(()=>{const mid=myMid(),n=mid?[...S.tasks.values()].filter(t=>t.projectId===p.id&&t.assignee===mid).length:0;return n?`You can update your own ${n} task${n>1?'s':''}, add subtasks to them, add follow-ups and upload documents.`:'You can view it.'})()}</span></div>`:'';
  return `${permNote}${roBanner()}
  <div class="phead"><div style="min-width:0">
    <div class="eyebrow"><span class="mono">${h(p.code||'')}</span>${projRank(p)<99?`<span class="prk">P${projRank(p)}</span>`:''}<span class="chip st-${p.status||'planning'}">${PSTATUS[p.status]||'Planning'}</span>${p.example?'<span class="ex">Example</span>':''}</div>
    <h1 class="ptitle">${h(p.name)}</h1>
    <div class="psub"><span title="Calculated from the earliest task start to the latest task end">Drafted Timeline Detected range: <b>${isFinite(m.s)?`${fmtY(m.s)} → ${fmtY(m.e)}`:'no tasks yet'}</b></span>${tgt?`<span title="${h((p.targetLog||[]).map(x=>`${fmtY(d2n(x.from))} → ${fmtY(d2n(x.to))}${x.auto?' (automatic)':''}: ${x.reason||''}`).join(' | '))}">Target ${fmtY(tgt)}${p.target0&&p.target0!==p.target?` <span class="slip">(was ${fmtY(d2n(p.target0))}, moved by delays)</span>`:''}</span>`:''}${p.owner?`<span>Lead: ${h(mName(p.owner))}</span>`:''}${slip?`<span class="slip">Forecast ${slip} day${slip>1?'s':''} past target</span>`:''}</div>
  </div>
  <div class="actions">${m.conflicts.length?`<button class="btn warn w" data-action="resolve">Fix ${m.conflicts.length} link conflict${m.conflicts.length>1?'s':''}</button>`:''}<button class="btn" data-action="export"${m.flat.length?'':' disabled'}><svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5v8M3.8 6.5 7 9.7l3.2-3.2M2 12.5h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Export Gantt</button><button class="btn ${isProjCreatorRO(ui.pid)?'wp':'w'}" data-action="edit-project">Project details</button>${projClosed(p)?(canAddTask(p.id,'')?'<button class="btn primary" data-action="new-task">Add task</button>':''):'<button class="btn primary w" data-action="new-task">Add task</button>'}${projClosed(p)?(canManageProj0(p.id)?'<button class="btn" data-action="proj-reopen">Reopen project</button>':''):(canAbortProj(p.id)?'<button class="btn danger" data-action="proj-abort">Abort project</button>':'')}</div></div>
  ${closedBanner(p)}
  ${p.example?exampleBanner():''}
  ${ui.mode==='details'?'':profileCard(p)}
  <div class="stats">
    <div class="stat"><b>${m.prog}%</b><span>Complete</span></div>
    <div class="stat"><b>${m.done}/${m.leaves.length}</b><span>Tasks done</span></div>
    <div class="stat ${m.over?'bad':''}"><b>${m.over}</b><span>Overdue</span></div>
    <div class="stat ${m.conflicts.length?'bad':''}"><b>${m.conflicts.length}</b><span>Conflicts</span></div>
    <div class="stat"><b>${m.series}</b><span>Linked (series)</span></div>
    <div class="stat"><b>${m.parallel}</b><span>Independent (parallel)</span></div>
  </div>
  <div class="toolbar ${ui.mode==='details'?'tb-details':''}">
    <div class="seg" role="group" aria-label="View"><button class="${ui.mode==='timeline'?'on':''}" data-action="set-mode" data-v="timeline">Timeline</button><button class="${ui.mode==='list'?'on':''}" data-action="set-mode" data-v="list">List</button><button class="${ui.mode==='details'?'on':''}" data-action="set-mode" data-v="details">Details &amp; documents${projFiles(p.id).length?` <span class="count">${projFiles(p.id).length}</span>`:''}</button></div>
    ${ui.mode==='timeline'?`<div class="seg" role="group" aria-label="Zoom"><button class="${ui.zoom==='day'?'on':''}" data-action="set-zoom" data-v="day">Days</button><button class="${ui.zoom==='week'?'on':''}" data-action="set-zoom" data-v="week">Weeks</button></div><button class="btn" data-action="jump-today">Today</button>`:''}
    <select class="sel" id="fAssignee" data-change="fAssignee" aria-label="Filter by person"><option value="">Everyone</option>${ms.map(x=>`<option value="${x.id}" ${ui.fAssignee===x.id?'selected':''}>${h(x.name)}</option>`).join('')}<option value="_none" ${ui.fAssignee==='_none'?'selected':''}>Unassigned</option></select>
    <select class="sel" id="fStatus" data-change="fStatus" aria-label="Filter by status"><option value="">All statuses</option>${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${ui.fStatus===k?'selected':''}>${v}</option>`).join('')}<option value="over" ${ui.fStatus==='over'?'selected':''}>Overdue</option><option value="conflict" ${ui.fStatus==='conflict'?'selected':''}>Link conflicts</option></select>
    <span class="spacer"></span>
    <button class="btn" data-action="expand-all">Expand all</button><button class="btn" data-action="collapse-all">Collapse all</button>
  </div>
  ${body2}`;
}
function flags(I){return `${I.leaf&&stretchInfo(I.t)&&(stretchInfo(I.t).before||stretchInfo(I.t).after)?`<span class="flag str" title="Stretched by its subtasks; original plan ${fmt(stretchInfo(I.t).s0)} – ${fmt(stretchInfo(I.t).e0)}">↔</span>`:''}${I.outside?`<span class="flag warn" title="Subtasks run outside this task’s dates (${fmt(I.s)} – ${fmt(I.e)})">⇥</span>`:''}${I.leaf&&I.par&&I.status==='done'&&I.ropen?`<span class="flag warn" title="Marked done but ${I.ropen} subtask(s) still open">✓</span>`:''}${ownerOver(I)?'<span class="flag warn" title="Owner is overloaded during this task (see Resource load)">%</span>':''}${I.leaf&&I.t.outsideSkill?'<span class="flag warn" title="Assigned outside skill">S</span>':''}${I.fu&&I.fu.kind==='missed'?`<span class="flag" title="Follow-up missed">${BELL}</span>`:I.fu&&I.fu.kind==='due'?`<span class="flag warn" title="Follow-up update due">${BELL}</span>`:''}${I.conflict?'<span class="flag" title="Starts before a linked task finishes">!</span>':''}${I.over?'<span class="flag warn" title="Past end date">⏱</span>':''}`}
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
  const x=n=>(n-s0)*dw,x0=n=>x(n)+dw/2-6;
  let weeks='';for(let n=s0;n<=e0;n+=7)weeks+=`<div class="g-w" style="width:${7*dw}px"><b>W${isoWeek(n)}</b>${ui.zoom==='day'?fmt(n):''}</div>`;
  let dayRow='',we='';
  for(const x2 of holIn(s0,e0)){const n=d2n(x2.date);we+=`<div class="g-hol" style="left:${x(n)}px;width:${Math.max(dw,3)}px" title="${h(`${fmt(n)} · ${x2.name||'Holiday'}${x2.type?' · '+x2.type+' holiday':''}`)}"></div>`}
  for(let n=s0;n<=e0;n++){if(ui.zoom==='day')dayRow+=`<div class="g-d ${isWE(n)?'we':''} ${n===TODAY?'td':''}" style="width:${dw}px">${WD[dow(n)][0]}<b>${new Date(n*DAY).getUTCDate()}</b></div>`;if(dow(n)===6)we+=`<div class="g-we" style="left:${x(n)}px;width:${2*dw}px"></div>`}
  const idx=new Map(rows.map((id,i)=>[id,i]));
  const bars=rows.map((id,i)=>{const I=m.info.get(id);const PL=!I.leaf&&I.ps!=null,bs=PL?I.ps:I.s,be=PL?I.pe:I.e;const left=x(bs),wid=Math.max((be-bs+1)*dw-2,6);
    const lbl=I.leaf?`${h(I.t.title)}`:`${I.prog}%`;const out=!I.leaf||wid<Math.min(220,I.t.title.length*6.5+20);
    const stTxt=STATUS[I.status]+(I.over&&I.status!=='done'?', overdue':'');
    const tip=PL?`${I.wbs} ${I.t.title} · planned ${fmt(I.ps)} – ${fmt(I.pe)} · subtasks ${fmt(I.s)} – ${fmt(I.e)} · ${I.prog}%`:`${I.wbs} ${I.t.title} · ${fmt(I.s)} – ${fmt(I.e)} · ${I.dur} working day${I.dur>1?'s':''} · ${I.prog}% · ${stTxt}${I.leaf?' · '+mName(I.t.assignee):''}`;
    const bar=`<button class="bar ${I.leaf?'':'sum'} ${PL?'plan':''} ${PL&&I.outside?'pout':''} ${I.leaf?'bs-'+I.status:''} ${I.status==='done'?'done':''} ${I.conflict?'conflict':''} ${I.over?'over':''}" style="left:${left}px;width:${wid}px;--mc:${mColor(I.t.assignee)}" data-action="edit-task" data-id="${id}" title="${h(tip)}" aria-label="${h(tip)}"><span class="fill" style="width:${I.prog}%"></span><span class="lbl ${out?'out':''}">${I.status==='done'?'✓ ':I.status==='blocked'?'⛔ ':''}${I.leaf&&!out?lbl:(I.leaf?lbl+' · '+I.prog+'% · '+SHORTST[I.status]:PL?`${I.prog}% · planned`:`${I.prog}% · ${SHORTST[I.status]}`)}</span></button>`;
    let marks='';
    if(I.leaf&&I.t.assignee&&I.status!=='done'&&isFinite(I.s)&&isFinite(I.e))for(const B of bookIn(I.t.assignee,I.s,I.e,ganttHol()))marks+=`<span class="bk-seg ${B.full?'full':''}" data-action="edit-task" data-id="${id}" style="left:${x(B.a)}px;width:${Math.max((B.b-B.a+1)*dw-1,3)}px" title="${h(`${mName(I.t.assignee)} booked ${fmt(B.a)}${B.b!==B.a?' – '+fmt(B.b):''}: ${B.label}${B.full?' (full day)':''}`)}"></span>`;
    if(I.leaf&&I.t.assignee&&I.status!=='done'&&isFinite(I.s)&&isFinite(I.e))for(const L of leaveIn(I.t.assignee,I.s,I.e))marks+=`<span class="lv-seg ${L.half?'half':''}" data-action="edit-task" data-id="${id}" style="left:${x(L.a)}px;width:${Math.max((L.b-L.a+1)*dw-1,3)}px" title="${h(`${mName(I.t.assignee)} on leave ${fmt(L.a)}${L.b!==L.a?' – '+fmt(L.b):''}${L.half?' (½ day)':''}${L.note?' · '+L.note:''}`)}"></span>`;
    if(I.leaf&&I.t.plan0&&delaysOf(I.t).length){const p0e=d2n(I.t.plan0.e),p0s=d2n(I.t.plan0.s);if(p0e!=null&&I.e>p0e){const D=delaysOf(I.t),tot=D.reduce((a,x)=>a+(+x.days||0),0);const tipD=`Delayed ${tot} working day${tot===1?'':'s'} · original end ${fmt(p0e)} · ${D.map(x=>`${fmt(dayOf(x.at))} ${delayTxt(x)}: ${x.details}`).join(' | ')}`;
      marks+=`<span class="delay-seg" data-action="edit-task" data-id="${id}" style="left:${x(p0e+1)}px;width:${Math.max((I.e-p0e)*dw-2,4)}px" title="${h(tipD)}">${(I.e-p0e)*dw>46?`<i>+${tot}d</i>`:''}</span>`;
      if(p0s!=null&&!stretchInfo(I.t))marks+=`<span class="plan0" style="left:${x(p0s)}px;width:${Math.max((p0e-p0s+1)*dw-2,4)}px" title="Original plan ${fmt(p0s)} – ${fmt(p0e)}"></span>`}}
    {const SI=I.leaf?stretchInfo(I.t):null;if(SI){const tipS=`Stretched by subtask${SI.by.length>1?'s':''} ${[...new Set(SI.by.map(b=>b.title))].join(', ')} · original plan ${fmt(SI.s0)} – ${fmt(SI.e0)} · now ${fmt(I.s)} – ${fmt(I.e)}`;
      for(const [a,b,side] of [[...(SI.before||[]),'b'],[...(SI.after||[]),'a']]){if(a==null||b==null||b<a)continue;const n=b-a+1,lt=SI.last&&SI.last.title?SI.last.title:'subtask',w=Math.max(n*dw-2,4);
        marks+=`<span class="stretch-seg" style="left:${x(a)}px;width:${w}px" title="${h(tipS)}">${w>60?`<i>${side==='a'?'+':'−'}${n}d ← ${h(lt)}</i>`:''}</span>`}
      marks+=`<span class="plan0" style="left:${x(SI.s0)}px;width:${Math.max((SI.e0-SI.s0+1)*dw-2,4)}px" title="Original plan ${fmt(SI.s0)} – ${fmt(SI.e0)}"></span>`}}
    if(I.leaf&&I.par&&I.rs!=null){const segs=[[I.rs,I.re,'']];if(I.late)segs.push([Math.max(I.e+1,I.rs),I.re,'bad']);if(I.early)segs.push([I.rs,Math.min(I.s-1,I.re),'bad']);for(const [a,b,c2] of segs)marks+=`<span class="sub-span ${c2}" style="left:${x(a)}px;width:${Math.max((b-a+1)*dw-2,4)}px" title="Subtasks run ${fmt(I.rs)} – ${fmt(I.re)} · ${I.rprog}% done${c2?' · outside this task’s dates':''}"></span>`}
    if(I.leaf&&I.fu&&I.fu.dlStart!=null&&I.fu.kind!=='done'){const z0=Math.max(I.fu.dlStart,s0);if(z0<=I.e)marks+=`<span class="dl-zone ${I.fu.mode==='deadline'?'on':''}" style="left:${x(z0)}px;width:${Math.max((I.e-z0+1)*dw-2,4)}px" title="Deadline mode from ${fmt(I.fu.dlStart)}: ${h(fuLabel(I.fu.dlf).toLowerCase())}"></span>`}
    if(I.leaf){for(const u of upsFor(id)){const r=evRange(u);if(r){if(r.b<s0||r.a>e0)continue;const tip=h(`Event ${evTxt(u)} · ${u.event} · ${pName(u.by)}: ${u.remarks}`);marks+=r.b>r.a?`<span class="ev-seg ev-${evKey(u.event)}" style="left:${x(r.a)+1}px;width:${Math.max((r.b-r.a+1)*dw-3,6)}px" title="${tip}"></span>`:`<span class="ev-pin ev-${evKey(u.event)}" style="left:${x(r.a)+dw/2-5}px" title="${tip}"></span>`;continue}
      const n=dayOf(u.t);if(n<s0||n>e0)continue;marks+=`<span class="fu-dot ev-${evKey(u.event)}" style="left:${x(n)+dw/2-3}px" title="${h(fmt(n)+' · '+u.event+' · '+pName(u.by)+': '+u.remarks)}"></span>`}
      {const L=msList(I.t);L.forEach((x,k)=>{const n=msDay(I,k,L.length,x);if(n==null||n<s0||n>e0)return;const st=msState(x);marks+=`<span class="ms-dia ${st}" style="left:${x0(n)}px" title="${h(`Milestone ${k+1} of ${L.length}: ${x.name}${x.due?' · target '+dLab(x.due):''} · ${st==='done'?'completed'+(x.doneAt?' '+fmt(dayOf(x.doneAt)):''):st==='over'?'overdue':'open'}`)}"></span>`})}
      const f=I.fu;if(f&&['due','missed','ok','scheduled'].includes(f.kind)&&f.next>=s0&&f.next<=e0)marks+=`<span class="fu-next ${f.kind}" style="left:${x(f.next)+dw/2-5}px" title="${h((f.kind==='missed'?'Follow-up missed, was due ':f.kind==='due'?'Follow-up due ':'Next follow-up ')+fmt(f.next))}"></span>`}
    return `<div class="g-row ${I.par?'par':''}"><div class="g-name" style="--dep:${I.depth}">${nameCell(I)}<span class="gst s-${I.over&&I.status!=='done'?'late':I.status}" title="${h(I.leaf?STATUS[I.status]+(I.over&&I.status!=='done'?' · overdue':''):'From subtasks: '+STATUS[I.status])}">${I.over&&I.status!=='done'?'Overdue':SHORTST[I.status]}</span>${I.leaf?av(I.t.assignee):''}</div><div class="g-lane" style="width:${W}px">${bar}${marks}</div></div>`}).join('');
  let links='';
  for(const id of rows){const I=m.info.get(id);for(const d of I.deps){if(!idx.has(d))continue;const P=m.info.get(d);
    const x1=x(P.e+1)-2,y1=idx.get(d)*RH+RH/2,x2=x(I.s),y2=idx.get(id)*RH+RH/2;const bad=I.s<=P.e;
    let path;if(x2-x1>=14)path=`M${x1} ${y1}H${x1+7}V${y2}H${x2-1}`;else{const ym=y2+(y2>y1?-RH/2:RH/2);path=`M${x1} ${y1}H${x1+7}V${ym}H${x2-9}V${y2}H${x2-1}`}
    links+=`<path d="${path}" class="${bad?'bad':''}" marker-end="url(#${bad?'ahb':'ah'})"/>`}}
  return `<div class="g-legend"><span><i class="lg-hol"></i>Holiday</span><span><i class="lg-lv"></i>Owner on leave</span><span><i class="lg-dl"></i>Delayed part</span><span><i class="lg-bkf"></i>Booked full day</span><span><i class="lg-bkp"></i>Booked part day</span><span class="muted small">Task dates move automatically when holidays, leave, booked time or other logged work change.</span></div><div class="gantt" id="gantt" data-todayx="${x(TODAY)}">
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
    return `<section class="mcard"><div class="mc-top">${av(x.id,true)}<div style="min-width:0"><h3>${h(x.name)}${x.example?' <span class="ex">Example</span>':''}</h3><div class="muted small">${h(x.role||'Team member')}${isViewOnly(x)?` · <b>View only</b> · ${(x.visibleProjects||[]).length} project${(x.visibleProjects||[]).length===1?'':'s'}`:''}</div><div class="small ${x.email?'':'slip'}">${x.email?h(x.email):'No email ID yet'}</div></div><span class="spacer"></span><button class="btn" data-action="edit-member" data-id="${x.id}">Edit</button></div>
      <div class="skchips" ${isViewOnly(x)?'hidden':''}>${Object.entries(x.skills||{}).filter(([k,v])=>v&&S.skills.has(k)).map(([k,v])=>`<span class="skchip ${v}">${h(skillName(k))}${v==='expert'?' ★':''}</span>`).join('')||'<span class="muted small">No skills set</span>'}<span class="muted small">· ${memberCap(x).hpd} h/day</span></div>${userLine(x.id)}<div class="pc-row"><span>${L.length} open task${L.length===1?'':'s'}</span>${ov?`<span class="slip">${ov} overdue</span>`:''}</div>
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
  const v=S.pwvault.get(u);return loginBits(u,c.loginId,v&&v.pw)+(v&&v.setBySelf&&v.setAt?` <span class="as">· changed by them on ${fmt(dayOf(v.setAt))}</span>`:'');
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
function allHist(){const out=[];const ro=role()==='read';for(const [k,d] of S.history)for(const e of (d.entries||[])){if(ro&&!(e.pid&&canSeeProject(e.pid)))continue;if(!inYearD(dayOf(e.t||0)))continue;out.push({...e,by:k})}return out.sort((a,b)=>b.t-a.t)}
const HV={created:'added',edited:'edited',deleted:'deleted',moved:'rescheduled',followup:'logged a follow-up on'};
function hSentence(e){
  const live=e.kind==='task'&&S.tasks.has(e.id);
  const T=e.title?(live?`<button class="hlink" data-action="edit-task" data-id="${e.id}">${h(e.title)}</button>`:`<b>${h(e.title)}</b>`):'';
  const code=e.code?` <span class="mono muted">${h(e.code)}</span>`:'';
  switch(e.kind){
    case 'task':return `${HV[e.act]||e.act} task ${T}${code}`;
    case 'project':return `${HV[e.act]||e.act} project ${T}${code}`;
    case 'member':return `${HV[e.act]||e.act} team member ${T}`;
    case 'log':return `${HV[e.act]||e.act} a daily log entry ${T}`;
    case 'backup':return `${e.act==='restored'?'restored data':'saved'} ${T}`;
    case 'access':{const w=`<b>${h(pName(e.who))}</b>`;return e.act==='granted'?`gave ${w} access`:e.act==='revoked'?`removed access for ${w}`:e.act==='declined'?`declined the request from ${w}`:e.act==='disabled'?`disabled the account of ${w}`:e.act==='enabled'?`enabled the account of ${w}`:e.act==='login'?`created a login for ${w}`:e.act==='reset'?`set a new password for ${w}`:e.act==='unlogin'?`removed the login for ${w}`:`changed access for ${w}`}
    default:return `${h(e.title||'')}${code}`;
  }
}
function hItem(e,compact){return `<div class="hitem">${uav(e.by)}<div style="min-width:0"><div class="ht"><b>${h(pName(e.by))}</b> ${hSentence(e)}</div>${(e.ch&&e.ch.length)?`<div class="hc">${e.ch.slice(0,compact?6:12).map(c=>`<span>${h(c)}</span>`).join('')}${e.ch.length>(compact?6:12)?`<span>+${e.ch.length-(compact?6:12)} more</span>`:''}</div>`:''}</div><span class="htime">${compact?fmtTs(e.t):new Date(e.t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div>`}
function viewHistory(){
  let L=allHist();const people=[...S.history.keys()].filter(k=>(S.history.get(k).entries||[]).length);
  if(ui.hPerson)L=L.filter(e=>e.by===ui.hPerson);
  if(ui.hProject)L=L.filter(e=>e.pid===ui.hProject||(e.kind==='project'&&e.id===ui.hProject));
  if(ui.hKind)L=L.filter(e=>ui.hKind==='other'?!['task','project','member','log','backup'].includes(e.kind):e.kind===ui.hKind);
  const total=L.length;L=L.slice(0,250);
  let html='',last='';
  for(const e of L){const d=new Date(e.t);const n=Math.round(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/DAY);const lab=n===TODAY?'Today':n===TODAY-1?'Yesterday':`${WD[dow(n)]} ${fmtY(n)}`;
    if(lab!==last){html+=`<div class="hday">${lab}</div>`;last=lab}html+=hItem(e)}
  return `<div class="phead"><div><div class="eyebrow">${total} change${total===1?'':'s'}</div><h1 class="ptitle">History</h1></div></div>
  <div class="toolbar">
    <select class="sel" id="hPerson" data-change="hPerson" aria-label="Filter by person"><option value="">Everyone</option>${people.map(k=>`<option value="${h(k)}" ${ui.hPerson===k?'selected':''}>${h(pName(k))}</option>`).join('')}</select>
    <select class="sel" id="hProject" data-change="hProject" aria-label="Filter by project"><option value="">All projects</option>${projList().map(p=>`<option value="${p.id}" ${ui.hProject===p.id?'selected':''}>${h(p.code||'')} ${h(p.name)}</option>`).join('')}</select>
    <select class="sel" id="hKind" data-change="hKind" aria-label="Filter by type"><option value="">All changes</option><option value="task" ${ui.hKind==='task'?'selected':''}>Tasks</option><option value="project" ${ui.hKind==='project'?'selected':''}>Projects</option><option value="member" ${ui.hKind==='member'?'selected':''}>Team</option><option value="log" ${ui.hKind==='log'?'selected':''}>Daily log</option><option value="backup" ${ui.hKind==='backup'?'selected':''}>Backups</option><option value="other" ${ui.hKind==='other'?'selected':''}>Access &amp; bulk changes</option></select>
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
function diffProject(a,b){return diffFields([['Name',a.name,b.name],['Code',a.code,b.code],['Lead',a.owner?mName(a.owner):'',b.owner?mName(b.owner):''],['Status',PSTATUS[a.status]||'',PSTATUS[b.status]||''],['Start',dLab(a.start),dLab(b.start)],['Target',dLab(a.target),dLab(b.target)]]).concat((a.description||'')!==(b.description||'')?['Description updated']:[]).concat(diffFields([['Project introducer',a.assignedBy?(S.members.has(a.assignedBy)?mName(a.assignedBy):a.assignedBy):'',b.assignedBy?(S.members.has(b.assignedBy)?mName(b.assignedBy):b.assignedBy):''],['Introduced on',dLab(a.assignedOn),dLab(b.assignedOn)],['Sales person',a.salesPerson?(S.members.has(a.salesPerson)?mName(a.salesPerson):a.salesPerson):'',b.salesPerson?(S.members.has(b.salesPerson)?mName(b.salesPerson):b.salesPerson):''],['Customer',a.customerName||'',b.customerName||''],['End customer',a.endCustomer||'',b.endCustomer||''],['Expected volume',a.volume||'',b.volume||'']])).concat(['techSummary','refProduct','techInputs'].filter(k=>(a[k]||'')!==(b[k]||'')).map(k=>({techSummary:'Technical summary',refProduct:'Reference product',techInputs:'Additional technical inputs'})[k]+' updated'))}

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
  const sub=[isFinite(m.s)?`Drafted Timeline Detected range: ${fmtY(m.s)} → ${fmtY(m.e)}`:'',tgt?`Target ${fmtY(tgt)}`:'',p.customerName?`Customer: ${p.customerName}`:'',p.endCustomer?`End customer: ${p.endCustomer}`:'',p.volume?`Volume: ${p.volume}`:'',p.owner?`Lead: ${mName(p.owner)}`:'',p.salesPerson?`Sales: ${personTxt(p.salesPerson)}`:'',slip?`Forecast ${slip} days past target`:(tgt&&isFinite(m.e)?'On track for target':'')].filter(Boolean).join('    ·    ');
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
  leg(x0=>{c.fillStyle='rgba(123,47,190,.35)';c.fillRect(x0+4,ly-7,12,14);c.fillStyle=HOL_COLOR;c.fillRect(x0+4,ly-7,12,3)},'Holiday');
  leg(x0=>{c.fillStyle=LV_COLOR;c.fillRect(x0+2,ly-5,16,10)},'Owner on leave');
  leg(x0=>{c.fillStyle='rgba(200,50,60,.30)';c.fillRect(x0+2,ly-5,16,10);c.strokeStyle='rgba(200,50,60,.85)';c.strokeRect(x0+2.5,ly-4.5,15,9)},'Delayed part');
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
  for(const hx of holIn(s0,e0)){const n=d2n(hx.date);c.fillStyle='rgba(123,47,190,.28)';c.fillRect(X(n),by,Math.max(dw,2),bodyH);c.fillStyle=HOL_COLOR;c.fillRect(X(n),y0+SCALE-4,Math.max(dw,2),4)}
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
      if(I.t.plan0&&delaysOf(I.t).length){const p0e=d2n(I.t.plan0.e);if(p0e!=null&&I.e>p0e){const dx=X(p0e+1),dwid=Math.max((I.e-p0e)*dw-1,2);c.save();c.fillStyle='rgba(200,50,60,.30)';c.fillRect(dx,y+6,dwid,RH-12);c.strokeStyle='rgba(200,50,60,.85)';c.lineWidth=1.2;c.strokeRect(dx+.5,y+6.5,dwid-1,RH-13);c.restore()}}
      if(I.status!=='done')for(const Lv of leaveIn(I.t.assignee,I.s,I.e)){const lx=X(Lv.a),lw=Math.max((Lv.b-Lv.a+1)*dw-1,2),lh=Lv.half?(RH-12)/2:RH-12;c.save();c.fillStyle='rgba(0,0,0,.78)';c.fillRect(lx,y+6+(RH-12-lh),lw,lh);c.strokeStyle='rgba(255,255,255,.35)';c.lineWidth=1;c.beginPath();c.rect(lx,y+6+(RH-12-lh),lw,lh);c.clip();for(let k=-RH;k<lw;k+=5){c.beginPath();c.moveTo(lx+k,y+RH-6);c.lineTo(lx+k+RH,y+6-RH/2);c.stroke()}c.restore()}
      {const SI=stretchInfo(I.t);if(SI)for(const sg of [SI.before,SI.after]){if(!sg)continue;const sx=X(sg[0]),sw=Math.max((sg[1]-sg[0]+1)*dw-1,3);c.save();c.beginPath();c.rect(sx,y+6,sw,RH-12);c.clip();c.fillStyle='rgba(183,121,31,.22)';c.fillRect(sx,y+6,sw,RH-12);c.strokeStyle='rgba(183,121,31,.85)';c.lineWidth=1.5;for(let k=-RH;k<sw+RH;k+=6){c.beginPath();c.moveTo(sx+k,y+RH-6);c.lineTo(sx+k+RH-12,y+6);c.stroke()}c.restore();c.strokeStyle='#B7791F';c.lineWidth=1.2;c.setLineDash([3,2]);c.strokeRect(sx+.5,y+6.5,sw-1,RH-13);c.setLineDash([])}}
      c.globalAlpha=1;
      if(bw>34){c.fillStyle=XC.ink;c.font=XF(500,10);c.fillText(I.prog+'%',bx+5,mid)}
      if(I.fu&&I.fu.dlStart!=null&&I.fu.kind!=='done'){const z0=Math.max(I.fu.dlStart,s0);if(z0<=I.e){c.strokeStyle='#B7791F';c.lineWidth=2.2;c.setLineDash([4,3]);c.beginPath();c.moveTo(X(z0),y+3);c.lineTo(X(I.e+1)-1,y+3);c.stroke();c.setLineDash([])}}
      if(I.par&&I.rs!=null){const sx=X(I.rs),sw=Math.max((I.re-I.rs+1)*dw-1,3);c.fillStyle=XC.accent;c.fillRect(sx,y+RH-6.5,sw,2.5);c.fillStyle=XC.bad;if(I.late){const a=X(Math.max(I.e+1,I.rs));c.fillRect(a,y+RH-6.5,X(I.re+1)-1-a,2.5)}if(I.early){const b2=X(Math.min(I.s,I.re+1));c.fillRect(sx,y+RH-6.5,b2-sx,2.5)}}
      for(const u of upsFor(id)){const col2=EVHEX[evKey(u.event)],r=evRange(u);
        if(r){if(r.b<s0||r.a>e0)continue;c.fillStyle=col2;if(r.b>r.a){xRR(c,X(r.a)+1,y+2,Math.max((r.b-r.a+1)*dw-2,4),5,2.5);c.fill()}else{const px=X(r.a)+dw/2;c.beginPath();c.moveTo(px,y+9);c.lineTo(px-4.5,y+2);c.lineTo(px+4.5,y+2);c.closePath();c.fill()}continue}
        const n=dayOf(u.t);if(n<s0||n>e0)continue;c.fillStyle=col2;c.beginPath();c.arc(X(n)+dw/2,y+RH-3.5,2.6,0,7);c.fill()}
      {const L=msList(I.t);L.forEach((x,k)=>{const n=msDay(I,k,L.length,x);if(n==null||n<s0||n>e0)return;const st=msState(x),cx=X(n)+dw/2,cy=mid;c.fillStyle=st==='done'?'#2E8B57':'#FFFFFF';c.strokeStyle=st==='over'?XC.bad:st==='done'?'#1E6B43':XC.ink;c.lineWidth=1.4;c.beginPath();c.moveTo(cx,cy-5.5);c.lineTo(cx+5.5,cy);c.lineTo(cx,cy+5.5);c.lineTo(cx-5.5,cy);c.closePath();c.fill();c.stroke()})}
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
  const body=t==='access'?viewAccess():t==='email'?viewEmail():t==='skills'?viewSkills():t==='backup'?viewBackup():viewTeam();
  return `<div class="adm"><div class="phead"><div><div class="eyebrow">Admin</div><h1 class="ptitle">Admin settings</h1></div></div>
  <div class="atabs" role="tablist">${tab('team','Team')}${tab('skills','Skills &amp; calendar')}${tab('access','Users &amp; access',pend)}${tab('email','Email')}${tab('backup','Backup &amp; export')}</div>
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
  <section class="panel"><h2>Project updates to stakeholders</h2>
    <p class="hint" style="margin:0 0 6px">Sent to everyone on a project: the project lead, task owners, View only people who have the project ticked, and admins (if switched on below). Each person gets one email covering all their projects.</p>
    ${ck('su-events',e.suEvents!==false,'Send an update when something important happens: milestone completed or reopened, task finished, project status changed, target date moved')}
    <p class="hint" style="margin:0 0 6px 26px">Each change waits <b>10 minutes</b> before it is sent. If it is undone in that time, nothing is sent; changes in the same window go out together.</p>
    ${ck('su-weekly',e.suWeekly!==false,'Send a weekly summary of every open project')}
    <div class="two">
      <div class="fld"><label for="su-day">Weekly summary day</label><select id="su-day"${dis}>${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d,i)=>`<option value="${i}" ${(e.suDay==null||e.suDay===''?1:+e.suDay)===i?'selected':''}>${d}</option>`).join('')}</select></div>
      <div class="fld"><label for="su-time">Weekly summary time (IST)</label><input type="time" id="su-time" value="${h(e.suTime||'09:00')}"${dis}></div>
    </div>
    ${ck('su-admins',e.suAdmins!==false,'Admins get updates for every project')}
    <p class="hint" style="margin:0 0 0 26px">When this is off, admins only get updates for projects they lead or own tasks in.</p>
    <div id="suLive" class="sulive"><span class="muted small">Loading the update queue…</span></div>
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
  loadSuLive();
}
/* stakeholder update queue (server side): held changes, cancel, weekly preview / send now */
async function suApi(body){const r=await fetch('/api/updates',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
let suSeq=0;
async function loadSuLive(){
  let box=$('#suLive');if(!box)return;const my=++suSeq;
  if(mode!=='live'){box.innerHTML='<span class="muted small">The update queue shows on the server version of the planner.</span>';return}
  let st;try{st=await suApi()}catch(e){box.innerHTML=`<span class="slip small">Couldn’t load the update queue: ${h(e.message)}</span>`;return}
  box=$('#suLive');if(!box||my!==suSeq)return;
  const q=sel=>box.querySelector(sel);
  const mins=t=>Math.max(0,Math.ceil((t-Date.now())/60000));
  const L=st.log||[];
  box.innerHTML=`${st.senderReady?'':'<div class="banner bad" style="margin:8px 0">Save the sender account above first. Without it, updates are not sent.</div>'}
    <div class="panel-h" style="margin-top:10px"><h3 class="sub-h">Waiting to be sent</h3><span class="muted small">${st.pending.length} change${st.pending.length===1?'':'s'}</span></div>
    ${st.pending.length?`<div class="sulist">${st.pending.map(x=>`<div class="suitem"><span style="min-width:0"><div class="at">${h(x.text)}</div><div class="as">${h(x.project)} · changed ${fmtTs(x.at)} · sends in ${mins(x.sendAt)} min</div></span><button type="button" class="btn sm" data-su-cancel="${h(x.key)}">Don’t send</button></div>`).join('')}</div>`:'<div class="empty-note">Nothing waiting. Changes appear here for 10 minutes before they are emailed.</div>'}
    <div class="actions" style="margin-top:10px"><button type="button" class="btn sm" id="suPrev">Preview weekly summary</button><button type="button" class="btn sm" id="suSend">Send weekly summary now</button><button type="button" class="btn sm" id="suRef">Refresh</button></div>
    <div id="suOut" class="small"></div>
    ${L.length?`<details class="sulog"><summary class="small">Recent sending (${L.length})</summary><ul class="small">${L.slice(0,15).map(x=>`<li>${fmtTs(x.at)} · ${x.type==='weekly'?'Weekly summary':x.type==='events'?'Event update':'Cancelled by admin'}${x.sent!=null?` · sent to ${x.sent}`:''}${x.failed&&x.failed.length?` · <span class="slip">${x.failed.length} failed (${h(x.failed[0].error)})</span>`:''}${x.error?` · <span class="slip">${h(x.error)}</span>`:''}</li>`).join('')}</ul></details>`:''}`;
  box.querySelectorAll('[data-su-cancel]').forEach(b=>b.addEventListener('click',async()=>{b.disabled=true;try{await suApi({action:'cancel',key:b.dataset.suCancel});toast('This change won’t be emailed');logH({act:'changed',kind:'settings',title:'stopped a stakeholder update from being sent',ch:[b.closest('.suitem').querySelector('.at').textContent]})}catch(e){toast(e.message)}loadSuLive()}));
  const out=q('#suOut');
  q('#suRef').addEventListener('click',loadSuLive);
  q('#suPrev').addEventListener('click',async()=>{out.textContent='Working…';try{const r=await suApi({action:'preview-weekly'});out.innerHTML=r.messages&&r.messages.length?`<p style="margin:8px 0 4px"><b>${r.messages.length}</b> people would get the weekly summary:</p><ul>${r.messages.map(m=>`<li>${h(m.to)} · ${h(m.subject)}</li>`).join('')}</ul>`:'<p>No one would get it: no open projects, or no one on them has an email ID.</p>'}catch(e){out.textContent=e.message}});
  q('#suSend').addEventListener('click',async()=>{if(!confirmTwice(q('#suSend'),'Send to everyone now?'))return;out.textContent='Sending…';try{const r=await suApi({action:'send-weekly'});out.innerHTML=r.error?`<span class="slip">${h(r.error)}</span>`:`Sent to ${r.sent.length}${r.failed.length?`, <span class="slip">${r.failed.length} failed: ${h(r.failed[0].error)}</span>`:''}.`;logH({act:'changed',kind:'settings',title:'sent the weekly project summary by hand',ch:[`${(r.sent||[]).length} people`]})}catch(e){out.textContent=e.message}});
}
function confirmTwice(b,label){if(b.dataset.armed){delete b.dataset.armed;b.textContent=b.dataset.orig;return true}b.dataset.orig=b.textContent;b.dataset.armed='1';b.textContent=label;setTimeout(()=>{if(b.dataset.armed){delete b.dataset.armed;b.textContent=b.dataset.orig}},4000);return false}
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
    enabled:$('#e-on').checked,toOwner:$('#e-owner').checked,toLead:$('#e-lead').checked,sendTime:$('#e-time').value||'09:00',suEvents:$('#su-events').checked,suWeekly:$('#su-weekly').checked,suDay:+$('#su-day').value,suTime:$('#su-time').value||'09:00',suAdmins:$('#su-admins').checked,link:v('e-link')||PLANNER_URL,updatedAt:Date.now(),updatedBy:meKey()};
  const ch=diffFields([['Sender',old.fromEmail||'',rec.fromEmail],['Server',old.host?`${old.host}:${old.port}`:'',rec.host?`${rec.host}:${rec.port}`:''],['Sending time',old.sendTime||'',rec.sendTime],['Emails',old.enabled===false?'Off':'On',rec.enabled?'On':'Off'],['Event updates',old.suEvents===false?'Off':'On',rec.suEvents?'On':'Off'],['Weekly summary',old.suWeekly===false?'Off':`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][old.suDay==null||old.suDay===''?1:+old.suDay]} ${old.suTime||'09:00'}`,rec.suWeekly?`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][rec.suDay]} ${rec.suTime}`:'Off'],['Admins get all project updates',old.suAdmins===false?'Off':'On',rec.suAdmins?'On':'Off']]);
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
    ${(()=>{const SI=stretchInfo(I.t);if(!SI)return '';return `<div class="rollup stretchnote"><b>↔ Stretched by subtasks.</b> Original plan ${fmt(SI.s0)} – ${fmt(SI.e0)}, now ${fmt(I.s)} – ${fmt(I.e)}.<ul>${SI.by.slice(-6).reverse().map(b=>`<li>${fmtTs(b.at)} · ${h(pName(b.who))}: “${h(b.title)}” → ${b.to?`${dLab(b.to[0])} – ${dLab(b.to[1])}`:''}</li>`).join('')}</ul></div>`})()}
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

/* ---------- project details & documents (ISO design records) ---------- */
const DOC_CATS=['Design input','Customer requirement','Specification','Datasheet','Drawing / CAD','Schematic / PCB','Test report','Certificate / compliance','Photo','Meeting minutes','Other'];
const DOC_EXT='pdf,png,jpg,jpeg,gif,webp,bmp,txt,csv,doc,docx,xls,xlsx,ppt,pptx,zip,rar,7z,dxf,dwg,step,stp,iges,igs,stl,gbr,gerber,brd,sch,pcbdoc,schdoc,mp4,mov,s2p,s1p,log,json';
const VIEWABLE=new Set(['pdf','png','jpg','jpeg','gif','webp','bmp','txt','mp4','s2p','s1p','log']);
const fsize=b=>b<1024?b+' B':b<1048576?(b/1024).toFixed(0)+' KB':(b/1048576).toFixed(1)+' MB';
const extIcon=e=>({pdf:'PDF',png:'IMG',jpg:'IMG',jpeg:'IMG',gif:'IMG',webp:'IMG',bmp:'IMG',doc:'DOC',docx:'DOC',xls:'XLS',xlsx:'XLS',csv:'CSV',ppt:'PPT',pptx:'PPT',zip:'ZIP',rar:'ZIP','7z':'ZIP',mp4:'VID',mov:'VID'}[e]||String(e||'FILE').toUpperCase().slice(0,4));
const projFiles=(pid,all)=>[...S.files.values()].filter(f=>f.projectId===pid&&(all||f.status==='current')).sort((a,b)=>DOC_CATS.indexOf(a.category)-DOC_CATS.indexOf(b.category)||b.at-a.at);
function docRow(f,m){
  const T=f.taskId&&m?m.info.get(f.taskId):null;const st=f.status!=='current'?`<span class="chip ${f.status==='archived'?'st-blocked':'st-todo'}">${f.status==='archived'?'Archived':'Superseded'}</span>`:'';
  return `<div class="docrow ${f.status!=='current'?'old':''}"><span class="dico e-${h(f.ext)}">${extIcon(f.ext)}</span>
    <div class="dmain"><div class="dname"><button type="button" class="hlink" data-action="view-doc" data-id="${f.id}">${h(f.name)}</button> <span class="revchip">Rev ${h(f.rev||'A')}</span>${f.category==='Other'&&f.categoryOther?` <span class="revchip">${h(f.categoryOther)}</span>`:''} ${st}</div>
      <div class="drem">${h(f.remarks||'')}</div>
      <div class="as">${fsize(f.size)} · ${h(pName(f.by))}, ${fmtTs(f.at)}${T?` · Task ${T.wbs} ${h(T.t.title)}`:''}${f.editedAt?' · edited':''}</div></div>
    <div class="dact"><button type="button" class="btn sm" data-action="view-doc" data-id="${f.id}">${VIEWABLE.has(f.ext)?'View':'Open'}</button><a class="btn sm" href="/api/files/${f.id}?download=1">Download</a>
      ${f.status==='current'?`<button type="button" class="btn sm w wd" data-action="doc-rev" data-id="${f.id}">New revision</button>`:''}<button type="button" class="btn sm w wd" data-action="doc-edit" data-id="${f.id}">Edit</button>
      ${isAdmin()?(f.status==='archived'?`<button type="button" class="btn sm" data-action="doc-status" data-id="${f.id}" data-v="current">Restore</button>`:f.status==='current'?`<button type="button" class="btn sm danger" data-action="doc-status" data-id="${f.id}" data-v="archived" data-two="Confirm archive">Archive</button>`:''):''}</div></div>`;
}
function personTxt(v){return v?(S.members.has(v)?mName(v):v):''}
function profileCard(p){
  const has=p.customerName||p.endCustomer||p.volume||p.assignedBy||p.salesPerson||p.techSummary||p.refProduct||p.techInputs;
  const docs=projFiles(p.id);
  if(!has&&!docs.length)return `<div class="pf-empty w"><span>Add the customer, introducer, sales person and technical details so they show here.</span><button type="button" class="btn sm w" data-action="edit-project">Add project details</button></div>`;
  const kv=(k,v)=>v?`<div class="pf-kv"><span>${k}</span><b>${v}</b></div>`:'';
  const tx=(k,v)=>v?`<div class="pf-tx"><span>${k}</span><p>${h(v)}</p></div>`:'';
  const cats=[...new Set(docs.map(f=>f.category))];
  const op=ui.pfOpen&&ui.pfOpen.pid===p.id?ui.pfOpen.part:'';
  const pa=k=>`data-action="pf-toggle" data-id="${p.id}" data-part="${k}" role="button" tabindex="0" aria-expanded="${op===k}" title="${op===k?'Click to make compact':'Click to expand'}"`;
  const hint=k=>`<span class="pf-hint">${op===k?'Show less ▴':'Expand ▾'}</span>`;
  return `<section class="pf ${op?'open-'+op:''}">
    <div class="pf-who ${op==='who'?'on':''}" ${pa('who')}>
      ${p.customerName?`<div class="pf-cust"><span>Customer</span><b>${h(p.customerName)}</b></div>`:''}
      ${p.endCustomer?`<div class="pf-cust"><span>End customer</span><b>${h(p.endCustomer)}</b></div>`:''}
      <div class="pf-grid">
        ${kv('Introducer',p.assignedBy?h(personTxt(p.assignedBy))+(p.assignedOn?`<small> · ${fmt(d2n(p.assignedOn))} ${new Date(d2n(p.assignedOn)*864e5).getUTCFullYear()}</small>`:''):'')}
        ${kv('Sales person',h(personTxt(p.salesPerson)))}
        ${kv('Project lead',p.owner?h(mName(p.owner)):'')}
        ${kv('Expected volume',h(p.volume||''))}
        ${kv('Reference product',h(p.refProduct||''))}
      </div>${hint('who')}
    </div>
    <div class="pf-tech ${op==='tech'?'on':''}" ${pa('tech')}>
      ${tx('Technical summary',p.techSummary)}
      ${tx('Additional technical inputs',p.techInputs)}
      ${!p.techSummary&&!p.techInputs?'<div class="pf-tx"><span>Technical summary</span><p class="muted">Not filled in yet.</p></div>':''}${hint('tech')}
    </div>
    <div class="pf-docs ${op==='docs'?'on':''}" ${pa('docs')}>
      <span>Documents</span>
      <b>${docs.length}</b>
      <div class="pf-cats">${cats.slice(0,4).map(c=>`<i>${h(c)}</i>`).join('')}${cats.length>4?`<i>+${cats.length-4}</i>`:''}</div>
      ${op==='docs'?(docs.length?`<div class="pf-flist">${docs.slice(0,12).map(f=>`<button type="button" class="pf-file" data-action="view-doc" data-id="${f.id}"><b>${h(f.name)}</b><small>${h(f.category==='Other'&&f.categoryOther?f.categoryOther:f.category)} · Rev ${h(f.rev||'—')}</small></button>`).join('')}${docs.length>12?`<small class="muted">+${docs.length-12} more in Details &amp; documents</small>`:''}</div>`:'<small class="muted">No documents yet.</small>'):''}${hint('docs')}
      <div class="pf-btns"><button type="button" class="btn sm" data-action="set-mode" data-v="details">Open details</button><button type="button" class="btn sm w" data-action="edit-project">Edit</button></div>
    </div>
  </section>`;
}
function viewDetails(p,m){
  const dl=(k,v,pre)=>`<div class="dl-r"><dt>${k}</dt><dd class="${pre?'pre':''}">${v?(pre?h(v):v):'<span class="muted">Not filled in</span>'}</dd></div>`;
  const ab=p.assignedBy?(S.members.has(p.assignedBy)?h(mName(p.assignedBy)):h(p.assignedBy)):'';
  const all=projFiles(p.id,true),cur=all.filter(f=>f.status==='current'),shown=ui.docAll?all:cur,fc=ui.docCat||'';
  const list=shown.filter(f=>!fc||f.category===fc);const cats=DOC_CATS.filter(c=>list.some(f=>f.category===c));
  return `${closeHistoryHtml(p)}${projDelaysHtml(p)}<div class="dgrid">
  <section class="panel"><div class="panel-h"><h2>Project details</h2><button type="button" class="btn sm w" data-action="edit-project">Edit</button></div>
    <dl class="dl">
      ${dl('Customer name',p.customerName?h(p.customerName):'')}
      ${dl('End customer name',p.endCustomer?h(p.endCustomer):'')}
      ${dl('Project projection / expected volume',p.volume?h(p.volume):'')}
      ${dl('Project introducer',ab?`${ab}${p.assignedOn?` · ${fmtY(d2n(p.assignedOn))}`:''}`:'')}
      ${dl('Project sales person',p.salesPerson?(S.members.has(p.salesPerson)?h(mName(p.salesPerson)):h(p.salesPerson)):'')}
      ${dl('Project lead',p.owner?h(mName(p.owner)):'')}
      ${dl('Planned',`${p.start?fmtY(d2n(p.start)):'—'} → ${p.target?fmtY(d2n(p.target)):'—'}`)}
      ${dl('Technical summary',p.techSummary,1)}
      ${dl('Reference product',p.refProduct,1)}
      ${dl('Additional technical inputs',p.techInputs,1)}
      ${dl('Description',p.description,1)}
    </dl></section>
  <section class="panel"><div class="panel-h"><h2>Documents <span class="muted small">${cur.length} current${all.length>cur.length?` · ${all.length-cur.length} older`:''}</span></h2><button type="button" class="btn primary sm w wd" data-action="doc-upload">Upload documents</button></div>
    <div class="toolbar"><select class="sel" id="docCat" data-change="docCat" aria-label="Filter by category"><option value="">All categories</option>${DOC_CATS.map(c=>`<option ${fc===c?'selected':''}>${c}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" id="docAll" ${ui.docAll?'checked':''} data-action="doc-all"> Show superseded &amp; archived</label></div>
    ${cats.map(c=>`<div class="dcat">${h(c)}</div>${list.filter(f=>f.category===c).map(f=>docRow(f,m)).join('')}`).join('')||`<div class="empty-note">${all.length?'No documents match.':'No documents yet. Upload customer requirements, datasheets, drawings, test reports and certificates so the design records stay with the project.'}</div>`}
  </section></div>`;
}
async function uploadCore(pid,files,o){
  const big=files.find(f=>f.size>25*1048576);if(big)throw new Error(`“${big.name}” is larger than 25 MB.`);
  const fd=new FormData();for(const f of files)fd.append('file',f);
  fd.append('projectId',pid);fd.append('taskId',o.task||'');fd.append('category',o.category);fd.append('categoryOther',o.category==='Other'?(o.other||''):'');fd.append('rev',o.rev||'A');fd.append('remarks',o.remarks);
  const r=await fetch('/api/files',{method:'POST',body:fd});const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||'Upload failed.');
  if(window.__plannerSync)window.__plannerSync();
  return j.files;
}
function catOpts(sel){return DOC_CATS.map(c=>`<option ${sel===c?'selected':''}>${c}</option>`).join('')}
function catLabel(f){return f.category==='Other'&&f.categoryOther?'Other: '+f.categoryOther:f.category}
function attRow(i,pid){const tm=pid&&S.projects.has(pid)?model(pid):null;return `<div class="attrow" data-row="${i}">
  <div class="attrow-h"><span class="lab">File ${i+1}</span>${i?`<button type="button" class="linkbtn" data-attdel>Remove</button>`:''}</div>
  <input type="file" class="att-file" accept="${DOC_EXT.split(',').map(e=>'.'+e).join(',')}" aria-label="File ${i+1}">
  <div class="two"><div class="fld"><label class="sub">Category</label><select class="att-cat">${catOpts('Design input')}</select></div>
    <div class="fld"><label class="sub">Revision</label><input type="text" class="att-rev" value="A" maxlength="12"></div></div>
  <div class="fld att-otherbox" hidden><label class="sub">Other: describe the type</label><input type="text" class="att-other" maxlength="60" placeholder="e.g. Purchase order, Tooling quotation"></div>
  <div class="fld"><label class="sub">Related task (optional)</label><select class="att-task"><option value="">Whole project</option>${tm?tm.flat.map(id=>{const I=tm.info.get(id);return `<option value="${id}">${I.wbs} ${h(I.t.title)}</option>`}).join(''):''}</select></div>
</div>`}
function drUpload(d){
  const p=S.projects.get(d.pid),m=model(d.pid),prev=d.replaces?S.files.get(d.replaces):null;
  const nr=r=>!r?'A':/^[A-Y]$/.test(r)?String.fromCharCode(r.charCodeAt(0)+1):(/\d+$/.test(r)?r.replace(/\d+$/,x=>+x+1):r+'.1');
  const tsel=prev?prev.taskId:(d.taskId||'');
  return `<form id="f" novalidate>${dHead(h(p.code||p.name),prev?'Upload new revision':'Upload documents')}
  <div class="dr-b">
    ${prev?`<div class="rollup">Replaces <b>${h(prev.name)}</b> Rev ${h(prev.rev||'A')}. The old file stays in the record, marked Superseded.</div>`:''}
    <div class="fld"><label for="up-file">${prev?'File':'Files'}</label><input type="file" id="up-file" ${prev?'':'multiple'} accept="${DOC_EXT.split(',').map(e=>'.'+e).join(',')}"><span class="hint">PDF, images, Office files, CAD/PCB files, ZIP… up to 25 MB each.</span></div>
    <div class="two"><div class="fld"><label for="up-cat">Category</label><select id="up-cat">${DOC_CATS.map(c=>`<option ${(prev?prev.category:'Design input')===c?'selected':''}>${c}</option>`).join('')}</select></div>
      <div class="fld"><label for="up-rev">Revision</label><input type="text" id="up-rev" maxlength="12" value="${h(prev?nr(prev.rev):'A')}"></div></div>
    <div class="fld" id="up-otherbox" hidden><label for="up-other">Other: describe the type</label><input type="text" id="up-other" maxlength="60" value="${h(prev&&prev.categoryOther||'')}" placeholder="e.g. Purchase order, Tooling quotation"></div>
    <div class="fld"><label for="up-task">Related task (optional)</label><select id="up-task"><option value="">Whole project</option>${m.flat.map(id=>{const I=m.info.get(id);return `<option value="${id}" ${tsel===id?'selected':''}>${I.wbs} ${h(I.t.title)}</option>`}).join('')}</select></div>
    <div class="fld"><label for="up-rem">Remarks · what is this file?</label><textarea id="up-rem" maxlength="1000" placeholder="e.g. Customer RFQ with tag read-range and temperature requirements, received 12 Oct" autofocus></textarea><span class="hint">Required. With several files selected, the remark applies to each of them.</span></div>
    <div class="hint" id="upProg"></div>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary" id="upBtn">${prev?'Upload revision':'Upload'}</button><button type="button" class="btn" data-action="close-drawer">Cancel</button></div></form>`;
}
async function uploadDocs(d){
  if(!canWrite())return formErr('You have read-only access.');
  const files=[...($('#up-file').files||[])];const remarks=$('#up-rem').value.trim();
  if(!files.length)return formErr('Choose at least one file.');
  if(!remarks)return formErr('Add a remark that says what the file is.');
  const big=files.find(f=>f.size>25*1048576);if(big)return formErr(`“${big.name}” is larger than 25 MB.`);
  const fd=new FormData();for(const f of files)fd.append('file',f);
  if($('#up-cat').value==='Other'&&!$('#up-other').value.trim())return formErr('Describe the “Other” category.');
  fd.append('projectId',d.pid);fd.append('taskId',$('#up-task').value);fd.append('category',$('#up-cat').value);fd.append('categoryOther',$('#up-cat').value==='Other'?$('#up-other').value.trim():'');fd.append('rev',$('#up-rev').value.trim());fd.append('remarks',remarks);if(d.replaces)fd.append('replaces',d.replaces);
  const btn=$('#upBtn');btn.disabled=true;btn.textContent='Uploading…';$('#upProg').textContent=`Uploading ${files.length} file${files.length>1?'s':''} (${fsize(files.reduce((a,f)=>a+f.size,0))})…`;
  try{const r=await fetch('/api/files',{method:'POST',body:fd});const j=await r.json().catch(()=>({}));
    if(!r.ok){btn.disabled=false;btn.textContent=d.replaces?'Upload revision':'Upload';$('#upProg').textContent='';return formErr(j.error||'Upload failed. Try again.')}
    const p=S.projects.get(d.pid)||{};const prev=d.replaces?S.files.get(d.replaces):null;
    logH({act:'created',kind:'doc',pid:d.pid,code:p.code||'',title:prev?`uploaded a new revision of “${prev.name}”`:`uploaded ${files.length} document${files.length>1?'s':''} to`,ch:[...j.files.map(f=>`${f.name} · Rev ${f.rev} · ${f.category}`),remarks.length>90?remarks.slice(0,90)+'…':remarks]});
    closeDrawer();toast(prev?'New revision uploaded':`${files.length} document${files.length>1?'s':''} uploaded`);if(window.__plannerSync)window.__plannerSync();
  }catch(e){btn.disabled=false;btn.textContent='Upload';$('#upProg').textContent='';formErr('Can’t reach the server. Check your connection.')}
}
function drDocEdit(d){
  const f=S.files.get(d.id);if(!f)return `${dHead('Documents','Not found')}`;const m=model(f.projectId);
  return `<form id="f" novalidate>${dHead(`${h(f.name)} · Rev ${h(f.rev||'A')}`,'Edit document details')}
  <div class="dr-b">
    <div class="fld"><label for="de-rem">Remarks · what is this file?</label><textarea id="de-rem" maxlength="1000">${h(f.remarks||'')}</textarea></div>
    <div class="two"><div class="fld"><label for="de-cat">Category</label><select id="de-cat">${DOC_CATS.map(c=>`<option ${f.category===c?'selected':''}>${c}</option>`).join('')}</select></div>
    <div class="fld" id="de-otherbox" hidden><label for="de-other">Other: describe the type</label><input type="text" id="de-other" maxlength="60" value="${h(f.categoryOther||'')}"></div>
    <div class="fld"><label for="de-task">Related task</label><select id="de-task"><option value="">Whole project</option>${m.flat.map(id=>{const I=m.info.get(id);return `<option value="${id}" ${f.taskId===id?'selected':''}>${I.wbs} ${h(I.t.title)}</option>`}).join('')}</select></div></div>
    <div class="hint">Uploaded by ${h(pName(f.by))}, ${fmtTs(f.at)} · ${fsize(f.size)} · SHA-256 ${h((f.sha256||'').slice(0,16))}…${f.status==='archived'?` · archived by ${h(pName(f.archivedBy))}`:''}</div>
    <span class="hint">To change the file itself, upload a new revision so the old one stays on record.</span>
    <div class="err" id="fErr" hidden></div>
  </div><div class="dr-f"><button type="submit" class="btn primary w">Save</button><button type="button" class="btn" data-action="close-drawer">Cancel</button></div></form>`;
}
function saveDocEdit(d){
  const f=S.files.get(d.id);if(!f)return closeDrawer();const remarks=$('#de-rem').value.trim();if(!remarks)return formErr('Add a remark that says what the file is.');
  const next={remarks,category:$('#de-cat').value,categoryOther:$('#de-cat').value==='Other'?$('#de-other').value.trim():'',taskId:$('#de-task').value};if(next.category==='Other'&&!next.categoryOther)return formErr('Describe the “Other” category.');const ch=diffFields([['Category',catLabel(f),catLabel(next)]]);if(f.remarks!==remarks)ch.push('Remarks edited');if((f.taskId||'')!==next.taskId)ch.push('Related task changed');
  if(!ch.length){closeDrawer();return toast('No changes')}
  put('files',d.id,{...clean(f),...next});logH({act:'edited',kind:'doc',pid:f.projectId,code:(S.projects.get(f.projectId)||{}).code||'',title:`edited the details of “${f.name}” in`,ch});closeDrawer();toast('Document details saved');
}
function openViewer(id){
  const f=S.files.get(id);if(!f)return;let v=$('#docViewer');if(!v){v=document.createElement('div');v.id='docViewer';v.className='viewer';document.body.appendChild(v);v.addEventListener('click',e=>{if(e.target===v||e.target.closest('[data-vclose]'))closeViewer()})}
  const src=`/api/files/${f.id}`,img=['png','jpg','jpeg','gif','webp','bmp'].includes(f.ext);
  const body=img?`<img src="${src}" alt="${h(f.name)}">`:f.ext==='mp4'?`<video src="${src}" controls></video>`:VIEWABLE.has(f.ext)?`<iframe src="${src}" title="${h(f.name)}"></iframe>`:`<div class="vnone"><p>This file type can’t be shown in the browser.</p><a class="btn primary" href="${src}?download=1">Download ${h(f.name)}</a></div>`;
  v.innerHTML=`<div class="vbox" role="dialog" aria-modal="true" aria-label="${h(f.name)}"><div class="vhead"><div style="min-width:0"><b>${h(f.name)}</b> <span class="revchip">Rev ${h(f.rev||'A')}</span><div class="as">${h(catLabel(f))} · ${h(f.remarks||'')}</div></div><span class="spacer"></span><a class="btn sm" href="${src}" target="_blank" rel="noopener">New tab</a><a class="btn sm" href="${src}?download=1">Download</a><button type="button" class="icon-btn" data-vclose aria-label="Close">✕</button></div><div class="vbody">${body}</div></div>`;
  v.hidden=false;
}
function closeViewer(){const v=$('#docViewer');if(v){v.hidden=true;v.innerHTML=''}}
function taskDocsHtml(tid){const fs=[...S.files.values()].filter(f=>f.taskId===tid&&f.status==='current');const t=S.tasks.get(tid);
  return `<div class="fld"><span class="lab">Documents</span>${fs.map(f=>`<div class="tdoc"><span class="dico e-${h(f.ext)}">${extIcon(f.ext)}</span><button type="button" class="hlink" data-action="view-doc" data-id="${f.id}">${h(f.name)}</button><span class="revchip">Rev ${h(f.rev||'A')}</span><span class="as" style="flex-basis:100%">${h(f.remarks||'')}</span></div>`).join('')||'<span class="hint">No documents linked to this task.</span>'}${t?`<button type="button" class="btn sm w wd" data-action="doc-upload" data-pid="${t.projectId}" data-task="${tid}" style="align-self:flex-start">Attach document</button>`:''}</div>`}

/* ---------- follow-up alert: blinking button + hourly spoken reminder ---------- */
const ALERT_STYLES={romantic:{label:'Romantic · soft, slow, tender',t:'Alert… you have a follow-up… waiting for you to check.',rate:0.72,pitch:0.82,vol:0.9,notes:[[523.3,0],[659.3,0.35],[784,0.7]],peak:0.18,len:1.6,gap:1500},
  warm:{label:'Warm · calm and smooth',t:'Alert! You have a follow-up to check.',rate:0.82,pitch:0.9,vol:1,notes:[[659.3,0],[523.3,0.28]],peak:0.28,len:0.9,gap:750},
  standard:{label:'Standard · clear and quick',t:'Alert! You have a follow-up to check.',rate:1,pitch:1,vol:1,notes:[[880,0],[660,0.22],[880,0.44]],peak:0.35,len:0.2,gap:750}};
const VOICE_PREF=[/Neerja.*Natural/i,/Natural.*(Female|Aria|Jenny|Sonia|Libby|Neerja)/i,/Google UK English Female/i,/Samantha/i,/Serena/i,/Karen/i,/Moira/i,/Tessa/i,/Neerja/i,/Heera/i,/Zira/i,/Female/i];
const aKey=k=>'rfid-alert-'+k+'-'+(ME.id||'local');
const aGet=(k,d)=>{try{const v=localStorage.getItem(aKey(k));return v===null?d:v}catch(e){return d}};
const aSet=(k,v)=>{try{localStorage.setItem(aKey(k),v)}catch(e){}};
let audioCtx=null,audioUnlocked=false,alertPending=false;
function myAlerts(){
  if(mode==='live'&&role()==='read')return [];
  const me=myMember(),adm=isAdmin(),out=[];
  for(const p of projList()){const m=model(p.id);const lead=me&&p.owner===me.id;
    for(const id of m.leaves){const I=m.info.get(id);if(!I.fu||!['due','missed'].includes(I.fu.kind))continue;
      if(adm||lead||(me&&I.t.assignee===me.id))out.push({p,I})}}
  return out;
}
function voices(){try{return speechSynthesis.getVoices().filter(x=>/^en/i.test(x.lang))}catch(e){return []}}
function pickedVoice(){const vs=voices();for(const re of VOICE_PREF){const v=vs.find(x=>re.test(x.name));if(v)return v}return vs[0]||null}
function playAlert(force){
  if(!force&&aGet('muted','0')==='1')return;
  if(!audioUnlocked){alertPending=true;return}
  const S=ALERT_STYLES.romantic;
  try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();const t=audioCtx.currentTime;
    for(const [f,d] of S.notes){const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='sine';o.frequency.value=f;g.gain.setValueAtTime(0,t+d);g.gain.linearRampToValueAtTime(S.peak,t+d+0.06);g.gain.exponentialRampToValueAtTime(0.001,t+d+S.len);o.connect(g).connect(audioCtx.destination);o.start(t+d);o.stop(t+d+S.len+0.05)}}catch(e){}
  setTimeout(()=>{try{if(!('speechSynthesis' in window))return;speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(S.t);u.lang='en-IN';u.rate=S.rate;u.pitch=S.pitch;u.volume=S.vol;const v=pickedVoice();if(v)u.voice=v;speechSynthesis.speak(u)}catch(e){}},S.gap);
  if(!force)aSet('last',String(Date.now()));
}
function alertTick(){
  if(!isLoaded()||gateState())return;
  const n=myAlerts().length;
  if(!n)return;
  const last=+aGet('last','0');
  if(Date.now()-last>=3600e3)playAlert(false);
}
function unlockAudio(){if(audioUnlocked)return;audioUnlocked=true;try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();audioCtx.resume&&audioCtx.resume()}catch(e){}
  if(alertPending){alertPending=false;setTimeout(()=>alertTick(),400)}}
document.addEventListener('pointerdown',unlockAudio,{once:false,capture:true});
document.addEventListener('keydown',unlockAudio,{capture:true});
try{if('speechSynthesis' in window){speechSynthesis.getVoices();speechSynthesis.onvoiceschanged=()=>{}}}catch(e){}
setInterval(alertTick,60000);setTimeout(alertTick,4000);
function alertSettingsHtml(){
  const muted=aGet('muted','0')==='1';
  return `<section class="panel alertset"><div class="panel-h"><h2>Alert sound</h2><button type="button" class="btn ${muted?'':'primary'}" data-action="alert-mute">${muted?'🔕 Sound off · turn on':'🔔 Sound on · turn off'}</button></div>
    <span class="hint">While a follow-up for you is due or missed, the Follow-ups button blinks red and a voice alert plays once an hour while the planner is open, until it gets an update or is completed. Turning the sound off affects only you, on this device; the button still blinks.</span></section>`;
}
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
  else if(d.type==='upload')el.innerHTML=drUpload(d);
  else if(d.type==='docedit')el.innerHTML=drDocEdit(d);
  else if(d.type==='skill')el.innerHTML=drSkill(d);
  else if(d.type==='log'){el.innerHTML=drLog(d);wireLog()}
  else if(d.type==='msreopen')el.innerHTML=drMsReopen(d);
  else if(d.type==='pclose')el.innerHTML=drProjClose(d);
  else if(d.type==='delay'){el.innerHTML=drDelay(d);wireDelay(d)}
  else if(d.type==='myleave'){el.innerHTML=drMyLeave(d);wireMyLeave(d)}
  else if(d.type==='book'){el.innerHTML=drBook(d);wireBook(d)}
  else if(d.type==='mypw'){el.innerHTML=drMyPw();const sh=$('#mp-show');sh.addEventListener('change',()=>['#mp-cur','#mp-new','#mp-new2'].forEach(q=>$(q).type=sh.checked?'text':'password'))}
  else if(d.type==='transfers'){el.innerHTML=drTransfers(d);wireTransfers()}
  else if(d.type==='level'){el.innerHTML=drAdvisor(d);wireAdvisor(d)}
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
    ${!d.id&&p&&p.status==='done'?`<div class="alert"><span>This project is <b>Completed</b>. Adding work moves it back to <b>Active</b>; it completes again when the new work is done.</span></div><div class="fld"><label for="f-reopen">Why is new work needed?</label><input type="text" id="f-reopen" maxlength="300" placeholder="e.g. Customer requested ECN rev B"></div>`:''}
    <div class="fld"><label for="f-title">Task name</label><input type="text" id="f-title" value="${h(t.title)}" required autofocus placeholder="e.g. Antenna matching network tuning"></div>
    ${isParent?`<div class="two">
      <div class="fld"><label for="f-assignee">Owner</label><select id="f-assignee"><option value="">Unassigned</option>${workList().map(x=>`<option value="${x.id}" ${t.assignee===x.id?'selected':''}>${h(x.name)}</option>`).join('')}</select></div>
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
    <div class="hint tim" id="timHint"></div>
    ${d.id&&I&&I.leaf&&isFinite(I.s)&&isFinite(I.e)?(()=>{const L=leaveIn(t.assignee,I.s,I.e),Hh=holIn(I.s,I.e);if(!L.length&&!Hh.length&&!t.calMoved)return '';return `<div class="calnote">${Hh.length?`<span><i class="lg-hol"></i>${Hh.length} holiday${Hh.length>1?'s':''}: ${Hh.slice(0,3).map(x=>`${h(x.name||'Holiday')} ${fmt(d2n(x.date))}`).join(', ')}${Hh.length>3?'…':''}</span>`:''}${L.length?`<span><i class="lg-lv"></i>${h(mName(t.assignee))} on leave ${L.map(r=>`${fmt(r.a)}${r.b!==r.a?'–'+fmt(r.b):''}${r.half?' (½)':''}`).join(', ')}</span>`:''}${t.calMoved?`<span class="muted">Dates last moved automatically ${fmtTs(t.calMoved.at)} (${h(t.calMoved.reason||'calendar change')}).</span>`:''}</div>`})():''}
    <div class="two">
      <div class="fld"><label for="f-effort">Effort needed</label><div class="codebox"><input type="number" id="f-effort" min="0.5" step="0.5" value="${h(t.effort??'')}" placeholder="e.g. 24" inputmode="decimal"><select id="f-eunit" class="sel" aria-label="Effort unit"><option value="h" ${t.effortUnit!=='d'?'selected':''}>hours</option><option value="d" ${t.effortUnit==='d'?'selected':''}>days</option></select></div><select class="sel" id="f-spread" aria-label="Effort spread" style="margin-top:6px">${SPREAD.map(([v,l])=>`<option value="${v}" ${(t.spread||'even')===v?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="fld"><label for="f-assignee">Owner</label><select id="f-assignee"></select></div>
    </div>
    ${isAdmin()?`<label class="chk"><input type="checkbox" id="f-override" ${t.outsideSkill?'checked':''}> Show everyone (admin override: assign outside the skill)</label>`:''}
    <div class="hint" id="effHint"></div><div id="bestFit"></div><div id="ownWarn"></div>
    ${d.id&&trPending(t)?`<div class="alert"><span><b>Transfer waiting:</b> ${h(mName(t.assignee))} → <b>${h(mName(t.transfer.to))}</b>, asked ${fmtTs(t.transfer.at)} by ${h(pName(t.transfer.by))}. The owner changes when ${h(mName(t.transfer.to))} accepts.</span>${t.transfer.to===myMid()?'<button type="button" class="btn sm primary" data-action="transfers">Review</button>':''}</div>`:''}
    <div class="two">
      <div class="fld"><label for="f-progress">Progress</label><div class="range"><input type="range" id="f-progress" min="0" max="100" step="5" value="${+t.progress||0}"><output id="progOut">${+t.progress||0}%</output></div></div>
      <div class="fld"><label for="f-status">Status</label><select id="f-status">${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${(t.status||'todo')===k?'selected':''}>${v}</option>`).join('')}</select></div>
    </div>
    ${msBox(t)}`}
    ${confl.length?`<div class="alert"><span><b>Schedule conflict.</b> This task starts ${fmt(I.s)}, before ${confl.map(c=>`${c.wbs} ${h(c.t.title)} finishes on ${fmt(c.e)}`).join('; ')}.</span><button type="button" class="btn warn w" data-action="resolve">Review fixes</button></div>`:''}
    <div class="fld"><span class="lab">Waits on (finish → start)</span>
      <span class="hint">Tick the tasks that must finish before this one can start. The start date then moves to the working day after the latest of them ends. Leave everything unticked for work that runs in parallel.</span>
      <div class="hint tim" id="depHint"></div>
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
      ${d.id&&I&&I.fu?`<div class="fuline">${fuChip(I.fu)}<span class="spacer"></span>${canEditTask(t)&&I.status!=='done'?`<button type="button" class="btn w" data-action="report-delay" data-id="${d.id}">Report delay</button>`:''}<button type="button" class="btn w" data-action="add-update" data-id="${d.id}">Add update</button></div>${upsFor(d.id).slice(0,3).map(upItem).join('')}`:''}
    </div>`}
    ${I&&I.leaf&&I.par?parentPanel(m,I,t):''}
    ${d.id?taskDocsHtml(d.id):''}
    ${d.id?successorsHtml(m,d.id):''}
    ${d.id?(()=>{const a=taskActual(d.id);return a.n?`<div class="rollup">Actual hours from the daily log: <b>${fh(a.h)} h</b> in ${a.n} entr${a.n===1?'y':'ies'}${+t.effort>0?` · planned ${fh(taskHours(t,S.members.get(t.assignee)))} h`:''}</div>`:''})():''}
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
  // View only people who add projects can't set the lead or the technical fields
  const roC=!canWrite()&&(d.id?isProjCreatorRO(d.id):canAddProj()),roDis=roC?' disabled':'',roNote=roC?'<span class="hint">Filled in by the project lead or an admin.</span>':'';
  return `<form id="f" novalidate>${dHead(d.id?h(p.code||'Project'):'New project',d.id?'Project details':'Create project')}
  <div class="dr-b">
    <div class="fld"><label for="p-name">Project name</label><input type="text" id="p-name" value="${h(p.name)}" required autofocus placeholder="e.g. UHF fixed reader, 4-port"></div>
    <div class="fld"><label for="p-desc">Description</label><textarea id="p-desc" placeholder="Scope, customer, standards (e.g. ISO 18000-63, ETSI EN 302 208)…">${h(p.description||'')}</textarea></div>
    <div class="two">
      <div class="fld"><label for="p-code">Project code</label><div class="codebox"><input type="text" id="p-code" value="${h(p.code||genCode())}" readonly maxlength="5" autocapitalize="characters" autocomplete="off" spellcheck="false" aria-describedby="codeHint"><button type="button" class="icon-btn" id="codeRegen" title="Generate a new code" aria-label="Generate a new code"><svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M11.5 7A4.5 4.5 0 1 1 10 3.6M10.2 1v2.8H7.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" class="btn" id="codeEdit">Edit</button></div><span class="hint" id="codeHint">Generated automatically.</span></div>
      <div class="fld"><label for="p-status">Status</label><select id="p-status">${projClosed(p)?`<option value="${p.status}" selected>${PSTATUS[p.status]}</option>`:PSTATUS_SET.map(k=>`<option value="${k}" ${(p.status||'planning')===k?'selected':''}>${PSTATUS[k]}</option>`).join('')}</select><span class="hint">Completed is set automatically when every task and milestone is done. Use Abort project on the project page to stop it.</span></div>
    </div>
    <div class="fld"><label for="p-rank">Priority</label><select id="p-rank">${[['','Not ranked'],...[1,2,3,4,5,6,7,8,9,10].map(n=>[n,'P'+n+(n===1?' · highest':'')])].map(([v,l])=>`<option value="${v}" ${String(p.rank||'')===String(v)?'selected':''}>${l}</option>`).join('')}</select><span class="hint">When people are overloaded, the Load advisor moves work from lower-priority projects first.</span></div>
    <div class="fld"><label for="p-owner">Project lead</label><select id="p-owner"${roDis}><option value="">None</option>${workList().map(x=>`<option value="${x.id}" ${p.owner===x.id?'selected':''}>${h(x.name)}</option>`).join('')}</select>${roNote}</div>
    <div class="two">
      <div class="fld"><label for="p-start">Planned start</label><input type="date" id="p-start" value="${h(p.start||'')}"></div>
      <div class="fld"><label for="p-target">Target finish</label><input type="date" id="p-target" value="${h(p.target||'')}"></div>
    </div>
    <span class="hint">The target date draws a dashed line on the timeline and flags a slip when tasks run past it.</span>
    <label class="chk"><input type="checkbox" id="p-autotg" ${p.autoTarget===false?'':'checked'}${roDis}> Move the target automatically when delays push work past it</label>
    <span class="hint">On by default. When a reported delay, a holiday or someone’s leave pushes the work past the target, the target moves to the new finish, the change is recorded and the project’s stakeholders are emailed.${p.target0&&p.target0!==p.target?` Original target: <b>${fmtY(d2n(p.target0))}</b>.`:''}</span>
    ${(()=>{const pc=fuCfg({},p);return `<div class="fu3">
      <div class="fld"><label for="p-fu">How often to ask</label><select id="p-fu">${FU_FREQ.map(([v,l])=>`<option value="${v}" ${pc.f===v?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="fld"><label for="p-ful">Deadline Mode</label><select id="p-ful">${FU_LEAD.map(([v,l])=>`<option value="${v}" ${String(pc.l)===String(v)?'selected':''}>${l}</option>`).join('')}</select></div>
      <div class="fld"><label for="p-fdl">Deadline frequency</label><select id="p-fdl">${FU_DL.map(([v,l])=>`<option value="${v}" ${pc.dlf===v?'selected':''}>${l}</option>`).join('')}</select></div>
    </div>`})()}
    <span class="hint">Follow-ups for every task in this project: ask at “How often to ask”; when the deadline is near, Deadline Mode switches to the faster “Deadline frequency” and pauses the regular asks. Each task can override these.</span>
    <div class="fld"><span class="lab">Project details · design records</span></div>
    <div class="two"><div class="fld"><label for="p-ab" class="sub">Project Introducer</label><input type="text" id="p-ab" list="p-ab-list" value="${h(p.assignedBy&&S.members.has(p.assignedBy)?mName(p.assignedBy):(p.assignedBy||''))}" placeholder="e.g. CEO, partner, team member" maxlength="80"><datalist id="p-ab-list">${memberList().map(x=>`<option value="${h(x.name)}">`).join('')}</datalist></div>
      <div class="fld"><label for="p-ao" class="sub">Introduced on</label><input type="date" id="p-ao" value="${h(p.assignedOn||'')}"></div></div>
    <div class="two"><div class="fld"><label for="p-sp" class="sub">Project Sales Person</label><input type="text" id="p-sp" list="p-ab-list" value="${h(p.salesPerson&&S.members.has(p.salesPerson)?mName(p.salesPerson):(p.salesPerson||''))}" placeholder="Name of the sales person" maxlength="80"></div>
      <div class="fld"><label for="p-cn" class="sub">Customer Name</label><input type="text" id="p-cn" value="${h(p.customerName||'')}" placeholder="Company / customer" maxlength="120"></div></div>
    <div class="fld"><label for="p-ecn" class="sub">End Customer Name</label><input type="text" id="p-ecn" value="${h(p.endCustomer||'')}" placeholder="Who finally uses the product, if different from the customer" maxlength="120"></div>
    <div class="fld"><label for="p-vol" class="sub">Project Projection / Expected Volume</label><input type="text" id="p-vol" value="${h(p.volume||'')}" placeholder="e.g. 50,000 tags per month; 2 lakh units in year 1" maxlength="160"></div>
    <div class="fld"><label for="p-ts" class="sub">Project technical summary</label><textarea id="p-ts"${roDis} placeholder="What is being developed and its key specifications (frequency band, read range, protocol, environment…)">${h(p.techSummary||'')}</textarea>${roNote}</div>
    <div class="fld"><label for="p-rp" class="sub">Project’s reference product</label><textarea id="p-rp" style="min-height:52px" placeholder="Existing or competitor product used as reference: name, maker, part number">${h(p.refProduct||'')}</textarea></div>
    <div class="fld"><label for="p-ti" class="sub">Additional technical inputs</label><textarea id="p-ti"${roDis} placeholder="Standards (ISO 18000-63, ETSI EN 302 208, BIS…), customer requirements, constraints">${h(p.techInputs||'')}</textarea>${roNote}</div>
    ${canWrite()||(d.id?isProjCreatorRO(d.id):canAddProj())?`<div class="fld evbox"><span class="lab">Attachments · documents, pictures, PDFs</span>
      ${d.id?`<span class="hint">${projFiles(d.id).length} document${projFiles(d.id).length===1?'':'s'} on file. <button type="button" class="linkbtn" data-action="open-docs" data-id="${d.id}">View them in Details &amp; documents</button></span>`:''}
      <div id="attRows">${attRow(0,d.id)}</div>
      <button type="button" class="btn sm" id="attAdd" style="align-self:flex-start">+ Add another file</button>
      <span class="hint" id="p-fhint">Each file has its own category, revision and related task. Files upload when you save the project. Add remarks later with Edit in Details &amp; documents if needed.</span></div>`:''}
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary ${canWrite()?'w':'wp'}">${d.id?'Save changes':'Create project'}</button>${d.id?`<span class="spacer"></span><button type="button" class="btn danger w" data-action="delete-project" data-id="${d.id}" data-two="Delete project and all tasks">Delete</button>`:'<button type="button" class="btn" data-action="close-drawer">Cancel</button>'}</div></form>`;
}
function drMember(d){
  const x=d.id?S.members.get(d.id):{name:'',role:''};
  return `<form id="f" novalidate>${dHead('Team',d.id?h(x.name):'Add team member')}
  <div class="dr-b">
    <div class="fld"><label for="m-type">User type</label><select id="m-type">${[['write','Read & write · team member who works on tasks'],['admin','Admin · manages everything'],['read','View only · sees chosen projects, changes nothing']].map(([v,l])=>`<option value="${v}" ${(x.accessType||'write')===v?'selected':''}>${l}</option>`).join('')}</select></div>
    <div class="fld"><label for="m-name">Name</label><input type="text" id="m-name" value="${h(x.name)}" required autofocus placeholder="Full name"></div>
    <div class="fld"><label for="m-role">Role</label><input type="text" id="m-role" value="${h(x.role||'')}" placeholder="e.g. RF hardware engineer"></div>
    <div class="fld"><label for="m-email">Email ID</label><input type="email" id="m-email" value="${h(x.email||'')}" placeholder="name@company.com" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="120"></div>
    <span class="hint" id="m-emhint">Follow-up emails go here for tasks they own, and for every task in projects they lead.</span>
    <div class="fld" id="m-vis" hidden><span class="lab">Projects this person can see</span>
      <div class="vplist">${[...S.projects.values()].sort((a,b)=>String(a.name).localeCompare(b.name)).map(pp=>`<label class="chk"><input type="checkbox" name="vp" value="${pp.id}" ${(x.visibleProjects||[]).includes(pp.id)?'checked':''}> <span class="mono small">${h(pp.code||'')}</span> ${h(pp.name)}${(()=>{const ac=d.id&&[...S.access.values()].find(q=>q.memberId===d.id);return ac&&pp.createdBy===ac.id?' <span class="tag">added by them</span>':''})()}</label>`).join('')||'<span class="hint">No projects yet.</span>'}</div>
      <div class="actions"><button type="button" class="btn sm" data-vp="all">Select all</button><button type="button" class="btn sm" data-vp="none">Clear</button></div>
      <span class="hint">View only people see just these projects (tasks, timeline, documents and their history) and can’t change anything. New projects stay hidden until you tick them here.</span>
      <label class="chk addp-chk"><input type="checkbox" id="m-addp" ${x.canAddProjects?'checked':''}> <span><b>Can add new projects</b><span class="hint" style="display:block">They can create projects, fill in all the details and attachments, and later edit the projects they added. They can’t add tasks or delete projects. Each project they add is ticked above automatically; untick it to take away their view and edit access to it.</span></span></label>
      <label class="chk addp-chk"><input type="checkbox" id="m-abortp" ${x.canAbortProjects?'checked':''}> <span><b>Can abort projects</b><span class="hint" style="display:block">They can abort the projects ticked above, with a comment (for example when a customer cancels). Only the project lead or an admin can reopen a project.</span></span></label></div>
    <div id="m-work">
    <div class="fld"><span class="lab">Skills</span>${skillList().length?`<div class="sklist">${skillList().map(sk=>`<div class="skrow"><span>${h(sk.name)}</span><select class="sel" id="ms-${sk.id}" data-sk="${sk.id}" aria-label="${h(sk.name)} level">${[['','—'],['assist','Can assist'],['expert','Expert']].map(([v,l])=>`<option value="${v}" ${((x.skills||{})[sk.id]||'')===v?'selected':''}>${l}</option>`).join('')}</select></div>`).join('')}</div>`:'<span class="hint">No skills defined yet. Add them in Admin settings → Skills &amp; calendar.</span>'}</div>
    <div class="two">
      <div class="fld"><label for="m-hpd">Productive hours per day</label><input type="number" id="m-hpd" min="1" max="12" step="0.5" value="${h(x.hoursPerDay||6)}"><label for="m-wip" style="margin-top:8px">Max tasks at once (optional)</label><input type="number" id="m-wip" min="1" max="20" step="1" value="${h(x.wip||'')}" placeholder="No limit"></div>
      <div class="fld"><span class="lab">Working days</span><div class="wdays">${[1,2,3,4,5,6,0].map(dd=>`<label class="wd"><input type="checkbox" name="wd" value="${dd}" ${memberCap(x).wd.includes(dd)?'checked':''}><span>${WDN[dd]}</span></label>`).join('')}</div></div>
    </div>
    <div class="fld"><span class="lab">Leave</span><div id="leaveList"></div>
      <div class="leaveadd"><input type="date" id="lv-from" aria-label="Leave from"><input type="date" id="lv-to" aria-label="Leave to"><input type="text" id="lv-note" placeholder="Note (optional)" maxlength="60" aria-label="Leave note"><button type="button" class="btn" id="lvAdd">Add</button></div>
      <span class="hint">Leave days and company holidays reduce this person’s capacity in Resource load.</span></div>
    </div>
    <div class="err" id="fErr" hidden></div>
  </div>
  <div class="dr-f"><button type="submit" class="btn primary w">${d.id?'Save changes':'Add member'}</button>${d.id?`<span class="spacer"></span><button type="button" class="btn danger w" data-action="delete-member" data-id="${d.id}" data-two="Remove and unassign tasks">Remove</button>`:'<button type="button" class="btn" data-action="close-drawer">Cancel</button>'}</div></form>`;
}
function drResolve(d){
  const p=S.projects.get(d.pid);const moves=d.moves0||planResolve(d.pid);d.moves=moves;const sg=x=>x>0?'+'+x+'d':x+'d';
  if(d.follow)return `${dHead(h(p.code||p.name),'Move linked tasks?')}
  <div class="dr-b">
    <p style="margin:0">You changed the dates of <b>${h(d.follow.title)}</b>. ${moves.length+(d.follow.blocked||[]).length} task${moves.length+(d.follow.blocked||[]).length>1?'s wait':' waits'} on it. Move ${moves.length>1?'them':'it'} so each starts on the working day after what it waits on finishes? Their length in working days stays the same; finished tasks don’t move, and started tasks are only moved later, never earlier.</p>
    <div>${moves.map(mv=>`<div class="mv"><span class="wbs">${mv.I.wbs}</span><span>${h(mv.I.t.title)}</span><span class="d"><s>${fmt(mv.I.s)} – ${fmt(mv.I.e)}</s> → <b>${fmt(mv.s)} – ${fmt(mv.e)}</b> (${sg(mv.s-mv.I.s)})</span></div>`).join('')}</div>
    ${d.follow.blocked&&d.follow.blocked.length?`<div class="alert"><span><b>${d.follow.blocked.length} other linked task${d.follow.blocked.length>1?'s':''}</b> belong${d.follow.blocked.length>1?'':'s'} to someone else, so you can’t move ${d.follow.blocked.length>1?'them':'it'}: ${d.follow.blocked.map(x=>`${x.I.wbs} ${h(x.I.t.title)} (${h(mName(x.I.t.assignee))})`).join(', ')}. Tell the project lead${(S.projects.get(d.pid)||{}).owner?` (${h(mName(S.projects.get(d.pid).owner))})`:''}.</span></div>`:''}
  </div>
  <div class="dr-f">${moves.length?`<button type="button" class="btn primary w" data-action="apply-resolve">Move ${moves.length} task${moves.length>1?'s':''}</button><button type="button" class="btn" data-action="close-drawer">Keep their dates</button>`:'<button type="button" class="btn" data-action="close-drawer">Close</button>'}</div>`;
  return `${dHead(h(p.code||p.name),'Fix link conflicts')}
  <div class="dr-b">
    <p style="margin:0">${moves.length?`Moving these ${moves.length} task${moves.length>1?'s':''} so each one starts on the next working day after everything it waits on has finished. Durations stay the same, and later tasks in the chain shift too.`:'Nothing needs to move. Every linked task already starts after its predecessors finish.'}</p>
    <div>${moves.map(mv=>`<div class="mv"><span class="wbs">${mv.I.wbs}</span><span>${h(mv.I.t.title)}</span><span class="d"><s>${fmt(mv.I.s)} – ${fmt(mv.I.e)}</s> → <b>${fmt(mv.s)} – ${fmt(mv.e)}</b> (${sg(mv.s-mv.I.s)})</span></div>`).join('')}</div>
  </div>
  <div class="dr-f">${moves.length?`<button type="button" class="btn primary w" data-action="apply-resolve">Move ${moves.length} task${moves.length>1?'s':''}</button>`:''}<button type="button" class="btn" data-action="close-drawer">${moves.length?'Cancel':'Close'}</button></div>`;
}
function wireDrawer(){
  const f=$('#f');if(f)f.addEventListener('submit',onSubmit);
  {const dr=$('#drawer'),d=drawer;let lock='',ownerOnly=false;
    if(d&&d.type==='task'){const t=d.id?S.tasks.get(d.id):d.draft;if(d.id&&canWrite()&&projFrozen(t.projectId))lock=`This project is <b>${h(PSTATUS[S.projects.get(t.projectId).status])}</b>, so its tasks are frozen. ${canManageProj0(t.projectId)?'Reopen the project to change them.':'The project lead or an admin can reopen it.'}`;
      else if(d.id&&canWrite()&&!canEditTask(t))lock=`Only <b>${h(t.assignee?mName(t.assignee):'the task owner')}</b> (task owner)${(S.projects.get(t.projectId)||{}).owner?`, <b>${h(mName(S.projects.get(t.projectId).owner))}</b> (project lead)`:', the project lead'} or an admin can change this task. You can read it.`;
      else if(d.id&&canWrite()&&!isAdmin()&&!isLead(t.projectId))ownerOnly=true}
    if(d&&d.type==='project'&&d.id&&projFrozen(d.id))lock=`This project is <b>${h(PSTATUS[S.projects.get(d.id).status])}</b>, so its details are frozen. ${canManageProj0(d.id)?'Reopen it from the project page to change them.':'The project lead or an admin can reopen it.'}`;
    else if(d&&d.type==='project'&&d.id&&canWrite()&&!canEditProjInfo(d.id)){const p=S.projects.get(d.id);lock=`Only the project lead${p&&p.owner?` (<b>${h(mName(p.owner))}</b>)`:''} or an admin can change this project. You can read it.`}
    dr.classList.toggle('ro-d',!!lock);
    if(lock){const b=dr.querySelector('.dr-b');if(b)b.insertAdjacentHTML('afterbegin',`<div class="rollup lockmsg">🔒 ${lock}</div>`);dr.querySelectorAll('.dr-b input,.dr-b select,.dr-b textarea,.dr-b .codebox button').forEach(x=>{if(x.id!=='depSearch')x.disabled=true})}
    if(ownerOnly){const a=$('#f-assignee');if(a){a.disabled=true;a.title='Only the project lead or an admin can change the owner'}const del=dr.querySelector('[data-action=delete-task]');if(del)del.remove()}}
  const projOk=drawer&&((drawer.type==='project'&&(drawer.id?isProjCreatorRO(drawer.id):canAddProj()))||(drawer.type==='pclose'&&drawer.act==='abort'&&canAbortProj(drawer.pid))||drawer.type==='myleave');
  if(!canWrite()&&!projOk)document.querySelectorAll('#drawer .dr-b input,#drawer .dr-b select,#drawer .dr-b textarea,#drawer .codebox button').forEach(x=>{if(x.id!=='depSearch')x.disabled=true});
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
  const mt=$('#m-type');if(mt){const t=()=>{const ro=mt.value==='read';$('#m-work').hidden=ro;$('#m-vis').hidden=!ro;$('#m-emhint').hidden=ro};mt.addEventListener('change',t);t();
    document.querySelectorAll('#m-vis [data-vp]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();document.querySelectorAll('#m-vis input[name=vp]').forEach(c=>c.checked=b.dataset.vp==='all')}));
    if(!canManage()){mt.disabled=true;document.querySelectorAll('#m-vis input').forEach(c=>c.disabled=true)}}
  if(drawer&&drawer.type==='member'){
    if(!drawer.leave){const mm=drawer.id?S.members.get(drawer.id):null;drawer.leave=mm&&mm.leave?mm.leave.map(r=>({...r})):[]}
    const draw=()=>{const box=$('#leaveList');if(!box)return;const L=drawer.leave.slice().sort((a,b)=>a.from<b.from?-1:1);drawer.leave=L;
      box.innerHTML=L.length?L.map((r,i)=>`<div class="lvrow"><span class="mono small">${fmt(d2n(r.from))}${r.to&&r.to!==r.from?' – '+fmt(d2n(r.to)):''}${r.half?' · ½ day':''}</span><span class="small">${h(r.note||'Leave')}${r.by&&r.by!==meKey()?` <span class="muted">· added by ${h(pName(r.by))}</span>`:''}</span><button type="button" class="linkbtn" data-lv="${i}">Remove</button></div>`).join(''):'<span class="hint">No leave added.</span>'};
    draw();
    $('#leaveList').addEventListener('click',e=>{const b=e.target.closest('[data-lv]');if(!b)return;drawer.leave.splice(+b.dataset.lv,1);draw()});
    $('#lvAdd').addEventListener('click',()=>{const f=$('#lv-from').value,t=$('#lv-to').value||f,n=$('#lv-note').value.trim();if(!f)return formErr('Pick the first day of leave.');if(d2n(t)<d2n(f))return formErr('Leave ends before it starts.');drawer.leave.push({from:f,to:t,note:n});$('#lv-from').value='';$('#lv-to').value='';$('#lv-note').value='';$('#fErr').hidden=true;draw()});
    if(!canWrite())$('#lvAdd').disabled=true;
  }
  wireOwnerPicker();wireTiming();wireMilestones();
  const ar=$('#attRows');if(ar){let n=1;
    ar.addEventListener('change',e=>{if(e.target.classList.contains('att-cat')){const b=e.target.closest('.attrow').querySelector('.att-otherbox');b.hidden=e.target.value!=='Other';if(!b.hidden)b.querySelector('input').focus()}});
    ar.addEventListener('click',e=>{if(e.target.closest('[data-attdel]')){e.preventDefault();e.stopPropagation();e.target.closest('.attrow').remove()}});
    $('#attAdd').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();ar.insertAdjacentHTML('beforeend',attRow(n++,drawer&&drawer.id));ar.lastElementChild.querySelector('.att-file').focus()})}
  const uc=$('#up-cat');if(uc){const t=()=>{$('#up-otherbox').hidden=uc.value!=='Other'};uc.addEventListener('change',t);t()}
  const dc=$('#de-cat');if(dc){const t=()=>{$('#de-otherbox').hidden=dc.value!=='Other'};dc.addEventListener('change',t);t()}
  const pful=$('#p-ful');if(pful){const t=()=>{$('#p-fdl').disabled=pful.value==='off'||(!canWrite()&&!(drawer&&drawer.type==='project'&&(drawer.id?isProjCreatorRO(drawer.id):canAddProj())))};pful.addEventListener('change',t);t()}
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
  document.querySelectorAll('.u-ms').forEach(cb=>cb.addEventListener('change',()=>{const all=[...document.querySelectorAll('.u-ms')],n=all.length,dn=all.filter(x=>x.checked).length;const hh=$('#uMsHint');if(hh)hh.innerHTML=`${dn} of ${n} completed = <b>${Math.round(dn/n*100)}%</b> after saving.`}));
  const up=$('#u-prog');if(up&&up.type==='range'){up.addEventListener('input',()=>{$('#uProgOut').textContent=up.value+'%';$('#u-done').checked=+up.value===100});$('#u-done').addEventListener('change',e=>{if(e.target.checked){up.value=100;$('#uProgOut').textContent='100%'}})}
  const ds=$('#depSearch');if(ds)ds.addEventListener('input',()=>{const q=ds.value.toLowerCase().trim();document.querySelectorAll('#deplist .dep').forEach(l=>l.hidden=q&&!l.dataset.q.includes(q))});
}
function formErr(msg){const e=$('#fErr');e.textContent=msg;e.hidden=false}
async function onSubmit(ev){
  ev.preventDefault();const d=drawer;if(!d)return;
  if(d.type==='cred')return d.mid?saveMemberCred(d):saveCred(d);
  if(d.type==='update')return saveUpdate(d);
  if(d.type==='pclose')return saveProjClose(d);
  if(d.type==='delay')return saveDelay(d);
  if(d.type==='myleave')return saveMyLeave(d);
  if(d.type==='book')return saveBook(d);
  if(d.type==='editupdate')return saveEditUpdate(d);
  if(d.type==='upload')return uploadDocs(d);
  if(d.type==='docedit')return saveDocEdit(d);
  if(d.type==='skill')return saveSkill(d);
  if(d.type==='log')return saveLog(d);
  if(d.type==='msreopen')return saveMsReopen(d);
  if(d.type==='mypw')return saveMyPw();
  if(d.type==='task'){
    const old=d.id?S.tasks.get(d.id):d.draft;
    if(d.id?!canEditTask(old):!canAddTask(old.projectId,old.parentId))return formErr(d.id?'Only the task owner, the project lead or an admin can change this task.':'Only the project lead or an admin can add tasks here.');
    if(d.id&&!isAdmin()&&!isLead(old.projectId)&&$('#f-assignee')&&$('#f-assignee').value!==(old.assignee||''))return formErr('Only the project lead or an admin can change who owns this task.');
    const title=$('#f-title').value.trim();if(!title)return formErr('Give the task a name.');
    const reopenWhy=$('#f-reopen')?$('#f-reopen').value.trim():'';if($('#f-reopen')&&!reopenWhy)return formErr('Say why new work is needed on this completed project.');
    const data={...clean(old),title,assignee:$('#f-assignee').value,priority:$('#f-priority').value,notes:$('#f-notes').value.trim(),
      deps:[...document.querySelectorAll('#deplist input[name=dep]:checked')].map(i=>i.value)};
    if(reopenWhy){data.reopenWhy=reopenWhy;data.reopenAt=Date.now()}
    if($('#f-skill')){const sk=$('#f-skill').value;if(!sk)return formErr('Choose the required skill for this task.');const ef=+$('#f-effort').value;if(!(ef>0))return formErr('Enter the effort this task needs, in hours or days.');
      data.skill=sk;data.effort=ef;data.effortUnit=$('#f-eunit').value;data.spread=$('#f-spread').value;
      const ow=S.members.get(data.assignee);const outside=!!(ow&&sk!=='general'&&!(ow.skills||{})[sk]);
      if(outside&&!isAdmin()&&ow.id!==(old.assignee||''))return formErr(`${ow.name} doesn’t have this skill. Pick someone who does, or ask an admin.`);
      data.outsideSkill=outside}
    if($('#f-pstart')){const ps=$('#f-pstart').value,pe=$('#f-pend').value;if(!!ps!==!!pe)return formErr('Set both the planned start and planned end, or leave both empty.');if(ps&&d2n(pe)<d2n(ps))return formErr('The planned end is before the planned start.');data.start=ps;data.end=pe}
    if($('#f-start')){const s=$('#f-start').value,e=$('#f-end').value;if(!s||!e)return formErr('Set a start and end date.');if(d2n(e)<d2n(s))return formErr('The end date is before the start date.');
      data.start=s;data.end=e;data.progress=+$('#f-progress').value;data.status=$('#f-status').value;
      if(data.status==='done')data.progress=100;if(data.progress===100)data.status='done'}
    if($('#ms-on')){const r=readMilestones(old);if(r.err)return formErr(r.err);
      if(r.ms.length&&data.start&&data.end){const a=d2n(data.start),b=d2n(data.end);const bad=r.ms.find(x=>x.due&&(d2n(x.due)<a||d2n(x.due)>b));if(bad)return formErr(`The target date of “${bad.name}” must be within the task’s dates, ${dLab(data.start)} – ${dLab(data.end)}.`)}
      if(r.ms.length){data.ms=r.ms;Object.assign(data,withMsProgress(data))}else delete data.ms}
    if($('#f-fu')){data.fu=$('#f-fu').value===''?'':+$('#f-fu').value;data.fuLead=$('#f-ful').value===''?'':parseLead($('#f-ful').value);data.fuDl=$('#f-fdl').value===''?'':+$('#f-fdl').value}
    let stretchList=[];
    if(data.parentId&&data.start&&data.end){stretchList=stretchNeeds(data.parentId,d2n(data.start),d2n(data.end),{id:d.id||'',title:data.title});
      if(stretchList.length){const noRight=stretchList.find(x=>!canEditTask(x.t));const ef=$('#fErr');
        if(noRight){const pl=(S.projects.get(data.projectId)||{}).owner;ef.innerHTML=`These dates run outside the main task ${stretchText(noRight)}. Only its owner, the project lead${pl?` (${h(mName(pl))})`:''} or an admin can stretch it. Keep the dates inside, or ask them.`;ef.hidden=false;return}
        if(!d.stretchOk){ef.innerHTML=`<div class="stretchask"><b>This subtask runs outside its main task.</b> Stretch it so the subtask fits?<ul>${stretchList.map(x=>`<li>${stretchText(x)}</li>`).join('')}</ul><div class="actions"><button type="button" class="btn primary" data-action="stretch-ok">Stretch and save</button><button type="button" class="btn" data-action="stretch-no">Keep my dates inside</button></div><span class="hint">The Gantt keeps showing the stretched part of the main task, so everyone sees it grew because of this subtask.</span></div>`;ef.hidden=false;ef.scrollIntoView({block:'nearest',behavior:'smooth'});return}}}
    const id=d.id||uid('t');if(!d.id)data.order=Date.now();
    const mm=model(data.projectId),pc=S.projects.get(data.projectId);
    const datesMoved=!!d.id&&((old.start||'')!==(data.start||'')||(old.end||'')!==(data.end||''));
    put('tasks',id,data);
    const ch=d.id?diffTask(old,data,mm).concat(msChanges(old,data)):[...msChanges({},data),data.assignee?'Owner: '+mName(data.assignee):'',data.start?`Dates: ${dLab(data.start)} – ${dLab(data.end)}`:''].filter(Boolean);
    if(!d.id||ch.length)logH({act:d.id?'edited':'created',kind:'task',id,pid:data.projectId,title:data.title,code:pc?pc.code:'',ch});
    if(data.parentId)ui.collapsed.delete(data.parentId);
    {const II=d.id?model(data.projectId).info.get(id):null;toast(d.id&&II&&II.par&&data.status==='done'&&II.ropen?`Saved. Marked done, but ${II.ropen} subtask${II.ropen>1?'s are':' is'} still open.`:(d.id?'Task saved':'Task added'))}closeDrawer();
    if(stretchList.length){stretchList.forEach(x=>x.cause.id=id);applyStretch(stretchList);toast(`Saved. “${stretchList[0].t.title}” stretched to ${fmt(stretchList[0].ns)} – ${fmt(stretchList[0].ne)}.`)}
    if(datesMoved||stretchList.length){const all=[...planFollow(data.projectId,id),...stretchList.flatMap(x=>planFollow(data.projectId,x.id))].filter((v,i,a)=>a.findIndex(y=>y.id===v.id)===i),mv=all.filter(x=>canEditTask(x.I.t));if(all.length)openDrawer({type:'resolve',pid:data.projectId,moves0:mv,follow:{title:data.title,blocked:all.filter(x=>!canEditTask(x.I.t))}})}
  }else if(d.type==='project'){
    if(!canNewProject())return formErr('You have read-only access.');if(d.id&&!canEditProjInfo(d.id))return formErr('Only the project lead or an admin can change this project.');if(!d.id&&!isAdmin()&&!myMid())return formErr('Your login isn’t linked to a team member yet. Ask an admin to link it before creating projects.');
    const name=$('#p-name').value.trim();if(!name)return formErr('Give the project a name.');
    const pAtt=[];for(const [k,r] of [...document.querySelectorAll('#attRows .attrow')].entries()){const f=r.querySelector('.att-file').files[0];if(!f)continue;
      const o={file:f,category:r.querySelector('.att-cat').value,other:r.querySelector('.att-other').value.trim(),rev:r.querySelector('.att-rev').value.trim()||'A',remarks:'',task:r.querySelector('.att-task').value};
      if(o.category==='Other'&&!o.other)return formErr(`File ${k+1}: describe the “Other” category.`);pAtt.push(o)}
    const t=$('#p-target').value,s=$('#p-start').value;if(t&&s&&d2n(t)<d2n(s))return formErr('Target finish is before the planned start.');
    const old=d.id?S.projects.get(d.id):{order:Date.now()};
    const code=$('#p-code').value.trim().toUpperCase();
    if(!(code===old.code||/^[A-Z0-9]{5}$/.test(code)))return formErr('Project code must be exactly 5 capital letters or digits.');
    if([...S.projects.values()].some(x=>x.id!==d.id&&x.code===code))return formErr(`Code ${code} is already used by another project. Generate a new one or enter a different code.`);
    const id=d.id||uid('p');
    const pdata={...clean(old),name,code,owner:$('#p-owner').value,status:$('#p-status').value,start:s,target:t,description:$('#p-desc').value.trim(),assignedBy:(()=>{const v=$('#p-ab').value.trim();const mm=memberList().find(x=>x.name.toLowerCase()===v.toLowerCase());return mm?mm.id:v})(),assignedOn:$('#p-ao').value,salesPerson:(()=>{const v=$('#p-sp').value.trim();const mm=memberList().find(x=>x.name.toLowerCase()===v.toLowerCase());return mm?mm.id:v})(),customerName:$('#p-cn').value.trim(),endCustomer:$('#p-ecn').value.trim(),volume:$('#p-vol').value.trim(),techSummary:$('#p-ts').value.trim(),refProduct:$('#p-rp').value.trim(),techInputs:$('#p-ti').value.trim(),rank:$('#p-rank').value?+$('#p-rank').value:'',fuFreq:+$('#p-fu').value,autoTarget:!!($('#p-autotg')&&$('#p-autotg').checked),fuLead:parseLead($('#p-ful').value),fuDl:+$('#p-fdl').value};
    if((old.target||'')!==(pdata.target||'')){pdata.target0='';pdata.targetLog=[...(old.targetLog||[]),{at:Date.now(),from:old.target||'',to:pdata.target||'',reason:'changed by hand',auto:false,by:meKey()}]}if(!canWrite()){pdata.owner=old.owner||'';pdata.techSummary=old.techSummary||'';pdata.techInputs=old.techInputs||''}const pSaved=put('projects',id,pdata,{addp:true});if(!d.id&&!canWrite()){const mm=myMember();if(mm){const vp=Array.isArray(mm.visibleProjects)?mm.visibleProjects:[];if(!vp.includes(id))S.members.set(mm.id,{...mm,visibleProjects:[...vp,id]})}}const pch=d.id?diffProject(old,pdata).concat(String(old.rank||'')!==String(pdata.rank||'')?[`Priority: ${old.rank?'P'+old.rank:'Not ranked'} → ${pdata.rank?'P'+pdata.rank:'Not ranked'}`]:[]):[];if(!d.id||pch.length)logH({act:d.id?'edited':'created',kind:'project',id,pid:id,title:name,code,ch:pch});
    closeDrawer();if(!d.id){ui.view='project';ui.pid=id;toast('Project created. Add its first task.')}else toast('Project saved');
    if(pAtt.length){toast(`Uploading ${pAtt.length} file${pAtt.length>1?'s':''}…`);(async()=>{const done=[];try{await pSaved;for(const o of pAtt){const r=await uploadCore(id,[o.file],o);done.push(...r)}}catch(e){toast(((e&&e.message)||'Upload failed.')+(done.length?` ${done.length} uploaded before the error.`:'')+' Open Details & documents to try again.')}
      if(done.length){logH({act:'created',kind:'doc',pid:id,code,title:`uploaded ${done.length} document${done.length>1?'s':''} to`,ch:done.map(f=>`${f.name} · Rev ${f.rev} · ${catLabel(f)} · ${String(f.remarks||'').slice(0,60)}`)});if(done.length===pAtt.length)toast(`${done.length} document${done.length>1?'s':''} uploaded`)}})()}
  }else if(d.type==='member'){
    const name=$('#m-name').value.trim();if(!name)return formErr('Enter a name.');
    const old=d.id?S.members.get(d.id):{order:Date.now(),hue:nextHue()};
    const memail=$('#m-email').value.trim().toLowerCase();if(memail&&!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(memail))return formErr('Enter a valid email ID, like name@company.com.');
    if(memail&&[...S.members.values()].some(o=>o.id!==d.id&&(o.email||'').toLowerCase()===memail))return formErr('Another team member already uses this email ID.');
    const mid=d.id||uid('m'),mrole=$('#m-role').value.trim();
    const msk={};document.querySelectorAll('#drawer [data-sk]').forEach(el=>{if(el.value)msk[el.dataset.sk]=el.value});
    const utype=$('#m-type').value,vro=utype==='read',vps=[...document.querySelectorAll('#m-vis input[name=vp]:checked')].map(i=>i.value);
    if(utype!==(old.accessType||'write')&&d.id&&!canManage())return formErr('Only admins can change the user type.');
    const hpd=Math.min(12,Math.max(1,+$('#m-hpd').value||6)),wdays0=[...document.querySelectorAll('#drawer input[name=wd]:checked')].map(i=>+i.value),wdays=wdays0.length?wdays0:memberCap(old).wd;
    if(!vro&&!wdays0.length)return formErr('Pick at least one working day.');
    const wip=+$('#m-wip').value>0?Math.round(+$('#m-wip').value):'';put('members',mid,{...clean(old),name,role:mrole,email:memail,skills:vro?(old.skills||{}):msk,hoursPerDay:hpd,workDays:wdays,leave:d.leave||[],wip,accessType:utype,visibleProjects:vro?vps:(old.visibleProjects||[]),canAddProjects:vro&&!!($('#m-addp')&&$('#m-addp').checked),canAbortProjects:vro&&!!($('#m-abortp')&&$('#m-abortp').checked)});
    {const acc=[...S.access.values()].find(a=>a.memberId===mid);if(acc&&acc.role!==utype&&canManage()&&acc.id!==ME.id){put('access',acc.id,{...clean(acc),role:utype},{sys:true})}}
    const skTxt=o=>Object.entries(o||{}).filter(([k])=>S.skills.has(k)).map(([k,v])=>skillName(k)+(v==='expert'?' (Expert)':'')).sort().join(', ');
    const mch=d.id?diffFields([['Name',old.name,name],['Role',old.role||'',mrole],['Email',old.email||'',memail],['Skills',skTxt(old.skills),skTxt(msk)],['Hours/day',old.hoursPerDay||6,hpd],['Working days',memberCap(old).wd.map(x=>WDN[x]).join(' '),wdays.map(x=>WDN[x]).join(' ')],['Leave entries',(old.leave||[]).length,(d.leave||[]).length],['Max tasks at once',old.wip||'No limit',wip||'No limit'],['User type',ROLE[old.accessType||'write'],ROLE[utype]],['Visible projects',(old.visibleProjects||[]).map(i=>(S.projects.get(i)||{}).code||'').sort().join(', '),(vro?vps:(old.visibleProjects||[])).map(i=>(S.projects.get(i)||{}).code||'').sort().join(', ')]]):[mrole,memail,skTxt(msk)].filter(Boolean);if(!d.id||mch.length)logH({act:d.id?'edited':'created',kind:'member',id:mid,title:name,ch:mch});
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
  ui.view='overview';await Promise.all(ts.map(t=>del('tasks',t.id)));del('projects',id);logH({act:'deleted',kind:'project',id,pid:id,title:pj?pj.name:'',code:pj?pj.code:'',ch:[`${ts.length} task${ts.length===1?'':'s'} removed`]});toast('Project deleted');
}
async function deleteMember(id){
  if(!canWrite())return toast('You have read-only access.');
  if(!isAdmin())return toast('Only an admin can remove team members.');
  closeDrawer();
  for(const t of S.tasks.values())if(t.assignee===id)put('tasks',t.id,{...clean(t),assignee:''});
  for(const p of S.projects.values())if(p.owner===id)put('projects',p.id,{...clean(p),owner:''});
  const mb=S.members.get(id);del('members',id);logH({act:'deleted',kind:'member',id,title:mb?mb.name:''});toast('Member removed; their tasks are now unassigned');
}
async function applyResolve(){
  const d=drawer;if(!d||!d.moves)return;const moves=d.moves;closeDrawer();
  for(const mv of moves){const t=S.tasks.get(mv.id);if(t&&canEditTask(t))put('tasks',mv.id,{...clean(t),start:n2d(mv.s),end:n2d(mv.e)})}
  stretchAfterMoves(moves.map(mv=>mv.id));
  logH({act:'moved',kind:'bulk',pid:d.pid,title:d.follow?`Moved ${moves.length} linked task${moves.length>1?'s':''} after changing ${d.follow.title}`:`Rescheduled ${moves.length} task${moves.length>1?'s':''} to fix link conflicts`,code:(S.projects.get(d.pid)||{}).code||'',ch:moves.map(mv=>`${mv.I.wbs} ${mv.I.t.title}: ${fmt(mv.s)} – ${fmt(mv.e)}`)});
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
  'new-project':()=>{if(!canNewProject())return toast('You have read-only access.');openDrawer({type:'project'})},
  'edit-project':()=>{if(!canEditProjInfo(ui.pid))return noEdit('project');openDrawer({type:'project',id:ui.pid})},
  'new-member':()=>openDrawer({type:'member'}),
  'edit-member':el=>openDrawer({type:'member',id:el.dataset.id}),
  'new-task':()=>{if(!canAddTask(ui.pid,''))return toast(projFrozen(ui.pid)?'This project is aborted. Reopen it to add tasks.':'Only the project lead or an admin can add tasks to this project.');openDrawer({type:'task',draft:newTaskDraft(ui.pid,'')})},
  'new-subtask':el=>{const t=S.tasks.get(el.dataset.id);if(!t)return;if(!canAddTask(t.projectId,t.id))return toast(projFrozen(t.projectId)?'This project is closed. Reopen it to add work.':'Only the task owner, the project lead or an admin can add subtasks here.');openDrawer({type:'task',draft:newTaskDraft(t.projectId,t.id)})},
  'edit-task':el=>{if(S.tasks.has(el.dataset.id))openDrawer({type:'task',id:el.dataset.id})},
  'toggle':el=>{const id=el.dataset.id;ui.collapsed.has(id)?ui.collapsed.delete(id):ui.collapsed.add(id);saveUi();render()},
  'expand-all':()=>{const m=model(ui.pid);m.flat.forEach(x=>ui.collapsed.delete(x));saveUi();render()},
  'collapse-all':()=>{const m=model(ui.pid);m.flat.forEach(x=>{if(m.info.get(x).par&&m.info.get(x).depth===0)ui.collapsed.add(x)});saveUi();render()},
  'set-mode':el=>{ui.mode=el.dataset.v;saveUi();render()},
  'set-zoom':el=>{ui.zoom=el.dataset.v;saveUi();render()},
  'jump-today':()=>{const g=$('#gantt');if(g)g.scrollTo({left:Math.max(0,+g.dataset.todayx-g.clientWidth*0.25),behavior:'smooth'})},
  'resolve':()=>{if(!canEditProject(drawer&&drawer.type==='task'?(S.tasks.get(drawer.id)?.projectId||ui.pid):ui.pid))return toast('Only the project lead or an admin can reschedule linked tasks.');const pid=drawer&&drawer.type==='task'?(S.tasks.get(drawer.id)?.projectId||ui.pid):ui.pid;openDrawer({type:'resolve',pid})},
  'apply-resolve':applyResolve,
  'close-drawer':closeDrawer,
  'delete-task':el=>{const t=S.tasks.get(el.dataset.id);if(t&&!canEditProject(t.projectId))return toast('Only the project lead or an admin can delete tasks.');deleteTask(el.dataset.id)},
  'delete-project':el=>{if(!canEditProject(el.dataset.id))return noEdit('project');deleteProject(el.dataset.id)},
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
  'alert-mute':()=>{const m=aGet('muted','0')==='1';aSet('muted',m?'0':'1');if(m){toast('Alert sound on')}else{try{speechSynthesis.cancel()}catch(e){}toast('Alert sound muted. The button keeps blinking until follow-ups are done.')}render()},
  'doc-upload':el=>{const pid=el.dataset.pid||ui.pid;if(pid&&!canProjDocs(pid))return toast('Only the project lead, task owners in this project or an admin can upload documents here.');if(pid&&canWrite())openDrawer({type:'upload',pid,taskId:el.dataset.task||''})},
  'doc-rev':el=>{const f=S.files.get(el.dataset.id);if(f&&!canProjDocs(f.projectId))return toast('Only the project lead, task owners in this project or an admin can add revisions here.');if(f&&canWrite())openDrawer({type:'upload',pid:f.projectId,replaces:f.id})},
  'doc-edit':el=>{if(S.files.has(el.dataset.id))openDrawer({type:'docedit',id:el.dataset.id})},
  'view-doc':el=>openViewer(el.dataset.id),
  'doc-all':()=>{ui.docAll=!ui.docAll;render()},
  'open-docs':el=>{closeDrawer();ui.view='project';ui.pid=el.dataset.id;ui.mode='details';render();window.scrollTo(0,0)},
  'doc-status':el=>{const f=S.files.get(el.dataset.id);if(!f||!isAdmin())return;const v=el.dataset.v;put('files',f.id,{...clean(f),status:v});logH({act:v==='archived'?'deleted':'edited',kind:'doc',pid:f.projectId,code:(S.projects.get(f.projectId)||{}).code||'',title:`${v==='archived'?'archived':'restored'} “${f.name}” Rev ${f.rev||'A'} in`});toast(v==='archived'?'Document archived':'Document restored')},
  'edit-update':el=>{if(S.updates.has(el.dataset.id))openDrawer({type:'editupdate',uid:el.dataset.id})},
  'del-update':el=>deleteUpdate(el.dataset.id),
  'keep-own':el=>{const nid=keepOwnWork(el.dataset.id);if(nid){toast('Kept as a subtask. Open it to adjust dates or effort.');renderDrawer()}},
  'level':()=>openDrawer({type:'level'}),
  'transfers':()=>openDrawer({type:'transfers'}),
  'report-delay':el=>{const t=S.tasks.get(el.dataset.id);if(!t)return;if(!canEditTask(t))return toast(projFrozen(t.projectId)?'This project is closed.':'Only the task owner, the project lead or an admin can report a delay.');openDrawer({type:'delay',tid:t.id})},
  'delay-csv':()=>delayCsv(),
  'hol-template':()=>holTemplate(),
  'hol-apply':()=>holApply(),
  'hol-cancel':()=>{ui.holPlan=null;render()},
  'proj-abort':()=>{if(!canAbortProj(ui.pid))return toast('Only the project lead or an admin can abort this project.');openDrawer({type:'pclose',pid:ui.pid,act:'abort'})},
  'proj-reopen':()=>{if(!canManageProj0(ui.pid))return toast('Only the project lead or an admin can reopen this project.');openDrawer({type:'pclose',pid:ui.pid,act:'reopen'})},
  'load-opt':el=>{ui[el.dataset.k]=el.dataset.k==='loadWeeks'?+el.dataset.v:el.dataset.v;ui.loadSel=null;render()},
  'load-cell':el=>{const b=el.dataset.by;if(!b){ui.loadSel=null;return render()}const k=el.dataset.k||'',w=el.dataset.w!=null?+el.dataset.w:null,p=el.dataset.p||null;const c=ui.loadSel;ui.loadSel=c&&c.by===b&&c.k===k&&c.w===w&&c.p===p?null:{by:b,k,w,p};ui.detAll=false;render();setTimeout(()=>{const d=document.querySelector('.ldetail');if(d)d.scrollIntoView({block:'nearest',behavior:'smooth'})},30)},
  'af-set':el=>{const F=afGet(),k=el.dataset.k,v=el.dataset.v;if(k==='pids')F.pids=[];else F[k]=v;if(k==='period'&&v==='year'&&!F.year)F.year=curFy();if(k==='period'&&v==='custom'&&!F.from){F.from=n2d(TODAY).slice(0,7);F.to=F.from}ui.loadSel=null;afSave();render()},
  'af-person':el=>{const id=el.dataset.id||null,go=!!el.dataset.go;ui.afPerson=!id?null:go?id:(ui.afPerson===id?null:id);if(go&&id){ui.view='load';ui.loadBy='person';window.scrollTo(0,0)}render();if(ui.afPerson)setTimeout(()=>{const d=document.querySelector('.pdet');if(d)d.scrollIntoView({block:'nearest',behavior:'smooth'})},30)},
  'af-psort':el=>{ui.ppSort=el.dataset.v;render()},
  'af-detall':()=>{ui.detAll=!ui.detAll;render()},
  'af-csv':()=>afCsv(),
  'go-backup':()=>{ui.view='admin';ui.adminTab='backup';render()},
  'bk-json':()=>bkJson(),
  'bk-excel':()=>bkExcel(),
  'bk-now':async()=>{if(bkBusy)return;bkBusy=true;render();toast('Backing up…');try{const r=await fetch('/api/backup',{method:'POST'});const j=await r.json().catch(()=>({}));srvBk=j;srvBkAt=Date.now();toast(r.ok?'Backup saved on the server':'Backup failed: '+(j.message||'server error'))}catch(e){toast('Couldn’t reach the server.')}bkBusy=false;render()},
  'bk-restore':()=>bkRestore(),
  'gfy-all':()=>setGFy(''),
  'bk-cancel':()=>{ui.bkPlan=null;render()},
  'pf-toggle':el=>{const id=el.dataset.id,pt=el.dataset.part;ui.pfOpen=ui.pfOpen&&ui.pfOpen.pid===id&&ui.pfOpen.part===pt?null:{pid:id,part:pt};render();const n=document.querySelector(`.pf [data-part="${pt}"]`);if(n)n.focus({preventScroll:true})},
  'new-log':el=>{if(!logMid())return toast('Your login isn’t linked to a team member.');
    if(el.dataset.bk){const m=S.members.get(logMid()),b=(m.bookings||[]).find(x=>x.id===el.dataset.bk);if(b){const v=bkLogData(m,b,el.dataset.d,+b.hours);return openDrawer({type:'log',draft:v,bookingId:b.id})}}
    const src=el.dataset.plan&&S.logs.get(el.dataset.plan);const sd=ui.view==='log'&&ui.logDate&&d2n(ui.logDate)<=TODAY?ui.logDate:n2d(TODAY);openDrawer({type:'log',draft:{date:el.dataset.d||sd,what:src?src.plan:'',pid:src?src.pid:'',taskId:src?src.taskId:'',type:src?src.type:'Lab testing'},fromPlan:src?src.id:''})},
  'open-log':el=>{const l=S.logs.get(el.dataset.id);if(l&&canSeeLog(l))openDrawer({type:'log',id:l.id})},
  'log-day':el=>{ui.logDate=el.dataset.d;render()},
  'log-month':el=>{ui.logMonth=el.dataset.v;render()},
  'log-tab':el=>{ui.logTab=el.dataset.v;render()},
  'log-delete':el=>deleteLog(el.dataset.id),
  'log-who':el=>{const F=ui.logF;if(F){F.who=F.who===el.dataset.id?'':el.dataset.id;render()}},
  'log-csv':()=>logCsv(),
  'sheet-csv':()=>sheetCsv(),
  'sheet-pdf':()=>tablePdf(sheetTable(),`Timesheet_${ui.sheetFy?fyLabel(+ui.sheetFy).replace(/\s+/g,'_'):sheetData().mo}.pdf`),
  'af-pdf':()=>afPdf(),
  'rename-skill':el=>{if(canManage())openDrawer({type:'skill',id:el.dataset.id})},
  'del-skill':el=>deleteSkill(el.dataset.id),
  'del-hol':el=>{if(!canManage())return;const x=holidayList().find(y=>y.date===el.dataset.v);put('calendar','holidays',{days:holidayList().filter(y=>y.date!==el.dataset.v)},{sys:true});logH({act:'changed',kind:'settings',title:`removed the holiday ${x?x.name:''} on ${fmtY(d2n(el.dataset.v))}`});toast('Holiday removed')},
  'add-update':el=>{const t=S.tasks.get(el.dataset.id);if(!t)return;if(!isAdmin()&&!isLead(t.projectId)&&!isTaskOwner(t))return toast('Only the task owner, the project lead or an admin can add follow-up updates.');openDrawer({type:'update',id:el.dataset.id})},
  'fu-show':el=>{ui.fuShow=el.dataset.v;render()},
  'fu-tab':el=>{ui.fuTab=el.dataset.v;render()},
  'ms-show':el=>{ui.msShow=el.dataset.v;render()},
  'ms-complete':el=>{const t=S.tasks.get(el.dataset.tid);if(!t)return;if(!canEditTask(t))return toast('Only the task owner, the project lead or an admin can complete milestones.');const x=msList(t).find(y=>y.id===el.dataset.id);if(completeMilestones(t.id,[el.dataset.id]))toast(`“${x?x.name:'Milestone'}” completed · task now ${msProg(S.tasks.get(t.id))}%`)},
  'ms-csv':()=>msCsv(),
  'book-ahead':()=>{if(!logMid()&&!isAdmin())return toast('Your login isn’t linked to a team member.');openDrawer({type:'book'})},
  'bk-confirm':el=>bkConfirm(el.dataset.id,el.dataset.d),
  'my-leave':()=>{if(!myMember())return toast('Your login isn’t linked to a team member. Ask an admin to link it.');openDrawer({type:'myleave'})},
  'my-pw':()=>{if(!window.__plannerSync||!myCreds())return toast('Ask an admin to change your password.');openDrawer({type:'mypw'})},
  'stretch-ok':()=>{if(!drawer)return;drawer.stretchOk=true;const f=$('#f');if(f)f.requestSubmit()},
  'stretch-no':()=>{const e=$('#fErr');if(e){e.hidden=true;e.innerHTML=''}const s=$('#f-start');if(s)s.focus()},
  'ms-reopen':el=>{const t=S.tasks.get(el.dataset.tid);if(!t)return;if(!canEditTask(t))return toast('Only the task owner, the project lead or an admin can reopen milestones.');openDrawer({type:'msreopen',tid:t.id,mid:el.dataset.id})},
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
document.addEventListener('change',e=>{const ds=e.target.dataset||{};
  if(e.target.id==='ov-fy'||e.target.id==='gfy-ban'||e.target.id==='gfy-rail'){setGFy(e.target.value);return}
  if(e.target.id==='bk-fy'){ui.bkFy=e.target.value;return}
  if(e.target.id==='sheet-fy'){ui.sheetFy=e.target.value;render();return}
  if(e.target.id==='log-fy'){const v=e.target.value;if(v!==''){const [A,B]=fyRange(+v);const F=ui.logF||(ui.logF={});F.from=n2d(A);F.to=n2d(Math.min(B,TODAY))}render();return}
  if(e.target.id==='fy-start'){if(!canManage())return;const v=+e.target.value;put('calendar','fy',{start:v},{sys:true});logH({act:'changed',kind:'settings',title:`Financial year starts in ${MON[v-1]}`,ch:[]});anaCache=null;toast(`Financial year now runs ${MON[v-1]} – ${MON[(v+10)%12]}`);return}if(e.target.id==='bk-pw'){ui.bkPw=e.target.checked;return}if(e.target.id==='bk-file'){const f=e.target.files&&e.target.files[0];e.target.value='';bkPick(f);return}if(e.target.id==='bk-docs'){const f=e.target.files&&e.target.files[0];e.target.value='';bkDocsRestore(f);return}if(e.target.id==='bk-docpid'){ui.bkDocPid=e.target.value;render();return}if(ds.logf){if(ui.logF){ui.logF[ds.logf]=e.target.value;render()}return}if(ds.sheet){ui.sheetMonth=e.target.value;render();return}if(ds.af&&ds.af!=='q'){const F=afGet();if(ds.af==='pid'){const id=e.target.value;F.pids=e.target.checked?[...new Set([...F.pids,id])]:F.pids.filter(x=>x!==id)}else F[ds.af]=['pmin','pmax','year'].includes(ds.af)?+e.target.value:e.target.value;if(ds.af==='pmin'&&+F.pmax<+F.pmin)F.pmax=F.pmin;if(ds.af==='pmax'&&+F.pmin>+F.pmax)F.pmin=F.pmax;ui.loadSel=null;afSave();render();return}if(ds.acc){updateAccess(ds.uid,ds.acc,e.target.value);return}if(ds.link){if(e.target.value){const pm=S.members.get(ds.link);updateAccess(e.target.value,'memberId',ds.link);setTimeout(()=>applyMemberSetup(e.target.value,ds.link),80);if(pm&&pm.accessType&&e.target.value!==ME.id)setTimeout(()=>updateAccess(e.target.value,'role',pm.accessType),50)}return}
  if(ds.mtype){const m=S.members.get(ds.mtype);if(!m||!canManage())return;const before=m.accessType||'write',val=e.target.value;put('members',m.id,{...clean(m),accessType:val});logH({act:'edited',kind:'member',id:m.id,title:m.name,ch:[`Account type: ${ROLE[before]} → ${ROLE[val]} (when they join)`]});toast(`${m.name} will get ${ROLE[val]} access when they join`+(val==='admin'?'. Also share the page with them as Editor.':''));return}
  if(e.target.id&&e.target.id.startsWith('rq-m-')){const rs=$('#rq-r-'+e.target.id.slice(5)),pm=S.members.get(e.target.value);if(rs&&pm&&pm.accessType)rs.value=pm.accessType;return}if(ds.change){ui[ds.change]=e.target.value;render()}});
document.addEventListener('input',e=>{const t=e.target,ds=t.dataset||{};if(ds.af==='q'){afGet().q=t.value;clearTimeout(afT);afT=setTimeout(render,250)}else if('afps' in ds){ui.afPs=t.value;const q=t.value.toLowerCase().trim(),box=t.closest('.afpop');if(box)box.querySelectorAll('label[data-q]').forEach(l=>l.hidden=!!q&&!l.dataset.q.includes(q))}});
document.addEventListener('click',e=>{if(!ui.afPickOpen||!e.target.closest)return;if(e.target.closest('.afpick'))return;ui.afPickOpen=false;document.querySelectorAll('details.afpick[open]').forEach(x=>x.open=false)},true);
document.addEventListener('toggle',e=>{if(e.target.classList&&e.target.classList.contains('afpick'))ui.afPickOpen=e.target.open},true);
document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches&&e.target.matches('.pf>[data-part]')){e.preventDefault();actions['pf-toggle'](e.target);return}if(e.key==='Escape'){const v=$('#docViewer');if(v&&!v.hidden)return closeViewer();if(drawer)closeDrawer()}});
render();

}
