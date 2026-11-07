import * as vscode from "vscode";
import {randomUUID} from "node:crypto";
import type {WorkspaceContextService} from "./workspace/service";
import {SidebarApprovals} from "./approvals";
import {ReviewedFiles} from "./edits";
import {checkWorker,revision,runSandbox} from "./sandbox";

export function registerSandbox(context:vscode.ExtensionContext,workspace:WorkspaceContextService){
  const log=vscode.window.createOutputChannel("Vaibhav AI · Sandbox");
  const edits=new ReviewedFiles(workspace);
  let active:AbortController|undefined;
  const snapshot=()=>{
    const state=workspace.snapshot();
    if(state.busy || state.items.some(i=>i.kind!=="file" || i.truncated))throw Error("Attach complete files in Workspace context before running.");
    const files=state.items.map(i=>({path:i.relativePath,content:i.content}));
    return {items:state.items,files,hash:revision(files)};
  };
  const scope=()=>{const s=workspace.approvalScope();return {root:s.root,revision:snapshot().hash};};
  const approvals=new SidebarApprovals(context.globalStorageUri.fsPath,scope);
  const command=vscode.commands.registerCommand("localAgent.sandbox",async()=>{
    if(active)return;
    const controller=new AbortController();active=controller;
    const started=Date.now(),id=randomUUID();
    try{
      const root=workspace.approvalScope().root;
      await checkWorker();
      const task=await vscode.window.showQuickPick(["npm test","npm run build"],{title:"Run in isolated Linux container"});
      if(!task)return;
      const snap=snapshot();
      if(!snap.files.some(f=>f.path==="package.json"))throw Error("Attach package.json and the source/test files required by its script.");
      const approval=approvals.request(id,task.split(" ").slice(1));
      const pick=await vscode.window.showWarningMessage("Run "+task+" in the sandbox?",{modal:true,detail:snap.items.map(i=>i.relativePath+(i.dirty?" (unsaved buffer)":"")).join("\n")+"\nSnapshot "+snap.hash+"\nNetwork disabled · 30s limit"},"Run once");
      if(root!==workspace.approvalScope().root || snapshot().hash!==snap.hash)throw Error("Workspace or snapshot changed; review again.");
      approvals.decide(approval,pick?"approve_once":"deny");if(!pick)return;
      log.show(true);log.appendLine(id+" · "+task+" · "+snap.hash);
      const receipt=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:"Sandbox · "+task,cancellable:true},async(_,token)=>{
        const subscription=token.onCancellationRequested(()=>controller.abort());
        try{return await runSandbox(task==="npm test"?"test":"build",snap.files,controller.signal);}finally{subscription.dispose();}
      });
      log.appendLine("Exit "+receipt.code+" · "+(Date.now()-started)+" ms\n"+receipt.output);
      if(!receipt.code && receipt.changes.length){
        log.appendLine(await edits.review(root,receipt.changes,snap.items));
      }
    }catch(error){
      const message=error instanceof Error?error.message:"Sandbox failed.";
      log.appendLine(id+" · "+message);void vscode.window.showWarningMessage(message);
    }finally{active=undefined;}
  });
  context.subscriptions.push(command,log,edits,approvals,{dispose:()=>active?.abort()});
}
