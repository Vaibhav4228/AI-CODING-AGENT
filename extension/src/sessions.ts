import { randomUUID } from "node:crypto";
import { liveTurnSchema, liveSessionSchema, type LiveSession, type LiveTurn } from "@local-agent/protocol";
import { conversation } from "./deepseek";
import { containsSensitiveText } from "./workspace/policy";

export interface StateStorage { get<T>(key:string):T|undefined; update(key:string,value:unknown):PromiseLike<void> }
type RecordState = {version:1;current:string;sessions:LiveSession[]};
const fresh=():LiveSession=>({id:randomUUID(),title:"New conversation",revision:0,updated:Date.now(),turns:[],pending:null,status:"idle"});
export class ChatSessions {
  private records=new Map<string,RecordState>();
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private storage:StateStorage) {}
  private async record(scope:string) {
    if(this.records.has(scope)) return this.records.get(scope)!;
    const raw=this.storage.get<RecordState>("live.chats."+scope);
    const sessions:LiveSession[]=[];
    if(raw?.version===1 && Array.isArray(raw.sessions)) for(const item of raw.sessions.slice(0,20)) {
      const parsed=liveSessionSchema.safeParse(item);
      if(!parsed.success) continue;
      const session=parsed.data;
      session.turns=session.turns.map(t=>({...t,undoId:undefined}));
      if(session.pending){session.pending=null;session.status="interrupted";session.revision++;}
      sessions.push(session);
    }
    if(!sessions.length) sessions.push(fresh());
    const record:RecordState={version:1,current:sessions.some(s=>s.id===raw?.current)?raw!.current:sessions[0].id,sessions};
    await this.save(scope,record);
    this.records.set(scope,record);
    return record;
  }
  private async save(scope:string,record:RecordState) {
    // Bound transcript storage; retain complete recent pairs where possible.
    for(const session of record.sessions){
      while(session.turns.length>100 || Buffer.byteLength(JSON.stringify(session.turns))>100000){
        session.turns.shift();
        if(session.turns[0]?.role==="assistant") session.turns.shift();
      }
    }
    await this.storage.update("live.chats."+scope,record);
  }
  private serial<T>(fn:()=>Promise<T>):Promise<T> {
    const result=this.queue.then(fn); this.queue=result.catch(()=>undefined); return result;
  }
  snapshot(scope:string){return this.serial(async()=>structuredClone(await this.record(scope)));}
  change<T>(scope:string,fn:(record:RecordState)=>T){return this.serial(async()=>{
    const next=structuredClone(await this.record(scope));const result=fn(next);
    await this.save(scope,next);this.records.set(scope,next);return result;
  });}
  select(scope:string,action:"new"|"open"|"rename"|"delete",id?:string,title?:string){return this.change(scope,record=>{
    if(record.sessions.some(s=>s.pending)) throw Error("Stop the current request before changing chats.");
    const target=record.sessions.find(s=>s.id===id);
    if(action!=="new" && !target) throw Error("Chat is no longer available.");
    if(action==="new") {const session=fresh();record.sessions.unshift(session);record.sessions=record.sessions.slice(0,20);record.current=session.id;}
    if(action==="open") {record.current=target!.id;target!.updated=Date.now();record.sessions=[target!,...record.sessions.filter(s=>s.id!==target!.id)];}
    if(action==="rename") {if(!title?.trim() || containsSensitiveText(title)) throw Error("Use a chat title without credentials.");target!.title=title.trim().slice(0,120);}
    if(action==="delete") {record.sessions=record.sessions.filter(s=>s.id!==id);if(!record.sessions.length)record.sessions.push(fresh());if(record.current===id)record.current=record.sessions[0].id;}
  });}
  begin(scope:string,id:string,revision:number,requestId:string,turn:Omit<LiveTurn,"id">){return this.change(scope,record=>{
    const session=record.sessions.find(s=>s.id===id);
    if(record.current!==id || !session || session.revision!==revision || record.sessions.some(s=>s.pending)) throw Error("This request is stale or a run is already active. Retry after the chat refreshes.");
    if(containsSensitiveText(turn.text)) throw Error("Remove credentials from your question.");
    const history=session.turns.map(t=>({role:t.role,content:t.text}));
    const bounded=conversation(history);session.historyOmitted=bounded.length<history.length;
    const runId=randomUUID();
    session.turns.push({...turn,id:requestId});session.pending={requestId,runId};session.status="running";
    if(session.title==="New conversation")session.title=turn.text.slice(0,120);
    session.revision++;session.updated=Date.now();
    return {runId,history:bounded};
  });}
  finish(scope:string,id:string,runId:string,turn:Omit<LiveTurn,"id">,status:LiveSession["status"]){return this.change(scope,record=>{
    const session=record.sessions.find(s=>s.id===id);
    if(session?.pending?.runId!==runId) return;
    const safe=containsSensitiveText(JSON.stringify(turn))?{role:"assistant" as const,text:"Response omitted because it may contain credentials."}:turn;
    session.turns.push(liveTurnSchema.parse({...safe,text:safe.text.slice(0,64000),id:randomUUID(),runId}));session.pending=null;session.status=status;session.revision++;session.updated=Date.now();
  });}
}
