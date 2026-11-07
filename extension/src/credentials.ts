import type { LiveProvider } from "@local-agent/protocol";
import type { StateStorage } from "./sessions";
import { MODEL } from "./deepseek";
interface Secrets {get(key:string):PromiseLike<string|undefined>;store(key:string,value:string):PromiseLike<void>;delete(key:string):PromiseLike<void>}
export class Credentials {
  constructor(private secrets:Secrets,private prefs:StateStorage,private environment:()=>Promise<Record<string,string|undefined>>) {}
  async resolve(provider:LiveProvider) {
    const env=await this.environment();
    const prefix=provider==="DeepSeek"?"DEEPSEEK":"OPENROUTER";
    const model=this.prefs.get<string>(provider+".model") || env[prefix+"_MODEL"] || (provider==="DeepSeek"?MODEL:"openrouter/free");
    const saved=await this.secrets.get(provider.toLowerCase()+".key");
    const disabled=this.prefs.get<boolean>(provider+".disabled")===true;
    const key=disabled?undefined:saved || env[prefix+"_API_KEY"]?.trim();
    const source=disabled?"disabled":saved?"saved":key?"environment":"missing";
    return {provider,model,key,source:source as "disabled"|"saved"|"environment"|"missing"};
  }
  async status(){return Promise.all((["DeepSeek","OpenRouter"] as const).map(async p=>{const {provider,model,source}=await this.resolve(p);return {provider,model,source};}));}
  async save(provider:LiveProvider,key:string){
    if(!key.trim() || key.trim().length>4096 || /[\r\n]/.test(key))throw Error("Invalid API key.");
    await this.secrets.store(provider.toLowerCase()+".key",key.trim());await this.prefs.update(provider+".disabled",false);
  }
  async remove(provider:LiveProvider){
    await this.prefs.update(provider+".disabled",true);await this.secrets.delete(provider.toLowerCase()+".key");
  }
  async useEnvironment(provider:LiveProvider){await this.secrets.delete(provider.toLowerCase()+".key");await this.prefs.update(provider+".disabled",false);}
  async model(provider:LiveProvider,model:string){if(!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model))throw Error("Enter a valid provider model ID.");await this.prefs.update(provider+".model",model);}
}
