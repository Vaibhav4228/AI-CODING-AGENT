import { useState } from "react";
import { ContextAction, ContextState } from "@local-agent/protocol";

export function ContextPanel({ state, send }: { state: ContextState | null; send: (action: ContextAction) => void }) {
  const [query, setQuery] = useState("");
  const blocked = !state?.trusted || state.busy;
  return <section className="context-panel" aria-label="Workspace context">
    <div className="context-heading"><strong>Workspace context</strong><button onClick={() => send({ type: "context.chooseWorkspace" })} disabled={state?.busy}>Choose folder</button></div>
    <p className="context-subtitle">Read-only · local inspection · no model sharing</p>
    {state?.active ? <div className="active-document"><strong>{state.active.relativePath}</strong><span>{state.active.dirty ? "Unsaved changes" : "Saved"} · v{state.active.documentVersion} · {state.active.diagnosticCount} diagnostics</span><span>Selection L{state.active.range.startLine}:{state.active.range.startCharacter + 1}–L{state.active.range.endLine}:{state.active.range.endCharacter + 1}</span></div> : <p className="context-subtitle">{!state?.trusted ? "Open and trust a local workspace to inspect context." : "Focus an eligible source file in the selected folder."}</p>}
    <div className="context-actions"><button disabled={blocked || !state?.active} onClick={() => send({ type: "context.attach", source: "file" })}>Add current file</button><button disabled={blocked || !state?.active || state.active.selectionEmpty} onClick={() => send({ type: "context.attach", source: "selection" })}>Add selection</button><button disabled={blocked || !state?.active} onClick={() => send({ type: "context.attach", source: "diagnostics" })}>Add diagnostics</button><button disabled={blocked} onClick={() => send({ type: "context.list" })}>Browse files</button><button disabled={!state || state.busy} onClick={() => send({ type: "context.clear" })}>Clear context</button></div>
    <form className="context-search" onSubmit={(event) => { event.preventDefault(); if (query.trim()) send({ type: "context.search", query }); }}><label className="sr-only" htmlFor="context-query">Search workspace text</label><input id="context-query" placeholder="Search workspace text…" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} /><button disabled={blocked || !query.trim()} type="submit">Search</button></form>
    {state?.busy && <p role="status">Reading bounded local context…</p>}
    {state?.notice && <p role="status" className="context-notice">{state.notice}</p>}
    {!!state?.matches.length && <div className="context-results" aria-label="Search results">{state.matches.map((match, index) => <button key={`${match.documentId}-${index}`} onClick={() => send({ type: "context.read", documentId: match.documentId })}><strong>{match.relativePath}:{match.line}</strong><span>{match.snippet}</span></button>)}</div>}
    {!!state?.files.length && !state.matches.length && <div className="context-results" aria-label="Workspace files">{state.files.map((file) => <button key={file.id} onClick={() => send({ type: "context.read", documentId: file.id })}>{file.relativePath}</button>)}</div>}
    {!!state?.items.length && <div className="captured-context" aria-label="Captured context">{state.items.map((item) => <details key={item.id}><summary>{item.kind} · {item.relativePath} · v{item.documentVersion}{item.dirty ? " · unsaved" : ""}</summary><div className="context-subtitle">L{item.range.startLine}–L{item.range.endLine} · source {item.sourceHash.slice(0, 10)}{item.truncated ? " · excerpt truncated" : ""}</div><pre>{item.content}</pre></details>)}</div>}
  </section>;
}
