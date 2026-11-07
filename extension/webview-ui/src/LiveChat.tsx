import {ProviderPicker} from "./ProviderPicker";
import { useEffect, useRef, useState } from "react";
import { liveStateSchema, type LiveState, type LiveSession, type LiveTurn, type ContextAction, type ContextState } from "@local-agent/protocol";
import "./chat.css";

interface Props {
  viewId?: string;
  context: ContextState | null;
  label: string;
  send: (message: unknown) => void;
  action: (action: ContextAction) => void;
  review: () => void;
}
type Turn = LiveTurn;
export function LiveChat({viewId, context, label, send, action, review}: Props) {
  const [session,setSession]=useState<LiveSession>();
  const [providers,setProviders]=useState<LiveState["providers"]>([]);
  const [keyStatus,setKeyStatus]=useState("");
  const [draft, setDraft] = useState("");
  const [provider, setProvider] = useState("DeepSeek");
  const [mode, setMode] = useState("Ask");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [page,setPage] = useState<"Chat"|"History"|"Settings"|"Usage">("Chat");
  const [history,setHistory] = useState<LiveState["history"]>([]);
  const [patch,setPatch] = useState("");
  const total = turns.reduce((n,t)=>({input:n.input+(t.usage?.input??0),output:n.output+(t.usage?.output??0)}),{input:0,output:0});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [away, setAway] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const items = context?.items ?? [];
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const m = event.data;
      if (!viewId || m?.viewId!==viewId) return;
      const parsed=liveStateSchema.safeParse(m);
      if(parsed.success){
        const state=parsed.data;
        setSession(state.session);setTurns(state.session.turns);setHistory(state.history);setProviders(state.providers);
        pending.current=!!state.session.pending;setBusy(!!state.session.pending);
        const notice=state.notice || (state.session.status==="interrupted"?"Previous run was interrupted. Review your files before retrying; actions were not replayed.":"");
        setStatus(notice);setKeyStatus(state.notice);return;
      }
      if(m.type==="live.error" && typeof m.text==="string") {pending.current=false;setBusy(false);setStatus(m.text);setKeyStatus(m.text);return;}
      if(m.type==="live.progress" && typeof m.text==="string"){setStatus(m.text);}
    };
    window.addEventListener("message", receive);
    if(viewId)send({type:"live.init",viewId});
    return () => window.removeEventListener("message", receive);
  }, [viewId]);
  useEffect(() => {
    if (!away && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [turns, status, away]);
  function submit() {
    const text = draft.trim();
    if (!text || !viewId || !session || pending.current || context?.busy) return;
    const prompt = text;
    if (prompt.length > 4000) { setStatus("Shorten your request to fit the 4,000-character limit."); return; }
    pending.current = true;
    setBusy(true); setAway(false); setStatus("Sending…");
    setDraft("");
    send({type:"live.ask",viewId,sessionId:session.id,revision:session.revision,requestId:crypto.randomUUID(),prompt,provider,mode});
  }
  function reset() {
    if (busy) return;
    send({type:"live.session",viewId,action:"new"});
    setPage("Chat"); setPatch(""); setTurns([]); setDraft(""); setStatus(""); setAway(false); setMode("Ask");
    if (items.length) action({type:"context.clear"});
    input.current?.focus();
  }
  return <section className="va-chat" aria-label="Agent chat">
    <header className="va-top"><b className="va-mark">V</b><strong>Vaibhav AI</strong><button onClick={reset} disabled={busy}>＋ New chat</button></header>
    <div className="va-work"><span>{label}</span><small>{busy ? "Working" : viewId && session ? "Ready" : "Connecting"}</small></div>
    <div className="va-title"><strong>{session?.title || "New conversation"}</strong><button aria-label="History" onClick={()=>setPage("History")}>History</button><button aria-label="Settings" onClick={()=>setPage("Settings")}>Settings</button></div>
    {page !== "Chat" || patch ? <section className="va-detail">
      <button onClick={()=>{setPage("Chat");setPatch("");}}>← Back to chat</button>
      <h2>{patch ? "Proposed patch" : page}</h2>
      {patch ? <pre>{patch}</pre> : page === "Settings" ? <>
        <div>Provider <ProviderPicker disabled={busy} value={provider} onChange={setProvider}/></div>
        <p>Credential source: {providers.find(p=>p.provider===provider)?.source ?? "Loading"}</p>
        <p>Model: {providers.find(p=>p.provider===provider)?.model ?? "Loading"}</p>
        <button disabled={busy} onClick={()=>send({type:"live.key",provider,viewId,action:"model"})}>Change model</button>
        <button disabled={busy} onClick={()=>send({type:"live.key",provider,viewId,action:"remove"})}>Remove key and disable fallback</button>
        <button disabled={busy} onClick={()=>send({type:"live.key",provider,viewId,action:"environment"})}>Use development environment</button>
        <p>Removing a key disables environment fallback. Enabling development environment removes the saved key.</p><button disabled={busy} onClick={()=>send({type:"live.key",provider,viewId,action:"set"})}>Set or replace key</button>
        <p role="status">{keyStatus}</p><p>Keys entered here are saved in VS Code SecretStorage.</p>
      </> : page === "Usage" ? <><p>Provider-reported tokens for this chat</p><dl><dt>Input</dt><dd>{total.input}</dd><dt>Output</dt><dd>{total.output}</dd><dt>Cost</dt><dd>Unavailable</dd></dl></> :
      <><p>Chats saved locally for the selected workspace · latest 20 chats</p>{history.map(item=><div key={item.id} className="va-card">
        <button disabled={busy} onClick={()=>{send({type:"live.session",viewId,action:"open",sessionId:item.id});setPage("Chat");setDraft("");}}>{item.id===session?.id?"Current: ":""}{item.title}</button>
        <button aria-label={"Rename "+item.title} disabled={busy} onClick={()=>send({type:"live.session",viewId,action:"rename",sessionId:item.id})}>Rename</button>
        <button aria-label={"Delete "+item.title} disabled={busy} onClick={()=>send({type:"live.session",viewId,action:"delete",sessionId:item.id})}>Delete</button>
      </div>)}</>}

    </section> : <>
    <div className="va-thread" role="log" ref={log} onScroll={e=>{const el=e.currentTarget;setAway(el.scrollHeight-el.scrollTop-el.clientHeight>45);}}>
      {!turns.length && <div className="va-empty"><b className="va-mark">V</b><h2>What are you working on?</h2><p>Ask a question or attach code from your workspace.</p></div>}
      {turns.map((t,i)=><article key={i} className={"va-turn "+t.role}>{t.role==="assistant" && <b className="va-mark" aria-label="Vaibhav AI">V</b>}<div>{t.mode==="Plan" && <strong className="va-caption">Plan</strong>}{t.text.split(/(```diff[\s\S]*?```)/g).map((part,j)=>t.role==="assistant" && part.startsWith("```diff")?<div className="va-card" key={j}><strong>{t.rejected?"Rejected proposal":"Proposed patch"}</strong>{!t.rejected && <><button onClick={()=>setPatch(part.slice(7,-3).trim())}>Open diff</button><button onClick={()=>setTurns(prev=>prev.map((turn,index)=>index===i?{...turn,rejected:true}:turn))}>Reject</button></>}</div>:<span key={j}>{part}</span>)}{!!t.sources?.length && <details className="va-route"><summary>Context used · {t.sources.length} citations</summary>{t.sources.map((ref,k)=><div key={k}><button onClick={()=>send({type:"live.source",viewId,path:ref.path,line:ref.line})}>{ref.path}:{ref.line}</button><pre>{ref.excerpt}</pre></div>)}</details>}{t.undoId && <button disabled={busy} onClick={()=>send({type:"live.undo",viewId,id:t.undoId})}>Undo changes</button>}{t.provider && <small className="va-caption">Direct provider · {t.provider}</small>}{t.mode==="Plan" && <button disabled={busy} onClick={()=>{setDraft(("Create or update files for this plan:\n"+t.text).slice(0,4000));setMode("Implement");input.current?.focus();}}>Prepare proposal</button>}</div></article>)}
      <small role="status">{status}</small>
    </div>
    {away && <button className="va-jump" onClick={()=>setAway(false)}>↓ Jump to latest</button>}
    <footer className="va-foot">
      {session?.historyOmitted && <small>Older conversation context was omitted to fit the request budget.</small>}
      <div className="va-meter"><span>Session · {total.input} in · {total.output} out</span><button onClick={()=>setPage("Usage")}>Usage</button></div>
      <div className="va-route"><div className="va-meter"><strong>API route</strong><button onClick={()=>setPage("Settings")}>Keys</button></div><div className="va-options"><button disabled>Vaibhav API<small>JEV unavailable</small></button><button aria-pressed="true" onClick={()=>setPage("Settings")}>Your key<small>Direct · {provider}</small></button></div></div>
      <div className="va-modes">{["Ask","Plan","Implement"].map(m=><button key={m} aria-pressed={mode===m} disabled={busy || (m==="Implement" && !context?.trusted)} onClick={()=>setMode(m)}>{m}</button>)}</div>
      {mode==="Implement" && <small>Files will be proposed in {label}. Review and apply each file in the editor.</small>}
      {!!items.length && <div className="va-chips">{items.map(i=><button key={i.id} title={"Remove "+i.relativePath} disabled={busy} onClick={()=>action({type:"context.remove",id:i.id})}>{i.relativePath} · L{i.range.startLine}–{i.range.endLine} ×</button>)}</div>}
      <div className="va-compose"><textarea ref={input} aria-label="Question" placeholder="Ask about your code…" value={draft} maxLength={4000} rows={3} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();submit();}}}/>
      <div className="va-tools"><button aria-label="Attach files" title="Attach files" disabled={!context?.trusted || busy} onClick={()=>action({type:"context.pickFiles"})}>＋</button><ProviderPicker above disabled={busy} value={provider} onChange={setProvider}/><button onClick={review}>Review</button><button aria-label="Run sandbox command" title="Run a build or tests in an isolated container" disabled={!context?.trusted || busy} onClick={()=>send({type:"live.sandbox",viewId})}>Run</button>
      <button className="va-send" aria-label={busy?"Stop":"Send"} disabled={!busy && (!viewId || !session || !draft.trim() || context?.busy)} onClick={()=>busy?send({type:"live.cancel",viewId,sessionId:session?.id,runId:session?.pending?.runId}):submit()}>{busy?"■":"↑"}</button></div></div>
      <small>Sends to {provider} · Enter sends · Shift+Enter for a new line</small>
    </footer></>}
  </section>;
}
