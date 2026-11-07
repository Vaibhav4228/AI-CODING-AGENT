import { LiveChat } from "./LiveChat";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ContextPanel } from "./ContextPanel";
import { ContextAction, ContextState, contextHostMessageSchema, hostMessageSchema, PreviewState } from "@local-agent/protocol";
import "./styles.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();
function App() {
  const [state, setState] = useState<PreviewState | null>(null);
  const [context, setContext] = useState<ContextState | null>(null);
  const viewId = useRef<string | null>(null);
  const [section, setSection] = useState<"chat" | "context">("chat");
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const contextMessage = contextHostMessageSchema.safeParse(event.data);
      if (contextMessage.success) {
        if (contextMessage.data.viewId === viewId.current) setContext(contextMessage.data.state);
        return;
      }
      const parsed = hostMessageSchema.safeParse(event.data);
      if (parsed.success) { viewId.current = parsed.data.state.viewId; setState(parsed.data.state); }
    };
    window.addEventListener("message", receive);
    vscode.postMessage({ protocolVersion: 1, requestId: crypto.randomUUID(), type: "ui.ready" });

    return () => { window.removeEventListener("message", receive); };
  }, []);
  const contextAction = (action: ContextAction) => {
    if (state) vscode.postMessage({ protocolVersion: 1, requestId: crypto.randomUUID(), viewId: state.viewId, action });
  };
  return <main className="app">
    <div className="va-page" hidden={section !== "chat"}><LiveChat viewId={state?.viewId} context={context} label={context?.workspaceLabel ?? state?.workspaceLabel ?? "Workspace"} send={m=>vscode.postMessage(m)} action={contextAction} review={()=>setSection("context")}/></div>
    {section === "context" && <div className="context-view">
      <button onClick={()=>setSection("chat")}>← Back to chat</button>
      <ContextPanel state={context} send={(action) => {
        if (state) vscode.postMessage({ protocolVersion: 1, requestId: crypto.randomUUID(), viewId: state.viewId, action });
      }} />
    </div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
