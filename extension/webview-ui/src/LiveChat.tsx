import {useEffect, useState} from "react";
import type {ContextState} from "@local-agent/protocol";

export function LiveChat({viewId,context,send,attach}:{viewId?:string;context:ContextState|null;send:(message:unknown)=>void;attach:()=>void}) {
  const [prompt,setPrompt] = useState("");
  const [provider,setProvider] = useState("DeepSeek");
  const [text,setText] = useState("");
  const [busy,setBusy] = useState(false);
  useEffect(() => {
    const receive = (event:MessageEvent) => {
      const m = event.data;
      if (viewId && m?.viewId === viewId && m.type === "live.result" && typeof m.text === "string") {setBusy(m.busy === true);setText(m.text);}
    };
    window.addEventListener("message",receive);
    return () => window.removeEventListener("message",receive);
  },[viewId]);
  const submit = () => {
    if (!viewId || !prompt.trim() || busy) return;
    setBusy(true); send({type:"live.ask",viewId,prompt,provider});
  };
  return <section className="conversation" aria-label="Agent chat">
    <h2>Chat</h2><label>Provider <select value={provider} disabled={busy} onChange={e=>setProvider(e.target.value)}><option>DeepSeek</option><option>OpenRouter</option></select></label>
    <button disabled={!context?.trusted || busy} onClick={attach}>+ Attach files</button>
    <ul>{context?.items.map(i=><li key={i.id}>{i.relativePath}</li>)}</ul>
    <label htmlFor="live-question">Question</label><textarea id="live-question" value={prompt} maxLength={4000} disabled={busy} onKeyDown={e=>{if(e.key==="Enter" && !e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();submit();}}} onChange={e=>setPrompt(e.target.value)}/>
    <button disabled={!busy && (!viewId || !prompt.trim() || context?.busy)} onClick={()=>busy ? send({type:"live.cancel",viewId}) : submit()}>{busy?"Cancel request":"Send"}</button>
    <div className="message-body" role="status">{text}</div>
  </section>;
}
