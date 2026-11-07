import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { liveIntentSchema, type LiveSession } from "@local-agent/protocol";
import { ReviewedFiles } from "./edits";
import { conversation, generateFiles, prepareQuestion } from "./deepseek";
import { investigate } from "./read-loop";
import { ChatSessions } from "./sessions";
import { Credentials } from "./credentials";
import type { WorkspaceContextService } from "./workspace/service";

export function liveChat(context:vscode.ExtensionContext,workspace:WorkspaceContextService,getView:()=>vscode.WebviewView|undefined,viewId:()=>string) {
  const edits=new ReviewedFiles(workspace);
  const sessions=new ChatSessions(context.workspaceState);
  const credentials=new Credentials(context.secrets,context.globalState,async()=>context.extensionMode===vscode.ExtensionMode.Development
    ?parseEnv(await readFile(path.resolve(context.extensionPath,"../.env"),"utf8").catch(()=>"")):{});
  const scopeId=()=>createHash("sha256").update(workspace.sessionScope()).digest("hex");
  let active:{abort:AbortController;scope:string;sessionId:string;runId?:string}|undefined;
  let settingsBusy=false;
  let lastScope=scopeId();
  let published:Promise<unknown>=Promise.resolve();
  const send=(value:object)=>getView()?.webview.postMessage({...value,viewId:viewId()});
  function publish(notice="") {
    const operation=published.then(async()=>{
      const scope=scopeId();const state=await sessions.snapshot(scope);
      const providers=await credentials.status();
      if(scope!==scopeId())return;
      await send({type:"live.state",scopeId:scope,session:state.sessions.find(s=>s.id===state.current),history:state.sessions.map(s=>({id:s.id,title:s.title,updated:s.updated})),providers,notice});
    });
    published=operation.catch(()=>undefined);return operation;
  }
  const failed=()=>{void send({type:"live.error",text:"Unable to update chat or settings. Retry after checking the current run. No action will be replayed automatically."});};
  async function run(intent:Extract<ReturnType<typeof liveIntentSchema.parse>,{type:"live.ask"}>) {
    if(active || settingsBusy){await publish("Wait for the current operation to finish.");return;}
    const current={abort:new AbortController(),scope:scopeId(),sessionId:intent.sessionId,runId:undefined as string|undefined};
    active=current;
    const {provider,mode}=intent;
    const implement=mode==="Implement";
    const prompt=mode==="Plan"?"Give a concise implementation plan for this request:\n"+intent.prompt:intent.prompt;
    let usage:{input:number;output:number}|undefined;
    let sources:{path:string;line:number;excerpt:string}[]=[];
    let undoId:string|undefined;
    let notice="";
    async function post(text:string,busy=false,status:LiveSession["status"]="completed") {
      if(busy){if(current.scope===scopeId())await send({type:"live.progress",sessionId:current.sessionId,runId:current.runId,text});return;}
      if(current.runId)await sessions.finish(current.scope,current.sessionId,current.runId,{role:"assistant",text,usage,sources,undoId,mode,provider},status);
    }
    try {
      // Validate before recording or making a provider request.
      prepareQuestion(prompt,[]);
      const started=await sessions.begin(current.scope,intent.sessionId,intent.revision,intent.requestId,{role:"user",text:intent.prompt});
      current.runId=started.runId;
      const history=conversation(started.history);
      await publish();
      if(current.abort.signal.aborted || current.scope!==scopeId())throw Error("Workspace changed or request cancelled.");
      await post("Preparing request…",true);
      const items = workspace.snapshot().items;
      const scope = items.length || implement ? workspace.approvalScope() : undefined;
      const question = prepareQuestion(prompt, items);
      const config=await credentials.resolve(provider);
      let key=config.key;const model=config.model;
      if (!key) {
        const entered=await vscode.window.showInputBox({password:true,ignoreFocusOut:true,prompt:provider+" API key (saved in VS Code SecretStorage)"});
        if(!entered?.trim() || current.abort.signal.aborted)throw Error("API key required or request cancelled.");
        await credentials.save(provider,entered); key=entered.trim();
      }
      if (scope && items.length) {
        const ok = await vscode.window.showInformationMessage("Send this question and selected excerpts to " + provider + "?", {modal:true, detail:model + "\n" + prompt + "\n\n" + question.sources.map(s => s.path + " from line " + s.startLine).join("\n") + "\nMaximum output: "+(implement?"4,096":"2,048")+" tokens."}, "Send once");
        if (!ok || current.abort.signal.aborted) throw Error("Cancelled.");
        const now = workspace.approvalScope();
        if (now.root !== scope.root || now.revision !== scope.revision || JSON.stringify(workspace.snapshot().items) !== JSON.stringify(items)) throw Error("Context changed. Review your attachments and retry.");
      }
      if (current.abort.signal.aborted) throw Error("Cancelled.");
      await post("Waiting for " + provider + "…", true);
      if(implement && scope){
        const proposal=await generateFiles(key.trim(),provider,model,question.content,AbortSignal.any([current.abort.signal,AbortSignal.timeout(90000)]), history);
        if(current.abort.signal.aborted) throw Error("Cancelled.");
        if(Number.isSafeInteger(proposal.usage?.prompt_tokens) && Number.isSafeInteger(proposal.usage?.completion_tokens)) usage={input:proposal.usage.prompt_tokens,output:proposal.usage.completion_tokens};
        await post("Review proposed files in the editor…",true);
        const previousCheckpoint=edits.undoId;
        const summary=await edits.review(scope.root,proposal.files,items, async name=>{
          if(current.abort.signal.aborted)return undefined;
          const choice=await vscode.window.showInformationMessage("Apply reviewed changes to "+path.join(scope.root,name)+"?","Apply file","Skip file");
          return current.abort.signal.aborted?undefined:choice;
        });
        if(edits.undoId!==previousCheckpoint) undoId=edits.undoId;
        await post(summary);
        return;
      }
      let readScope:ReturnType<WorkspaceContextService["approvalScope"]>|undefined;
      const answer=await investigate({key:key.trim(),provider,model,question:question.content,history,signal:current.abort.signal,
        evidence:question.sources.flatMap(source=>source.text.split("\n").map((excerpt,index)=>({path:source.path,line:source.startLine+index,excerpt}))),
        usage:(input,output)=>{usage={input,output};},
        progress:async text=>{await post(text,true);},
        authorize:async()=>{
          const requested=workspace.approvalScope();
          const approved=await vscode.window.showInformationMessage("Allow workspace investigation for this request?",{modal:true,detail:
            provider+" � "+model+"\nFolder: "+requested.root+"\n\nThe model can list, search and read eligible files and editor diagnostics, including unsaved edits. Returned excerpts are sent to this provider. Ignore rules and secret filters apply. No files or commands can be changed by these tools.\n\nLimits: 8 model rounds, 20 tool calls, 32,000 input and 4,096 output tokens; 120 seconds excluding approval waits. Provider cost is not estimated."},"Allow this request");
          if(approved!=="Allow this request" || current.abort.signal.aborted)throw Error("Workspace sharing declined or cancelled.");
          const now=workspace.approvalScope();
          if(now.root!==requested.root || now.revision!==requested.revision)throw Error("Workspace changed during approval. Retry.");
          readScope=requested;
        },
        validate:()=>{
          if(current.scope!==scopeId())throw Error("Workspace changed.");
          const expected=readScope ?? scope;
          if(expected){const now=workspace.approvalScope();if(now.root!==expected.root || now.revision!==expected.revision)throw Error("Workspace context changed. Retry to use current evidence.");}
        },
        execute:async(action,signal)=>{
          if(!readScope || current.scope!==scopeId())throw Error("No current workspace permission.");
          return workspace.investigate(action,readScope.root,signal);
        },
      });
      sources=answer.sources;
      await post(current.abort.signal.aborted ? "Cancelled." : answer.text,false,current.abort.signal.aborted?"cancelled":"completed");
    } catch(error) {
      if(current.runId)await post(current.abort.signal.aborted?"Cancelled.":error instanceof Error?error.message:"Provider request failed.",false,current.abort.signal.aborted?"cancelled":"failed");
      else notice=error instanceof Error?error.message:"Request rejected.";
    } finally {
      active=undefined;
      await publish(notice);
    }
  }
  async function changeSession(intent:Extract<ReturnType<typeof liveIntentSchema.parse>,{type:"live.session"}>) {
    if(active || settingsBusy){await publish("Stop the current operation before changing chats.");return;}
    settingsBusy=true;
    const scope=scopeId();
    try {
      let title:string|undefined;
      if(intent.action==="rename") {title=await vscode.window.showInputBox({prompt:"Chat title",ignoreFocusOut:true});if(!title)return;}
      if(intent.action==="delete" && await vscode.window.showWarningMessage("Delete this saved chat?",{modal:true},"Delete")!=="Delete")return;
      if(scope!==scopeId())throw Error("Workspace changed. Retry.");
      await sessions.select(scope,intent.action,intent.sessionId,title);
      await workspace.execute({type:"context.clear"});
      await publish();
    } finally {settingsBusy=false;}
  }
  async function changeKey(intent:Extract<ReturnType<typeof liveIntentSchema.parse>,{type:"live.key"}>) {
    if(active || settingsBusy){await publish("Wait for the current operation before changing credentials.");return;}
    settingsBusy=true;
    try {
      const {provider,action}=intent;
      let notice="";
      if(action==="set") {
        const key=await vscode.window.showInputBox({password:true,ignoreFocusOut:true,prompt:"Set or replace "+provider+" API key"});
        if(!key)return;
        await credentials.save(provider,key);notice=provider+" key saved. Future requests use this key.";
      } else if(action==="remove") {
        await credentials.remove(provider);notice="Saved key removed. Environment fallback disabled until you enable it explicitly.";
      } else if(action==="environment") {
        await credentials.useEnvironment(provider);notice="Saved key removed; development environment fallback enabled.";
      } else {
        const config=await credentials.resolve(provider);
        const model=await vscode.window.showInputBox({prompt:provider+" model ID",value:config.model,ignoreFocusOut:true});
        if(!model)return;await credentials.model(provider,model);notice="Model updated. Availability is checked on your next request.";
      }
      await publish(notice);
    } finally {settingsBusy=false;}
  }
  return {
    dispose(){active?.abort.abort();edits.dispose();},
    refresh(){if(lastScope!==scopeId()){lastScope=scopeId();active?.abort.abort();void publish().catch(failed);}},
    receive(raw:unknown) {
      const parsed=liveIntentSchema.safeParse(raw);
      if(!parsed.success || parsed.data.viewId!==viewId())return false;
      const intent=parsed.data;
      if(intent.type==="live.init"){void publish().catch(failed);return true;}
      if(intent.type==="live.ask"){void run(intent).catch(failed);return true;}
      if(intent.type==="live.session"){void changeSession(intent).catch(failed);return true;}
      if(intent.type==="live.key"){void changeKey(intent).catch(failed);return true;}
      if(intent.type==="live.cancel"){
        if(active?.sessionId===intent.sessionId && active.runId===intent.runId)active.abort.abort();
        return true;
      }
      if(intent.type==="live.source"){void workspace.openCitation(intent.path,intent.line).catch(()=>vscode.window.showWarningMessage("Source unavailable; attach current context again."));return true;}
      if(intent.type==="live.sandbox"){if(!active && !settingsBusy)void vscode.commands.executeCommand("localAgent.sandbox");return true;}
      if(intent.type==="live.undo" && !active && !settingsBusy && intent.id===edits.undoId){
        settingsBusy=true;
        void (async()=>{
          try {
            if(await vscode.window.showWarningMessage("Undo the latest reviewed file changes?",{modal:true},"Undo changes")!=="Undo changes")return;
            const summary=await edits.undo(intent.id);
            await sessions.change(scopeId(),state=>{for(const session of state.sessions)for(const turn of session.turns)if(turn.undoId===intent.id){turn.undoId=edits.undoId;turn.text=(turn.text+"\n"+summary).slice(0,64000);}});
            await publish(summary);
          } finally {settingsBusy=false;}
        })().catch(failed);
      }
      return true;
    },
  };
}
