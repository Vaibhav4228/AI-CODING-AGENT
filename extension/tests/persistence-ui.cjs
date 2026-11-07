const {_electron}=require("playwright");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
(async()=>{
  const ext=path.resolve(__dirname,"..");
  const work=fs.mkdtempSync(path.join(ext,".test-work","persistence-"));
  const root=path.join(work,"workspace");fs.mkdirSync(root);
  const executablePath=process.env.VSCODE_EXECUTABLE_PATH || path.join(ext,".vscode-test/vscode-win32-x64-archive-1.144.0/Code.exe");
  const profile=path.join(work,"profile");fs.mkdirSync(path.join(profile,"User"),{recursive:true});
  fs.writeFileSync(path.join(profile,"User","settings.json"),JSON.stringify({"telemetry.telemetryLevel":"off","update.mode":"none","workbench.startupEditor":"none"}));
  async function open(){
    const app=await _electron.launch({executablePath,args:["--user-data-dir="+profile,"--extensions-dir="+path.join(work,"extensions"),"--extensionDevelopmentPath="+ext,"--disable-workspace-trust","--skip-welcome","--disable-updates",root]});
    try {
      const page=await app.firstWindow();await page.locator(".monaco-workbench").waitFor();
      const activity=page.locator('.activitybar [aria-label^="Workspace Agent"]').first();
      await activity.click();
      if(!await page.locator('.part.sidebar').isVisible())await activity.click();
      let side;
      for(let i=0;i<100&&!side;i++){
        for(const frame of page.frames())if(await frame.getByRole("button",{name:"History",exact:true}).count().catch(()=>0)){side=frame;break;}
        if(!side)await new Promise(resolve=>setTimeout(resolve,200));
      }
      assert.ok(side,"Agent webview mounted");await side.getByText("Ready",{exact:true}).waitFor();
      return {app,page,side};
    }catch(error){const page=await app.firstWindow();await page.screenshot({path:path.join(work,"failure.png")});console.log("FAILURE_ARTIFACT",path.join(work,"failure.png"));console.log((await page.locator("body").innerText()).slice(-5000));await app.close();throw error;}
  }
  async function nativeInput(page,text){const box=page.locator(".quick-input-widget input").first();await box.waitFor({state:"visible"});await box.fill(text);await page.keyboard.press("Enter");}
  let host=await open();
  try {
    await host.side.getByRole("button",{name:"History",exact:true}).click();
    await host.side.getByRole("button",{name:"Rename New conversation",exact:true}).click();
    await nativeInput(host.page,"Persistent fixture chat");
    await host.side.getByRole("button",{name:"Current: Persistent fixture chat",exact:true}).waitFor();
    await host.side.getByRole("button",{name:"Settings",exact:true}).click();
    await host.side.getByRole("button",{name:"Set or replace key",exact:true}).click();
    await nativeInput(host.page,"fixture-only-no-provider-request");
    await host.side.getByText("Credential source: saved",{exact:true}).waitFor();
    await host.side.getByRole("button",{name:"Change model",exact:true}).click();
    await nativeInput(host.page,"fixture-model");
    await host.side.getByText("Model: fixture-model",{exact:true}).waitFor();
  } finally {await host.app.close();}
  host=await open();
  try {
    await host.side.getByRole("button",{name:"History",exact:true}).click();
    await host.side.getByRole("button",{name:"Current: Persistent fixture chat",exact:true}).waitFor();
    await host.side.getByRole("button",{name:"Settings",exact:true}).click();
    await host.side.getByText("Model: fixture-model",{exact:true}).waitFor();
    await host.side.getByText("Credential source: saved",{exact:true}).waitFor();
    assert.ok(!(await host.side.locator("body").innerText()).includes("fixture-only-no-provider-request"));
    await host.side.getByRole("button",{name:"Remove key and disable fallback",exact:true}).click();
    await host.side.getByText("Credential source: disabled",{exact:true}).waitFor();
    await host.page.screenshot({path:path.join(work,"settings-restored.png")});
    console.log("PERSISTENCE UI PASS: full VS Code restart restores chat title/model/SecretStorage; removal disables environment fallback. No inference requests.");
  } finally {await host.app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
