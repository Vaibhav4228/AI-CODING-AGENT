import * as vscode from "vscode";
import fs from "node:fs";
import {randomUUID} from "node:crypto";
import type {ContextItem} from "@local-agent/protocol";
import type {WorkspaceContextService} from "./workspace/service";

export interface Change { path:string; content:string }
export class ReviewedFiles {
  private checkpoint?: {id:string;root:string;entries:{file:Change;before?:string;version?:number}[]};
  get undoId(){return this.checkpoint?.entries.length ? this.checkpoint.id : undefined;}
  async undo(id:string){
    const checkpoint=this.checkpoint;
    if(!checkpoint || checkpoint.id!==id) return "This checkpoint has expired.";
    const results:string[]=[];
    while(checkpoint.entries.length){
      const entry=checkpoint.entries[checkpoint.entries.length-1];
      const uri=this.workspace.editTarget(checkpoint.root,entry.file.path);
      const open=vscode.workspace.textDocuments.find(d=>d.uri.toString()===uri.toString());
      const disk=fs.existsSync(uri.fsPath)?fs.readFileSync(uri.fsPath,"utf8"):undefined;
      const changed=open && (open.getText()!==entry.file.content || (entry.version!==undefined && open.version!==entry.version));
      if(changed || (entry.before===undefined ? disk!==entry.file.content || open?.isDirty : disk!==entry.file.content && !(open?.isDirty && disk===entry.before))){
        results.push("Undo stopped: "+entry.file.path+" changed.");break;
      }
      const edit=new vscode.WorkspaceEdit();
      if(entry.before===undefined) edit.deleteFile(uri,{recursive:false});
      else {
        const doc=await vscode.workspace.openTextDocument(uri);
        if(doc.getText()!==entry.file.content){results.push("Undo conflict: "+entry.file.path);break;}
        edit.replace(uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),entry.before);
      }
      if(!await vscode.workspace.applyEdit(edit)){results.push("Undo failed: "+entry.file.path);break;}
      checkpoint.entries.pop();results.push("Undid "+entry.file.path);
    }
    return results.join("\n");
  }
  private readonly previews = new Map<string,string>();
  private readonly scheme = "va-review-"+randomUUID();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(this.scheme,{
    provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? ""
  });
  constructor(private workspace:WorkspaceContextService){}
  dispose(){this.registration.dispose();this.previews.clear();}
  private target(root:string, change:Change, items:ContextItem[]) {
    const uri=this.workspace.editTarget(root,change.path);
    const item=items.find(i=>i.relativePath===change.path && i.kind==="file" && !i.truncated && !i.dirty);
    const existing=fs.existsSync(uri.fsPath);
    const open=vscode.workspace.textDocuments.find(d=>d.uri.toString()===uri.toString());
    if(open?.isDirty || existing!==Boolean(item) || (item && (fs.readFileSync(uri.fsPath,"utf8")!==item.content || (open && open.version!==item.documentVersion)))) throw Error("Conflict: "+change.path+" changed or was not attached as a complete saved file.");
    return {uri,item};
  }
  async review(root:string, files:Change[], items:ContextItem[], decide=(name:string)=>vscode.window.showInformationMessage("Apply reviewed changes to "+name+"?","Apply file","Skip file")) {
    const results:string[]=[];
    const checkpoint:NonNullable<typeof this.checkpoint>={id:randomUUID(),root,entries:[]};
    for(const file of files){
      try {
        const {item}=this.target(root,file,items);
        const snapshot=(side:string,text:string)=>{
          const uri=vscode.Uri.from({scheme:this.scheme,path:"/"+randomUUID()+"/"+side+"/"+file.path});
          this.previews.set(uri.toString(),text);return uri;
        };
        await vscode.commands.executeCommand("vscode.diff",snapshot("before",item?.content??""),snapshot("after",file.content),"Review · "+file.path,{preview:true});
        const decision=await decide(file.path);
        if(!decision){results.push("Stopped before "+file.path);break;}
        if(decision!=="Apply file"){results.push("Skipped "+file.path);continue;}
        const {uri}=this.target(root,file,items);
        const edit=new vscode.WorkspaceEdit();
        if(item){
          const doc=await vscode.workspace.openTextDocument(uri);
          this.target(root,file,items);
          edit.replace(uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),file.content);
        }else edit.createFile(uri,{overwrite:false,contents:Buffer.from(file.content)});
        if(!await vscode.workspace.applyEdit(edit)) throw Error("VS Code rejected edit: "+file.path);
        checkpoint.entries.push({file,before:item?.content,version:vscode.workspace.textDocuments.find(d=>d.uri.toString()===uri.toString())?.version});
        this.checkpoint=checkpoint;
        results.push((item?"Updated editor buffer: ":"Created ")+file.path);
      }catch(error){results.push(error instanceof Error?error.message:"Edit failed");break;}
    }
    return results.join("\n");
  }
}
