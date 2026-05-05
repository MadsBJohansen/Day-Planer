import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────
// SUPABASE CONFIG
// ─────────────────────────────────────────────
const SB_URL = "https://njzaqmawzrzbuapwozvd.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qemFxbWF3enJ6YnVhcHdvenZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MDQ3NTgsImV4cCI6MjA5MzQ4MDc1OH0.IwBHu4n_SegF_wuB1mcuQhy-AF09xABsBxMW_06Ysb4";

const HEADERS = {
  "Content-Type": "application/json",
  "apikey": SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
  "Prefer": "return=representation",
};

async function sbGet(table, params = "") {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function sbUpsert(table, data) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function sbUpdate(table, match, data) {
  const params = Object.entries(match).map(([k,v])=>`${k}=eq.${v}`).join("&");
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function sbDelete(table, match) {
  const params = Object.entries(match).map(([k,v])=>`${k}=eq.${v}`).join("&");
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
    method: "DELETE",
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(await res.text());
}

async function sbInsert(table, data) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ─────────────────────────────────────────────
// DB ↔ APP  row mapping
// ─────────────────────────────────────────────
function rowToTask(r) {
  return { id: r.id, name: r.name, person: r.person, frequency: r.frequency, duration: r.duration, mentalLoad: r.mental_load, done: r.done };
}
function taskToRow(t) {
  return { id: t.id, name: t.name, person: t.person, frequency: t.frequency, duration: t.duration, mental_load: t.mentalLoad || 0, done: t.done };
}

// ─────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function weekKey() {
  const d = new Date();
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;
}
function fmtDate(key) {
  if (!key) return "";
  if (key.includes("W")) { const [yr,w]=key.split("-W"); return `Uge ${w}, ${yr}`; }
  const [yr,mo,dy] = key.split("-");
  const months = ["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"];
  return `${parseInt(dy)}. ${months[parseInt(mo)-1]} ${yr}`;
}

// ─────────────────────────────────────────────
// AUTO-RESET
// ─────────────────────────────────────────────
async function runAutoReset(tasks) {
  const dk = todayKey();
  const wk = weekKey();
  let metaRows = await sbGet("meta", "id=eq.1");
  const meta = metaRows[0] || {};

  let changed = false;

  if (meta.last_day_key && meta.last_day_key !== dk) {
    // Snapshot daily tasks into history
    const dailyTasks = tasks.filter(t => t.frequency === "daily");
    if (dailyTasks.length) {
      await sbInsert("history", dailyTasks.map(t => ({
        period_key: meta.last_day_key, task_id: t.id, name: t.name,
        person: t.person, frequency: t.frequency, duration: t.duration,
        mental_load: t.mentalLoad || 0, done: t.done,
      })));
    }
    // Reset daily tasks
    for (const t of dailyTasks) await sbUpdate("tasks", { id: t.id }, { done: false });
    changed = true;
  }

  if (meta.last_week_key && meta.last_week_key !== wk) {
    const weeklyTasks = tasks.filter(t => t.frequency === "weekly");
    if (weeklyTasks.length) {
      await sbInsert("history", weeklyTasks.map(t => ({
        period_key: meta.last_week_key, task_id: t.id, name: t.name,
        person: t.person, frequency: t.frequency, duration: t.duration,
        mental_load: t.mentalLoad || 0, done: t.done,
      })));
    }
    for (const t of weeklyTasks) await sbUpdate("tasks", { id: t.id }, { done: false });
    changed = true;
  }

  await sbUpdate("meta", { id: 1 }, { last_day_key: dk, last_week_key: wk });
  return changed;
}

// ─────────────────────────────────────────────
// DEFAULT TASKS  (seeded on first load)
// ─────────────────────────────────────────────
const DEFAULT_TASKS = [
  { id:1, name:"Gå ud med skrald",   person:"Mads",  frequency:"daily",  duration:10, mentalLoad:5,  done:false },
  { id:2, name:"Støvsug stuen",       person:"Nadia", frequency:"weekly", duration:20, mentalLoad:5,  done:false },
  { id:3, name:"Vask op",             person:"Mads",  frequency:"daily",  duration:15, mentalLoad:10, done:false },
  { id:4, name:"Rengør badeværelse",  person:"Nadia", frequency:"weekly", duration:30, mentalLoad:15, done:false },
  { id:5, name:"Tøjvask",             person:"Nadia", frequency:"weekly", duration:10, mentalLoad:20, done:false },
  { id:6, name:"Aftør køkken",        person:"Mads",  frequency:"daily",  duration:8,  mentalLoad:3,  done:false },
];

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const PERSONS  = ["Mads","Nadia"];
const COLORS   = { Mads:"#4f9cf9", Nadia:"#f97bb0" };
const ML_COLOR = "#9b72cf";
const MONTHS   = ["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"];

function calcTime(tasks, person) {
  const mine = tasks.filter(t=>t.person===person);
  const dw = mine.filter(t=>t.frequency==="daily").reduce((s,t)=>s+t.duration,0);
  const ww = mine.filter(t=>t.frequency==="weekly").reduce((s,t)=>s+t.duration,0);
  const dm = mine.filter(t=>t.frequency==="daily").reduce((s,t)=>s+(t.mentalLoad||0),0);
  const wm = mine.filter(t=>t.frequency==="weekly").reduce((s,t)=>s+(t.mentalLoad||0),0);
  return { daily:dw, weekly:dw*7+ww, mlDaily:dm, mlWeekly:dm*7+wm };
}

// ─────────────────────────────────────────────
// MODAL
// ─────────────────────────────────────────────
function Modal({ task, onSave, onClose }) {
  const [form, setForm] = useState(task ? {...task} : { name:"", person:"Mads", frequency:"daily", duration:10, mentalLoad:5 });
  const set = (k,v) => setForm(f=>({...f,[k]:v}));
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e=>e.stopPropagation()}>
        <h2 style={S.modalTitle}>{task?.id ? "Rediger opgave" : "Ny opgave"}</h2>

        <label style={S.label}>Opgavenavn</label>
        <input style={S.input} value={form.name} onChange={e=>set("name",e.target.value)} placeholder="F.eks. Støvsug stuen"/>

        <label style={S.label}>Person</label>
        <div style={S.segRow}>
          {PERSONS.map(p=>(
            <button key={p} style={{...S.seg,...(form.person===p?{background:COLORS[p],color:"#fff",borderColor:COLORS[p]}:{})}}
              onClick={()=>set("person",p)}>{p}</button>
          ))}
        </div>

        <label style={S.label}>Frekvens</label>
        <div style={S.segRow}>
          {[["daily","Daglig"],["weekly","Ugentlig"]].map(([v,l])=>(
            <button key={v} style={{...S.seg,...(form.frequency===v?{background:"#1a1a2e",color:"#fff",borderColor:"#1a1a2e"}:{})}}
              onClick={()=>set("frequency",v)}>{l}</button>
          ))}
        </div>

        <label style={S.label}>Varighed (minutter)</label>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <input type="range" min={1} max={120} value={form.duration} onChange={e=>set("duration",Number(e.target.value))} style={{flex:1,accentColor:"#1a1a2e"}}/>
          <span style={S.durBadge}>{form.duration} min</span>
        </div>

        <label style={S.label}>Mental load (minutter)</label>
        <div style={S.mlHint}>Planlægning, koordinering, bekymring — den usynlige tid.</div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <input type="range" min={0} max={60} value={form.mentalLoad??0} onChange={e=>set("mentalLoad",Number(e.target.value))} style={{flex:1,accentColor:ML_COLOR}}/>
          <span style={{...S.durBadge,color:ML_COLOR}}>{form.mentalLoad??0} min</span>
        </div>

        <div style={{display:"flex",gap:10,marginTop:24}}>
          <button style={S.btnPrimary} onClick={()=>{if(form.name.trim())onSave(form);}}>Gem</button>
          <button style={S.btnGhost} onClick={onClose}>Annuller</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// TASK CARD
// ─────────────────────────────────────────────
function TaskCard({ task, onToggle, onEdit, onDelete }) {
  const color = COLORS[task.person];
  return (
    <div style={{...S.card, borderLeft:`4px solid ${color}`, opacity:task.done?0.6:1}}>
      <div style={S.cardLeft}>
        <button style={{...S.check, borderColor:color, background:task.done?color:"transparent"}}
          onClick={()=>onToggle(task.id)}>
          {task.done && <span style={{color:"#fff",fontSize:13,fontWeight:700}}>✓</span>}
        </button>
        <div>
          <div style={{...S.taskName,textDecoration:task.done?"line-through":"none"}}>{task.name}</div>
          <div style={S.meta}>
            <span style={{...S.badge,background:color+"22",color}}>{task.person}</span>
            <span style={S.badge}>⏱ {task.duration} min</span>
            {task.mentalLoad>0 && <span style={S.mlBadge}>🧠 {task.mentalLoad} min</span>}
          </div>
        </div>
      </div>
      <div style={S.cardActions}>
        <button style={S.iconBtn} onClick={()=>onEdit(task)}>✎</button>
        <button style={{...S.iconBtn,color:"#e05"}} onClick={()=>onDelete(task.id)}>✕</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PERSON SUMMARY
// ─────────────────────────────────────────────
function PersonSummary({ person, tasks }) {
  const { daily, weekly, mlDaily, mlWeekly } = calcTime(tasks, person);
  const color = COLORS[person];
  const mine  = tasks.filter(t=>t.person===person);
  const doneD = mine.filter(t=>t.frequency==="daily"  && t.done).length;
  const doneW = mine.filter(t=>t.frequency==="weekly" && t.done).length;
  const totD  = mine.filter(t=>t.frequency==="daily").length;
  const totW  = mine.filter(t=>t.frequency==="weekly").length;
  const pct   = totD ? Math.round(doneD/totD*100) : (totW ? Math.round(doneW/totW*100) : 0);
  return (
    <div style={{...S.summary, borderTop:`3px solid ${color}`}}>
      <div style={{...S.personName,color}}>{person}</div>
      <div>
        <div style={S.statSLbl}>⏱ Opgavetid</div>
        <div style={S.statRow}>
          <div style={S.stat}><span style={S.statNum}>{daily}</span><span style={S.statLbl}>min/dag</span></div>
          <div style={S.stat}><span style={S.statNum}>{weekly}</span><span style={S.statLbl}>min/uge</span></div>
        </div>
      </div>
      <div style={{borderTop:"1px solid #f0ece8",marginTop:8,paddingTop:8}}>
        <div style={{...S.statSLbl,color:ML_COLOR}}>🧠 Mental load</div>
        <div style={S.statRow}>
          <div style={S.stat}><span style={{...S.statNum,color:ML_COLOR}}>{mlDaily}</span><span style={S.statLbl}>min/dag</span></div>
          <div style={S.stat}><span style={{...S.statNum,color:ML_COLOR}}>{mlWeekly}</span><span style={S.statLbl}>min/uge</span></div>
        </div>
      </div>
      <div style={S.progressLabel}>{doneD}/{totD} daglige · {doneW}/{totW} ugentlige</div>
      <div style={S.progressBg}><div style={{...S.progressFill,width:`${pct}%`,background:color}}/></div>
    </div>
  );
}

// ─────────────────────────────────────────────
// STATISTICS
// ─────────────────────────────────────────────
function Statistics({ history }) {
  const periods = [...new Set(history.map(r=>r.period_key))].sort().reverse();
  const [selP, setSelP] = useState("all");

  if (!periods.length) return (
    <div style={{...S.empty,padding:"40px 24px"}}>
      <div style={{fontSize:32,marginBottom:12}}>📊</div>
      <div style={{fontWeight:600,color:"#555",marginBottom:6}}>Ingen historik endnu</div>
      <div style={{fontSize:13}}>Statistik opbygges automatisk, når en dag eller uge slutter.</div>
    </div>
  );

  return (
    <div style={{paddingBottom:32}}>
      <div style={{display:"flex",gap:6,padding:"12px 16px 4px"}}>
        {["all","Mads","Nadia"].map(f=>(
          <button key={f} style={{...S.filterBtn,...(selP===f?S.filterActive:{})}} onClick={()=>setSelP(f)}>
            {f==="all"?"Alle":f}
          </button>
        ))}
      </div>
      {periods.map(pk => {
        const entries = history.filter(r=>r.period_key===pk && (selP==="all"||r.person===selP));
        if (!entries.length) return null;
        const totalWork = entries.reduce((s,e)=>s+e.duration,0);
        const totalML   = entries.reduce((s,e)=>s+(e.mental_load||0),0);
        const doneCount = entries.filter(e=>e.done).length;
        const isWeek    = pk.includes("W");
        return (
          <div key={pk} style={S.histPeriod}>
            <div style={S.histPeriodHead}>
              <span style={S.histPeriodLabel}>{fmtDate(pk)}</span>
              <span style={S.histPeriodBadge}>{isWeek?"Ugentlig":"Daglig"}</span>
            </div>
            <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
              {(selP==="all"?PERSONS:[selP]).map(p=>{
                const pe = entries.filter(e=>e.person===p);
                if (!pe.length) return null;
                return (
                  <div key={p} style={{...S.histPersonChip,borderLeft:`3px solid ${COLORS[p]}`}}>
                    <span style={{fontWeight:700,color:COLORS[p],fontSize:13}}>{p}</span>
                    <span style={S.histStat}>⏱ {pe.reduce((s,e)=>s+e.duration,0)} min</span>
                    <span style={{...S.histStat,color:ML_COLOR}}>🧠 {pe.reduce((s,e)=>s+(e.mental_load||0),0)} min</span>
                    <span style={S.histStat}>{pe.filter(e=>e.done).length}/{pe.length} udført</span>
                  </div>
                );
              })}
            </div>
            {entries.map((e,i)=>(
              <div key={i} style={{...S.histRow,opacity:e.done?1:0.5}}>
                <span style={{...S.histDot,background:COLORS[e.person]||"#ccc"}}/>
                <span style={{flex:1,fontSize:13,textDecoration:e.done?"none":"line-through",color:"#333"}}>{e.name}</span>
                <span style={S.histTag}>⏱ {e.duration}m</span>
                {e.mental_load>0&&<span style={{...S.histTag,color:ML_COLOR,background:"#f0e8ff"}}>🧠 {e.mental_load}m</span>}
                <span style={{...S.histTag,background:e.done?"#e6f9ee":"#fee",color:e.done?"#27ae60":"#c0392b"}}>
                  {e.done?"✓ Udført":"✗ Ikke udført"}
                </span>
              </div>
            ))}
            <div style={S.histFooter}>
              I alt: ⏱ {totalWork} min · 🧠 {totalML} min mental load · {doneCount}/{entries.length} udført
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
export default function App() {
  const [tasks,   setTasks]   = useState([]);
  const [history, setHistory] = useState([]);
  const [modal,   setModal]   = useState(null);
  const [filter,  setFilter]  = useState("all");
  const [tab,     setTab]     = useState("daily");
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [syncAt,  setSyncAt]  = useState(null);
  const pollRef = useRef(null);

  // ── Fetch all data from Supabase ──
  const fetchAll = useCallback(async () => {
    const [taskRows, histRows] = await Promise.all([
      sbGet("tasks", "order=id"),
      sbGet("history", "order=period_key.desc"),
    ]);
    setTasks(taskRows.map(rowToTask));
    setHistory(histRows);
    setSyncAt(Date.now());
  }, []);

  // ── Initial boot ──
  useEffect(()=>{
    (async()=>{
      try {
        // Seed default tasks if table is empty
        const existing = await sbGet("tasks", "select=id");
        if (existing.length === 0) {
          await sbInsert("tasks", DEFAULT_TASKS.map(taskToRow));
          await sbUpdate("meta", { id:1 }, { last_day_key: todayKey(), last_week_key: weekKey() });
        }
        const taskRows = await sbGet("tasks", "order=id");
        await runAutoReset(taskRows.map(rowToTask));
        await fetchAll();
      } catch(e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchAll]);

  // ── Poll every 8 seconds for changes from the other device ──
  useEffect(()=>{
    if (loading) return;
    pollRef.current = setInterval(fetchAll, 8_000);
    return ()=>clearInterval(pollRef.current);
  }, [loading, fetchAll]);

  // ── Actions ──
  async function toggle(id) {
    const task = tasks.find(t=>t.id===id);
    if (!task) return;
    const newDone = !task.done;
    setTasks(ts=>ts.map(t=>t.id===id?{...t,done:newDone}:t)); // optimistic
    await sbUpdate("tasks", { id }, { done: newDone });
  }

  async function saveTask(form) {
    if (form.id) {
      setTasks(ts=>ts.map(t=>t.id===form.id?{...t,...form}:t));
      await sbUpdate("tasks", { id: form.id }, taskToRow({...form}));
    } else {
      const newId = Date.now();
      const newTask = { ...form, id: newId, done: false };
      setTasks(ts=>[...ts, newTask]);
      await sbInsert("tasks", [taskToRow(newTask)]);
    }
    setModal(null);
  }

  async function deleteTask(id) {
    setTasks(ts=>ts.filter(t=>t.id!==id));
    await sbDelete("tasks", { id });
  }

  // ── Render ──
  const visible = filter==="all" ? tasks : tasks.filter(t=>t.person===filter);
  const dk = todayKey();
  const wk = weekKey();
  const [yr,mo,dy] = dk.split("-");
  const todayLabel = `${parseInt(dy)}. ${MONTHS[parseInt(mo)-1]} ${yr}`;
  const weekLabel  = `Uge ${wk.split("-W")[1]}`;
  const syncLabel  = syncAt ? new Date(syncAt).toLocaleTimeString("da-DK",{hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "—";

  if (loading) return (
    <div style={{...S.root,display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
      <div style={{textAlign:"center",color:"#888"}}>
        <div style={{fontSize:36,marginBottom:12}}>🔄</div>
        <div style={{fontWeight:600}}>Forbinder til Supabase…</div>
      </div>
    </div>
  );

  if (error) return (
    <div style={{...S.root,display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
      <div style={{textAlign:"center",color:"#c0392b",maxWidth:340,padding:24}}>
        <div style={{fontSize:36,marginBottom:12}}>⚠️</div>
        <div style={{fontWeight:700,marginBottom:8}}>Kunne ikke forbinde til databasen</div>
        <div style={{fontSize:13,color:"#888"}}>{error}</div>
      </div>
    </div>
  );

  return (
    <div style={S.root}>
      {/* HEADER */}
      <div style={S.header}>
        <div>
          <div style={S.appTitle}>Huskelisten</div>
          <div style={S.appSub}>Praktiske gøremål for Mads &amp; Nadia</div>
        </div>
        <button style={S.btnAdd} onClick={()=>setModal({})}>+ Ny opgave</button>
      </div>

      {/* SYNC BAR */}
      <div style={S.syncBar}>
        <span style={S.syncDot}/>
        <span>Supabase · Opdateret {syncLabel}</span>
        <button style={S.syncBtn} onClick={fetchAll}>↺ Hent nu</button>
      </div>

      {/* PERSON SUMMARIES */}
      <div style={S.summaryRow}>
        {PERSONS.map(p=><PersonSummary key={p} person={p} tasks={tasks}/>)}
      </div>

      {/* TABS */}
      <div style={S.tabBar}>
        <div style={S.tabGroup}>
          {[
            ["daily",  "Daglige",   tasks.filter(t=>t.frequency==="daily").length],
            ["weekly", "Ugentlige", tasks.filter(t=>t.frequency==="weekly").length],
            ["stats",  "Statistik", [...new Set(history.map(r=>r.period_key))].length],
          ].map(([key,label,count])=>(
            <button key={key} style={{...S.tab,...(tab===key?S.tabActive:{})}} onClick={()=>setTab(key)}>
              {label}
              <span style={{...S.tabCount,...(tab===key?S.tabCountActive:{})}}>{count}</span>
            </button>
          ))}
        </div>
        {tab!=="stats" && (
          <div style={S.tabRight}>
            {["all","Mads","Nadia"].map(f=>(
              <button key={f} style={{...S.filterBtn,...(filter===f?S.filterActive:{})}}
                onClick={()=>setFilter(f)}>{f==="all"?"Alle":f}</button>
            ))}
          </div>
        )}
      </div>

      {/* DATE CONTEXT */}
      {tab!=="stats" && (
        <div style={S.dateCtx}>
          {tab==="daily"
            ? <><span>📅</span> I dag: <strong>{todayLabel}</strong><span style={S.resetHint}> — nulstilles automatisk kl. 00:00</span></>
            : <><span>📆</span> Denne uge: <strong>{weekLabel}</strong><span style={S.resetHint}> — nulstilles automatisk mandag kl. 00:00</span></>
          }
        </div>
      )}

      {/* TASK LIST */}
      {tab!=="stats" && (
        <section style={{paddingTop:8}}>
          {visible.filter(t=>t.frequency===tab).length===0
            ? <div style={S.empty}>
                {filter!=="all"
                  ? `Ingen ${tab==="daily"?"daglige":"ugentlige"} opgaver for ${filter}.`
                  : `Ingen ${tab==="daily"?"daglige":"ugentlige"} opgaver endnu. Tilføj en!`}
              </div>
            : visible.filter(t=>t.frequency===tab).map(t=>
                <TaskCard key={t.id} task={t} onToggle={toggle} onEdit={setModal} onDelete={deleteTask}/>
              )
          }
        </section>
      )}

      {/* STATISTICS */}
      {tab==="stats" && <Statistics history={history}/>}

      {/* MODAL */}
      {modal!==null && (
        <Modal task={modal?.id?modal:null} onSave={saveTask} onClose={()=>setModal(null)}/>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────
const S = {
  root:          { fontFamily:"'Georgia',serif", background:"#f5f2ee", minHeight:"100vh", paddingBottom:40 },
  header:        { background:"#1a1a2e", color:"#fff", padding:"24px 20px 20px", display:"flex", alignItems:"center", justifyContent:"space-between" },
  appTitle:      { fontSize:26, fontWeight:700, letterSpacing:-0.5 },
  appSub:        { fontSize:13, color:"#a0a0c0", marginTop:2 },
  btnAdd:        { background:"#f0c040", color:"#1a1a2e", border:"none", borderRadius:8, padding:"10px 16px", fontWeight:700, fontSize:14, cursor:"pointer" },

  syncBar:       { background:"#eef6ff", borderBottom:"1px solid #d0e8ff", padding:"6px 16px", display:"flex", alignItems:"center", gap:8, fontSize:12, color:"#4a7ab5" },
  syncDot:       { width:7, height:7, borderRadius:"50%", background:"#27ae60", flexShrink:0 },
  syncBtn:       { marginLeft:"auto", background:"transparent", border:"1px solid #a0c4e8", borderRadius:6, padding:"2px 10px", fontSize:11, color:"#4a7ab5", cursor:"pointer" },

  summaryRow:    { display:"flex", gap:12, padding:"16px 16px 0" },
  summary:       { flex:1, background:"#fff", borderRadius:10, padding:"14px 16px", boxShadow:"0 1px 4px #0001" },
  personName:    { fontWeight:700, fontSize:16, marginBottom:8 },
  statSLbl:      { fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:0.5, color:"#aaa", marginBottom:4 },
  statRow:       { display:"flex", gap:16, marginBottom:8 },
  stat:          { display:"flex", flexDirection:"column", alignItems:"center" },
  statNum:       { fontSize:22, fontWeight:700, color:"#1a1a2e" },
  statLbl:       { fontSize:10, color:"#888", textTransform:"uppercase", letterSpacing:0.5 },
  progressLabel: { fontSize:11, color:"#888", marginBottom:5, marginTop:6 },
  progressBg:    { height:6, background:"#eee", borderRadius:3, overflow:"hidden" },
  progressFill:  { height:"100%", borderRadius:3, transition:"width .4s" },

  tabBar:        { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 16px 0", gap:8, flexWrap:"wrap" },
  tabGroup:      { display:"flex", background:"#e8e4df", borderRadius:10, padding:3, gap:2 },
  tab:           { border:"none", borderRadius:8, padding:"7px 12px", fontSize:13, fontWeight:600, cursor:"pointer", background:"transparent", color:"#888", display:"flex", alignItems:"center", gap:5, transition:"all .18s" },
  tabActive:     { background:"#1a1a2e", color:"#fff", boxShadow:"0 1px 4px #0002" },
  tabCount:      { fontSize:11, background:"#ccc", color:"#666", borderRadius:10, padding:"1px 6px", fontWeight:700 },
  tabCountActive:{ background:"#f0c040", color:"#1a1a2e" },
  tabRight:      { display:"flex", gap:6, alignItems:"center" },
  filterBtn:     { background:"transparent", border:"1.5px solid #ccc", borderRadius:20, padding:"5px 12px", fontSize:13, cursor:"pointer", color:"#555" },
  filterActive:  { background:"#1a1a2e", color:"#fff", borderColor:"#1a1a2e" },

  dateCtx:       { fontSize:12, color:"#888", padding:"8px 16px 2px", display:"flex", alignItems:"center", gap:5 },
  resetHint:     { color:"#bbb" },

  card:          { background:"#fff", margin:"0 16px 8px", borderRadius:10, padding:"12px 14px", display:"flex", alignItems:"center", justifyContent:"space-between", boxShadow:"0 1px 3px #0001", transition:"opacity .3s" },
  cardLeft:      { display:"flex", alignItems:"center", gap:12, flex:1 },
  taskName:      { fontSize:15, fontWeight:600, color:"#1a1a2e", marginBottom:4 },
  meta:          { display:"flex", gap:6, flexWrap:"wrap" },
  badge:         { fontSize:11, background:"#f0f0f0", color:"#555", borderRadius:20, padding:"2px 8px" },
  mlBadge:       { fontSize:11, background:"#f0e8ff", color:"#9b72cf", borderRadius:20, padding:"2px 8px" },
  check:         { width:26, height:26, borderRadius:"50%", border:"2px solid", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0, transition:"background .2s" },
  cardActions:   { display:"flex", gap:4, marginLeft:8 },
  iconBtn:       { background:"transparent", border:"none", fontSize:16, cursor:"pointer", color:"#999", padding:"4px 6px", borderRadius:6 },
  empty:         { textAlign:"center", color:"#aaa", padding:40, fontSize:15 },

  histPeriod:      { margin:"12px 16px 0", background:"#fff", borderRadius:12, padding:"14px 16px", boxShadow:"0 1px 4px #0001" },
  histPeriodHead:  { display:"flex", alignItems:"center", gap:8, marginBottom:10 },
  histPeriodLabel: { fontWeight:700, fontSize:15, color:"#1a1a2e", flex:1 },
  histPeriodBadge: { fontSize:11, background:"#1a1a2e", color:"#f0c040", borderRadius:6, padding:"2px 8px", fontWeight:700 },
  histPersonChip:  { background:"#fafafa", borderRadius:8, padding:"8px 12px", display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" },
  histStat:        { fontSize:12, color:"#555" },
  histRow:         { display:"flex", alignItems:"center", gap:8, padding:"5px 0", borderTop:"1px solid #f5f2ee" },
  histDot:         { width:8, height:8, borderRadius:"50%", flexShrink:0 },
  histTag:         { fontSize:11, background:"#f0f0f0", color:"#555", borderRadius:20, padding:"2px 7px", whiteSpace:"nowrap" },
  histFooter:      { fontSize:11, color:"#999", borderTop:"1px solid #eee", marginTop:10, paddingTop:8 },

  overlay:       { position:"fixed", inset:0, background:"#0007", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center" },
  modal:         { background:"#fff", borderRadius:14, padding:24, width:"min(92vw,400px)", boxShadow:"0 8px 40px #0003", maxHeight:"90vh", overflowY:"auto" },
  modalTitle:    { fontSize:19, fontWeight:700, color:"#1a1a2e", marginBottom:18 },
  label:         { display:"block", fontSize:12, fontWeight:700, textTransform:"uppercase", letterSpacing:0.5, color:"#888", marginBottom:6, marginTop:14 },
  input:         { width:"100%", border:"1.5px solid #ddd", borderRadius:8, padding:"9px 12px", fontSize:15, boxSizing:"border-box", outline:"none" },
  segRow:        { display:"flex", gap:8 },
  seg:           { flex:1, border:"1.5px solid #ddd", borderRadius:8, padding:"8px", fontSize:14, cursor:"pointer", background:"#fafafa", transition:"all .15s" },
  durBadge:      { minWidth:60, textAlign:"center", fontSize:14, fontWeight:700, color:"#1a1a2e" },
  mlHint:        { fontSize:11, color:"#aaa", marginBottom:8, marginTop:-2 },
  btnPrimary:    { flex:1, background:"#1a1a2e", color:"#fff", border:"none", borderRadius:8, padding:"11px", fontSize:15, fontWeight:700, cursor:"pointer" },
  btnGhost:      { flex:1, background:"transparent", color:"#555", border:"1.5px solid #ddd", borderRadius:8, padding:"11px", fontSize:15, cursor:"pointer" },
};
