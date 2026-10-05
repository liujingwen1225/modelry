import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './evidence-fixtures';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let directory = '', url = '', modelURL = '';
let runtime: ChildProcessWithoutNullStreams;
let provider: Server;
test.beforeAll(async () => {
 directory = await mkdtemp(path.join(tmpdir(), 'modelry-agent-browser-')); await mkdir(path.join(directory,'project'));
 execFileSync('go',['build','-o',path.join(directory,'modelry'),'./cmd/modelry'],{cwd:repo,timeout:90000});
 runtime=spawn(path.join(directory,'modelry'),['start','--project-root',path.join(directory,'project'),'--listen','127.0.0.1:0'],{cwd:repo});
 url=await new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Runtime READY 超时')),15000);runtime.stdout.on('data',chunk=>{output+=String(chunk);const ready=output.split('\n').find(line=>line.startsWith('READY '));if(ready){clearTimeout(timer);resolve(JSON.parse(ready.slice(6)).url);}});runtime.on('error',reject);});
 // 协议夹具验证完整工具回合；真实外部模型验收单独记录，不能由此替代。
 provider=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=String(chunk);const input=JSON.parse(body);res.setHeader('Content-Type','application/json');const tools=Array.isArray(input.tools);const completed=input.messages.some((item:{role:string})=>item.role==='tool');res.end(JSON.stringify({choices:[{finish_reason:tools&&!completed?'tool_calls':'stop',message:tools&&!completed?{role:'assistant',content:'请复核新增集合',tool_calls:[{id:'call_browser',type:'function',function:{name:'collections_create',arguments:JSON.stringify({body:{name:'agent_browser_notes',type:'Normal',fields:[{name:'title',type:'text'}]}})}}]}:{role:'assistant',content:tools?'集合已创建并验证':'OK'}}]}));});
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();if(!address||typeof address==='string')throw new Error('模型夹具地址错误');modelURL='http://127.0.0.1:'+address.port;
},120000);
test.afterAll(async()=>{provider?.close();if(runtime&&runtime.exitCode===null){runtime.kill('SIGINT');await new Promise(resolve=>runtime.once('exit',resolve));}if(directory)await rm(directory,{recursive:true,force:true});});

test('真实 Admin 完成模型设置、确认执行、刷新恢复及中英主题响应式',async({page},testInfo)=>{
 await page.addInitScript(()=>{if(!localStorage.getItem('modelry-admin-locale'))localStorage.setItem('modelry-admin-locale','en');});
 await page.setViewportSize({width:1440,height:1000});await page.goto(url);
 await page.getByLabel('Email').fill('agent-browser@example.test');await page.getByLabel('Password').fill('Strong-Agent-Browser-Password-42!');await page.getByRole('button',{name:'Complete setup'}).click();
 await expect(page.locator('[data-shell-topbar]')).toBeVisible();await page.goto(url+'/settings/agent');
 await page.getByLabel('API base URL').fill(modelURL);await page.getByLabel('Model name').fill('protocol-fixture');await page.getByRole('button',{name:'Save model settings'}).click();await expect(page.getByRole('status')).toContainText('Saved');
 await page.getByRole('button',{name:'Test saved connection'}).click();await expect(page.getByRole('status')).toContainText('Model connected');
 await page.goto(url+'/agent');await page.getByRole('textbox',{name:'Task for Agent'}).fill('创建 notes 集合');await page.getByRole('button',{name:'Send',exact:true}).click();await expect(page.getByRole('button',{name:'Approve & execute'})).toBeVisible();
 await page.getByRole('link', {name:'MCP configuration',exact:true}).click();
 await expect(page.getByRole('link', {name:'MCP configuration',exact:true})).toHaveAttribute('aria-current','page');
 await expect(page.getByRole('textbox',{name:'Task for Agent'})).toHaveCount(0);
 await expect(page.getByText('modelry mcp --api-url <Modelry API origin> --api-key <Service Account API Key>',{exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Workspace',exact:true}).click();
 await expect(page.getByRole('button',{name:'Approve & execute'})).toBeVisible();
 const sessionURL=page.url();await page.reload();await expect(page.getByRole('button',{name:'Approve & execute'})).toBeVisible();await page.getByRole('button',{name:'Approve & execute'}).click();await expect(page.getByText('集合已创建并验证',{exact:true})).toBeVisible();
 const collections=await page.request.get(url+'/admin/api/v1/collections');expect((await collections.json()).data.filter((item:{name:string})=>item.name==='agent_browser_notes')).toHaveLength(1);
 await page.goto(sessionURL);await expect(page.getByText('集合已创建并验证',{exact:true})).toBeVisible();
 for(const width of [390,1440]) for(const locale of ['zh-CN','en']) for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:1000});await page.evaluate(({locale,theme})=>{localStorage.setItem('modelry-admin-locale',locale);localStorage.setItem('modelry-admin-theme',theme);},{locale,theme});
  // 初始化脚本仅用于首启；移除其固定语言后按当前选择加载。
  await page.goto(sessionURL);await page.getByRole('button',{name:locale==='en'?'Open Agent':'打开 Agent'}).click();
  const panel=page.getByRole('dialog');await expect(panel).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`agent-${width}-${locale}-${theme}.png`),fullPage:true});await page.keyboard.press('Escape');
 }
});
