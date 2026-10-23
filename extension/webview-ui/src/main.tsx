import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { draftSchema, Draft, hostMessageSchema, PreviewState, UiIntent } from "@local-agent/protocol";
import "./styles.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();
const restored = draftSchema.safeParse(vscode.getState());
const initialDraft: Draft = restored.success ? restored.data : { draft: "", scenario: "plan" };
const statusLabels = { idle: "Ready to explore", running: "Working through the demo", awaiting_approval: "Waiting for your review", completed: "Demo complete", cancelled: "Demo stopped", failed: "Demo needs attention" };

function Icon({ name }: { name: "code" | "arrow" | "stop" | "check" | "shield" | "reset" }) {
  const paths = { code: "m8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18", arrow: "M12 19V5m-6 6 6-6 6 6", stop: "M7 7h10v10H7z", check: "m5 12 4 4L19 6", shield: "M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6z", reset: "M4 10a8 8 0 1 1 1 8M4 4v6h6" };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function App() {
  const [state, setState] = useState<PreviewState | null>(null);
  const [draft, setDraft] = useState(initialDraft.draft);
  const [scenario, setScenario] = useState<Draft["scenario"]>(initialDraft.scenario);
  const [bridgeError, setBridgeError] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const parsed = hostMessageSchema.safeParse(event.data);
      if (parsed.success) { setState(parsed.data.state); setBridgeError(false); }
    };
    window.addEventListener("message", receive);
    vscode.postMessage({ protocolVersion: 1, requestId: crypto.randomUUID(), type: "ui.ready" });
    const timer = setTimeout(() => setBridgeError(true), 6000);
    return () => { window.removeEventListener("message", receive); clearTimeout(timer); };
  }, []);
  useEffect(() => { vscode.setState({ draft, scenario }); }, [draft, scenario]);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest", behavior: "instant" }); }, [state?.messages.length, state?.phase]);
  // Only local draft and scenario persist in the webview; no credentials/run authority.
  const send = (intent: UiIntent) => vscode.postMessage(intent);
  const busy = state?.phase === "running" || state?.phase === "awaiting_approval";
  const start = (prompt: string, selected = scenario) => {
    if (!state || busy || !prompt.trim()) return;
    send({ protocolVersion: 1, requestId: crypto.randomUUID(), viewId: state.viewId, type: "demo.start", prompt, scenario: selected });
    setDraft("");
    composer.current?.focus();
  };
  const decide = (decision: "approve_once" | "deny") => {
    if (!state?.approval || !state.runId) return;
    send({ protocolVersion: 1, requestId: crypto.randomUUID(), type: "demo.decide", viewId: state.viewId, runId: state.runId, approvalId: state.approval.id, decision });
    composer.current?.focus();
  };
  return <main className="app">
    <header className="topbar"><div className="brand"><span className="brand-icon"><Icon name="code" /></span><strong>Workspace Agent</strong><span className="preview-pill">PREVIEW</span></div><button className="icon-button" aria-label="Reset demo" title="Reset demo" disabled={!state} onClick={() => state && send({ protocolVersion: 1, requestId: crypto.randomUUID(), viewId: state.viewId, type: "demo.reset" })}><Icon name="reset" /></button></header>
    <div className="workspace-bar"><span className="folder-mark" aria-hidden="true">▱</span><span className="workspace-name">{state?.workspaceLabel ?? "Connecting to preview…"}</span><span className="local-pill">LOCAL FIRST</span></div>
    <section className="notice" aria-label="Preview mode"><span className="notice-dot" /><span>Scripted demo · no files read, changed or uploaded</span></section>
    <section className="conversation" aria-label="Conversation">
      {!state?.messages.length && <div className="welcome"><div className="welcome-symbol"><Icon name="code" /></div><div className="eyebrow">BUILT AROUND YOUR WORKSPACE</div><h1>A little less context switching.</h1><p>Understand the code. Review the change.<br />Keep control of what happens next.</p><div className="suggestions"><button onClick={() => start("Show me the local coding workflow", "plan")} disabled={!state}>Explore the workflow <span>↗</span></button><button onClick={() => start("Show a patch approval", "approval")} disabled={!state}>Preview a review step <span>↗</span></button><button onClick={() => start("Show provider failure recovery", "failure")} disabled={!state}>Try a failure state <span>↗</span></button></div><div className="workspace-hint"><Icon name="shield" /><span>Your opened workspace stays local.<br />A connected model would receive selected context only.</span></div></div>}
      {state?.messages.map((message) => <article key={message.id} className={`message ${message.role}`}><div className="message-label">{message.role === "user" ? "YOU" : "WORKSPACE AGENT · DEMO"}</div><div className="message-body">{message.content}</div></article>)}
      {!!state?.activities.length && <section className="activity-panel" aria-label="Tool activity"><div className="section-label">ACTIVITY <span>SIMULATED</span></div>{state.activities.map((item) => <div className="activity" key={item.id}><span className={`activity-status ${item.status}`}>{item.status === "completed" ? <Icon name="check" /> : <span aria-hidden="true">{item.status === "failed" ? "!" : item.status === "cancelled" ? "−" : "·"}</span>}</span><div><strong>{item.title}</strong><p>{item.detail}</p><span className="activity-state">{item.status}</span></div></div>)}</section>}
      {state?.approval && <section className="approval-panel" aria-label="Demo approval"><div className="section-label"><Icon name="shield" /> REVIEW REQUIRED</div><h2>{state.approval.title}</h2><p>{state.approval.description}</p><div className="approval-actions"><button onClick={() => decide("deny")}>Deny demo action</button><button className="primary" onClick={() => decide("approve_once")}>Approve demo once</button></div></section>}
      {state?.alert && <div role="alert" className={`alert ${state.phase === "failed" ? "error" : ""}`}>{state.alert}</div>}
      {bridgeError && !state && <div role="alert" className="alert error">Preview connection unavailable. Reopen the sidebar to try again.</div>}
      <div className="status-line" role="status" aria-live="polite">{state && state.phase !== "idle" ? statusLabels[state.phase] : ""}</div><div ref={end} />
    </section>
    <footer className="composer-area"><div className="composer"><label className="sr-only" htmlFor="task-input">Ask the demo agent</label><textarea ref={composer} id="task-input" placeholder="What would you like to work on?" value={draft} maxLength={4000} rows={3} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); start(draft); } }} /><div className="composer-toolbar"><span className="context-chip" title="Workspace context tools arrive in Step 3">+ Context <span>soon</span></span><div className="composer-tools"><label className="sr-only" htmlFor="scenario">Demo scenario</label><select id="scenario" aria-label="Demo scenario" value={scenario} disabled={busy} onChange={(event) => setScenario(event.target.value as Draft["scenario"])}><option value="plan">Plan demo</option><option value="approval">Approval demo</option><option value="failure">Failure demo</option></select>{busy ? <button className="send-button stop" aria-label="Stop demo" onClick={() => state?.runId && send({ protocolVersion: 1, requestId: crypto.randomUUID(), viewId: state.viewId, type: "demo.cancel", runId: state.runId })}><Icon name="stop" /></button> : <button className="send-button" aria-label="Send demo message" disabled={!state || !draft.trim()} onClick={() => start(draft)}><Icon name="arrow" /></button>}</div></div></div><div className="provider-bar"><span><span className="provider-dot" />DeepSeek R1 <span className="muted">· not connected</span></span><span className="shortcut">Ctrl ↵</span></div><div className="footnote">{state?.trusted ? "Trusted workspace" : "Restricted workspace"}<span>·</span>Mock mode only<span>·</span>No API calls</div></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
