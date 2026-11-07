import {spawn} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import fs from "node:fs";
import {containsSensitiveText,excludedByDefault} from "./workspace/policy";

const binary = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const host = "npipe:////./pipe/docker_engine";
export const image = "node:24-alpine";
export type Task = "test"|"build";
export type Source = {path:string;content:string};
export function revision(files:Source[]){
  if(!files.length || files.length>32) throw Error("Attach 1–32 complete source files.");
  const names=new Set<string>();
  for(const f of files){
    if(!f.path.split("/").every(p=>/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(p)) || excludedByDefault(f.path) || containsSensitiveText(f.path+"\n"+f.content) || f.content.includes("\0") || names.has(f.path.toLowerCase())) throw Error("Snapshot contains an excluded, duplicate or unsupported file.");
    names.add(f.path.toLowerCase());
  }
  const contents=JSON.stringify(files);
  if(Buffer.byteLength(contents)>512*1024) throw Error("Snapshot exceeds 512 KiB.");
  return createHash("sha256").update(contents).digest("hex");
}

// The bootstrap runs inside the Linux container. Only approved bytes cross stdin.
const bootstrap = `
const fs=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process");
const files=JSON.parse(fs.readFileSync(0,"utf8"));
for(const f of files){fs.mkdirSync(path.dirname(f.path),{recursive:true});fs.writeFileSync(f.path,f.content,{flag:"wx"});}
const task=process.argv[1];
const result=spawnSync("npm",task==="test"?["test"]:["run","build"],{encoding:"utf8",maxBuffer:32768,timeout:24000,killSignal:"SIGKILL"});
const changes=[];
if(result.status===0)for(const f of files){
 const stat=fs.lstatSync(f.path,{throwIfNoEntry:false});
 if(stat?.isFile() && stat.size<=64000){const content=fs.readFileSync(f.path,"utf8");if(content!==f.content)changes.push({path:f.path,content});}
}
process.stdout.write(JSON.stringify({output:(result.stdout||"")+(result.stderr||"")+(result.error?.code||""),changes}));
process.exitCode=result.error?1:(result.status??1);
`;
export function createArgs(name:string,task:Task){
  if(task!=="test" && task!=="build") throw Error("Unsupported sandbox command.");
  return ["create","--pull=never","--name",name,"--interactive","--platform","linux/amd64","--network","none","--read-only","--user","65534:65534","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","256m","--memory-swap","256m","--cpus","1","--pids-limit","64","--ulimit","nofile=256:256","--log-driver","none","--tmpfs","/work:rw,nosuid,nodev,size=32m,mode=1777","--tmpfs","/tmp:rw,nosuid,nodev,size=16m,mode=1777","--workdir","/work","--env","HOME=/tmp","--env","npm_config_offline=true","--entrypoint","node",image,"-e",bootstrap,task];
}
function docker(args:string[],stdin="",signal?:AbortSignal,timeout=10000,limit=16384){
  return new Promise<{code:number;output:string}>((resolve,reject)=>{
    if(signal?.aborted){reject(Error("Cancelled."));return;}
    const child=spawn(binary,["--config","C:/Windows/System32/va-empty-docker-config","--host",host,...args],{windowsHide:true,cwd:"C:\\Windows\\System32",env:{SystemRoot:process.env.SystemRoot,PATH:"C:\\Windows\\System32"},stdio:"pipe"});
    const chunks:Buffer[]=[];let bytes=0,reason="";
    function stop(message:string){reason=message;child.kill();}
    const cancel=()=>stop("Cancelled.");
    const timer=setTimeout(()=>stop("Worker timed out."),timeout);
    signal?.addEventListener("abort",cancel,{once:true});
    const collect=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limit){stop("Worker output limit exceeded.");return;}chunks.push(chunk);};
    child.stdout.on("data",collect);child.stderr.on("data",collect);
    child.stdin.on("error",()=>{});child.stdin.end(stdin);
    child.on("error",reject);
    child.on("close",code=>{clearTimeout(timer);signal?.removeEventListener("abort",cancel);if(reason)reject(Error(reason));else resolve({code:code??1,output:Buffer.concat(chunks).toString("utf8")});});
  });
}
export async function checkWorker(){
  if(process.platform!=="win32" || !fs.existsSync(binary)) throw Error("Sandbox unavailable. Start Docker Desktop with Linux containers and pull "+image+".");
  const version=await docker(["info","--format","{{.OSType}}"]);
  if(version.code || version.output.trim()!=="linux") throw Error("Local Linux Docker engine unavailable.");
  if((await docker(["image","inspect",image,"--format","{{.Id}}"])).code) throw Error("Missing worker image. Run docker pull "+image+".");
}
export async function runSandbox(task:Task,files:Source[],signal:AbortSignal){
  const hash=revision(files),name="va-worker-"+randomUUID();
  await checkWorker();signal.throwIfAborted();
  async function removeWorker(){ 
    const removal=await docker(["rm","-f","-v",name]);
    if(removal.code)throw Error("Worker cleanup failed. Inspect local container "+name+".");
  }
  const created=await docker(createArgs(name,task));
  if(created.code)throw Error("Container creation failed: "+created.output.slice(-1000));
  try{
    const result=await docker(["start","-a","-i",name],JSON.stringify(files),signal,30000,256*1024);
    let payload;
    try{payload=JSON.parse(result.output);}catch{throw Error("Worker failed without a valid receipt (exit "+result.code+").");}
    if(typeof payload.output!=="string" || !Array.isArray(payload.changes))throw Error("Invalid worker output.");
    const changes:Source[]=[];
    for(const change of payload.changes){
      if(!files.some(f=>f.path===change?.path) || typeof change.content!=="string" || changes.some(c=>c.path===change.path))throw Error("Unexpected worker file.");
      changes.push({path:change.path,content:change.content});
    }
    if(changes.length)revision(changes);
    return {hash,code:result.code,output:payload.output.slice(0,65536),changes};
  }finally{
    await removeWorker();
  }
}
