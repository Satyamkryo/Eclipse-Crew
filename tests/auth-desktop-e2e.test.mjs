import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// The browser runs in a fresh cap-free container with tmpfs-only state. It never
// connects to a host browser, host database port, or an existing Compose project.
const browserProgram = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '/opt/eclipse/desktop/node_modules/playwright-core/index.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const base='http://127.0.0.1:8080';
const browser=await chromium.launch({executablePath:'/opt/chromium/chrome-linux/chrome',headless:true,chromiumSandbox:true});
try {
  const context=await browser.newContext(input.phase==='setup'?{}:{storageState:'/tmp/owner-state.json'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage();
  page.on('pageerror',error=>console.error(JSON.stringify({pageError:error.name,message:error.message.slice(0,300),stack:error.stack?.split('\n').slice(0,4).join('\n').slice(0,1200)})));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))console.error(JSON.stringify({browserConsole:message.type(),message:message.text().slice(0,500)}));});
  let desktopSocketConnections=0;
  page.on('websocket',ws=>{if(ws.url().includes('/api/desktop/')&&ws.url().includes('/stream'))desktopSocketConnections++;let received=0,sent=0;ws.on('framereceived',event=>{if(++received<=8)console.error(JSON.stringify({rfbReceiveBytes:event.payload.length,firstByte:event.payload[0]}));});ws.on('framesent',event=>{if(++sent<=8)console.error(JSON.stringify({rfbSendBytes:event.payload.length,firstByte:event.payload[0]}));});ws.on('socketerror',()=>console.error('desktop_websocket_error'));ws.on('close',()=>console.error('desktop_websocket_closed'));});
  page.setDefaultTimeout(20000);
  if(input.phase==='setup') {
    console.error('setup:start');
    let ready=false;
    for(let n=0;n<60;n++){
      try {if((await context.request.get(base+'/setup',{timeout:2000})).status()===200){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.ok(ready,'fresh app serves setup through private ingress');
    console.error('setup:ready');
    await page.goto(base+'/setup');
    await page.getByRole('heading',{name:'Create your owner account'}).waitFor();
    const requests=await Promise.all([0,1].map(()=>context.request.post(base+'/api/auth/setup',{
      headers:{Origin:base},data:{login:input.login,password:input.password,timezone:'UTC'}})));
    assert.deepEqual(requests.map(r=>r.status()).sort(),[200,404]);
    assert.equal((await context.request.get(base+'/setup')).status(),404);
    await page.goto(base+'/login');
    await page.getByLabel('Email',{exact:true}).fill(input.login);
    await page.getByLabel('Password',{exact:true}).fill(input.password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.waitForURL(base+'/');
    await page.getByRole('heading',{name:'Eclipse Crew',exact:true}).waitFor();
    console.error('setup:login');
    const softNavPanel=page.getByRole('complementary',{name:'Workspace panel'});
    const softNavWidth=await softNavPanel.evaluate(element=>element.getBoundingClientRect().width);
    const softNavSeparator=page.getByRole('separator',{name:'Resize workspace panel'});
    await softNavSeparator.focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(width=>document.querySelector('[aria-label="Workspace panel"]')?.getBoundingClientRect().width>width+1,softNavWidth);
    await page.getByRole('separator',{name:'Resize workspace panel'}).focus();
    await page.keyboard.press('Home');
    await page.waitForFunction(()=>document.querySelector('[aria-label="Workspace panel"]')?.getBoundingClientRect().width<=381);
    const cookies=await context.cookies();
    assert.ok(cookies.some(c=>c.httpOnly&&c.sameSite==='Lax'&&!c.secure&&c.value.length>=64),'working local HTTP cookie');
    const anonymous=await browser.newContext();
    const denied=await anonymous.request.get(base+'/api/auth/csrf',{headers:{'x-owner-id':input.agents[0],Cookie:'eclipse_session='+('f'.repeat(64))}});
    assert.equal(denied.status(),401);
    const noCsrf=await context.request.post(base+'/api/auth/logout',{headers:{Origin:base},data:{}});
    assert.equal(noCsrf.status(),403);
    await anonymous.close();
    const peer=await browser.newContext();
    await peer.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    const peerPage=await peer.newPage();
    peerPage.setDefaultTimeout(20000);
    await peerPage.goto(base+'/login');
    await peerPage.getByLabel('Email',{exact:true}).fill(input.login);
    await peerPage.getByLabel('Password',{exact:true}).fill(input.password);
    await peerPage.getByRole('button',{name:'Sign in',exact:true}).click();
    await peerPage.waitForURL(base+'/');
    await page.goto(base+'/');
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    await page.getByRole('link',{name:'Account settings',exact:true}).click();
    await page.waitForURL(base+'/settings/account');
    await page.getByRole('heading',{name:'Account',exact:true}).waitFor();
    await page.setViewportSize({width:375,height:800});
    await page.reload();
    await page.getByRole('heading',{name:'Account',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false,'account settings fit at 375 px');
    await page.setViewportSize({width:1280,height:720});
    await page.reload();
    await page.getByRole('heading',{name:'Account',exact:true}).waitFor();
    const sessionList=page.getByRole('list',{name:'Active sessions'});
    await sessionList.getByRole('listitem').first().waitFor();
    assert.equal(await sessionList.getByRole('listitem').count(),2);
    assert.equal(await page.getByText('Current session',{exact:true}).count(),1);
    let csrf=await (await context.request.get(base+'/api/auth/csrf')).json();
    const missingCsrf=await context.request.post(base+'/api/auth/account/email',{headers:{Origin:base},data:{login:'forged@example.test',currentPassword:input.password}});
    assert.equal(missingCsrf.status(),403);
    const missingPasswordCsrf=await context.request.post(base+'/api/auth/account/password',{headers:{Origin:base},data:{currentPassword:input.password,newPassword:'replacement-owner-password'}});
    assert.equal(missingPasswordCsrf.status(),403);
    const missingSignOutCsrf=await context.request.post(base+'/api/auth/sessions/revoke-others',{headers:{Origin:base},data:{}});
    assert.equal(missingSignOutCsrf.status(),403);
    const wrongOrigin=await context.request.post(base+'/api/auth/account/email',{headers:{Origin:'http://evil.test','x-csrf-token':csrf.csrfToken},data:{login:'forged@example.test',currentPassword:input.password}});
    assert.equal(wrongOrigin.status(),403);
    const unknownOwnerField=await context.request.post(base+'/api/auth/account/email',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{login:'forged@example.test',currentPassword:input.password,ownerId:input.agents[0]}});
    assert.equal(unknownOwnerField.status(),400);
    const oversized=await context.request.post(base+'/api/auth/account/password',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{currentPassword:input.password,newPassword:'replacement-password',padding:'x'.repeat(5000)}});
    assert.equal(oversized.status(),413);
    const wrongEmailPassword=await context.request.post(base+'/api/auth/account/email',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{login:'forged@example.test',currentPassword:'incorrect-password'}});
    assert.equal(wrongEmailPassword.status(),403);
    const newEmail='updated.'+input.login;
    await page.locator('#email-login').fill(newEmail);
    await page.locator('#email-current-password').fill(input.password);
    await page.getByRole('button',{name:'Change email',exact:true}).click();
    await page.getByRole('status').filter({hasText:/Email updated/}).waitFor();
    assert.equal(await page.locator('#email-login').inputValue(),newEmail,'email form immediately shows the saved address');
    await page.reload();
    await page.getByText(newEmail,{exact:false}).waitFor();
    assert.equal(await page.locator('#email-login').inputValue(),newEmail,'email form shows the saved address after reload');
    assert.doesNotMatch(await page.locator('main').innerText(),/[0-9a-f]{64}/,'session page exposes no token material');
    const wrongPassword=await context.request.post(base+'/api/auth/account/password',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{currentPassword:'incorrect-password',newPassword:'replacement-owner-password'}});
    assert.equal(wrongPassword.status(),403);
    assert.equal((await peer.request.get(base+'/api/auth/csrf')).status(),200);
    await page.locator('#password-current-password').fill(input.password);
    await page.locator('#password-new-password').fill(input.replacementPassword);
    await page.getByRole('button',{name:'Change password',exact:true}).click();
    await page.getByRole('status').filter({hasText:/Password updated/}).waitFor();
    assert.equal((await peer.request.get(base+'/api/auth/csrf')).status(),401);
    assert.equal((await context.request.get(base+'/api/auth/csrf')).status(),200);
    await page.waitForFunction(()=>document.querySelectorAll('[aria-label="Active sessions"] li').length===1);
    assert.equal(await sessionList.getByRole('listitem').count(),1,'revoked peer disappears without a reload');
    console.error('setup:password-updated');
    await page.reload();
    await page.getByRole('heading',{name:'Account',exact:true}).waitFor();
    assert.equal(await sessionList.getByRole('listitem').count(),1);
    const staleLogin=await peer.request.post(base+'/api/auth/login',{headers:{Origin:base},data:{login:newEmail,password:input.password}});
    assert.equal(staleLogin.status(),401);
    const peer2=await browser.newContext();
    await peer2.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    const peer2Page=await peer2.newPage();
    peer2Page.setDefaultTimeout(20000);
    await peer2Page.goto(base+'/login');
    await peer2Page.getByLabel('Email',{exact:true}).fill(newEmail);
    await peer2Page.getByLabel('Password',{exact:true}).fill(input.replacementPassword);
    await peer2Page.getByRole('button',{name:'Sign in',exact:true}).click();
    await peer2Page.waitForURL(base+'/');
    await page.reload();
    await page.getByRole('heading',{name:'Account',exact:true}).waitFor();
    assert.equal(await sessionList.getByRole('listitem').count(),2);
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'Sign out everywhere',exact:true}).click();
    await page.getByRole('status').filter({hasText:/Other sessions signed out/}).waitFor();
    assert.equal((await peer2.request.get(base+'/api/auth/csrf')).status(),401);
    assert.equal((await context.request.get(base+'/api/auth/csrf')).status(),200);
    for(let attempt=1;attempt<=5;attempt++){
      const denied=await context.request.post(base+'/api/auth/account/password',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{currentPassword:'incorrect-password',newPassword:'replacement-owner-password'}});
      assert.equal(denied.status(),403);
    }
    const limited=await context.request.post(base+'/api/auth/account/password',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{currentPassword:'incorrect-password',newPassword:'replacement-owner-password'}});
    assert.equal(limited.status(),429);
    assert.ok(Number(limited.headers()['retry-after'])>0);
    await context.storageState({path:'/tmp/owner-state.json'});
    await peer.close();
    await peer2.close();
    console.error('setup:done');
    console.log(JSON.stringify({phase:'setup',checks:['one_owner_from_two_concurrent_submissions','setup_closed','browser_login_cookie','workspace_soft_navigation_resize','forged_cookie_owner_denied','logout_csrf_denied','active_sessions_current_marker','account_csrf_origin_and_input_denied','email_and_password_change_revoke_peer','sign_out_everywhere_keeps_current','account_password_rate_limited']}));
  } else if(input.phase==='agents') {
    page.setDefaultTimeout(60000);
    await page.setViewportSize({width:1440,height:900});
    await page.goto(base+'/');
    await page.getByRole('main',{name:'Eclipse Crew workspace'}).waitFor();
    const pane=page.getByRole('complementary',{name:'Agents pane'});
    const csrf=await (await context.request.get(base+'/api/auth/csrf')).json();
    const agentBody={name:'Forged',role:'None',soulMd:'Boundaries: ask.',dailyBudgetUsd:'1.00',monthlyBudgetUsd:'1.00',tools:[],domains:[],actions:[],memoryScopes:[]};
    const mutation=(method,path,{origin=base,csrfToken=csrf.csrfToken,data=agentBody}={})=>context.request.fetch(base+path,{method,headers:{Origin:origin,...(csrfToken?{'x-csrf-token':csrfToken}:{})},data});
    assert.equal((await mutation('POST','/api/agents',{csrfToken:''})).status(),403,'agent create requires CSRF');
    assert.equal((await mutation('POST','/api/agents',{origin:'https://denied.example'})).status(),403,'agent create requires exact origin');
    assert.equal((await mutation('POST','/api/agents',{csrfToken:'0'.repeat(64)})).status(),403,'agent create requires the session CSRF token');
    const forgedFields=await mutation('POST','/api/agents',{data:{...agentBody,ownerId:crypto.randomUUID()}});
    assert.equal(forgedFields.status(),400,'agent create rejects owner overrides');
    const unknownAgent=crypto.randomUUID();
    for(const [method,path] of [['PATCH','/api/agents/'+unknownAgent],['DELETE','/api/agents/'+unknownAgent],['POST','/api/agents/'+unknownAgent+'/pause'],['POST','/api/agents/'+unknownAgent+'/resume']]){
      const data=method==='DELETE'?{confirmation:'Unknown',backupAcknowledged:true}:agentBody;
      assert.equal((await mutation(method,path,{origin:'https://denied.example',data})).status(),403,method+' '+path+' requires exact origin');
      assert.equal((await mutation(method,path,{csrfToken:'0'.repeat(64),data})).status(),403,method+' '+path+' requires the session CSRF token');
      assert.equal((await mutation(method,path,{data})).status(),404,method+' '+path+' rejects a non-owned agent');
    }
    const registryOnly=await context.request.get(base+'/api/desktop/'+crypto.randomUUID()+'/stream');
    assert.equal(registryOnly.status(),404,'desktop access requires a saved owner-scoped agent');
    const createButton=pane.getByRole('button',{name:'Create agent',exact:true}).first();
    await createButton.click();
    const probe=page.getByRole('dialog',{name:'Create agent',exact:true});
    await probe.waitFor();
    for(let index=0;index<8;index++){
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement?.closest('dialog')!==null),true,'create dialog traps focus');
    }
    await page.keyboard.press('Escape');
    await probe.waitFor({state:'detached'});
    assert.equal(await createButton.evaluate(element=>document.activeElement===element),true,'create dialog restores opener focus');
    const created=[];
    for(const [index,spec] of [
      {name:'Audit A',role:'Daily briefer',daily:'10.00',monthly:'100.00',domain:'example.com',action:'read_page',persona:'You are Audit A. Boundaries: ask first.'},
      {name:'Audit B',role:'Research analyst',daily:'5.00',monthly:'50.00',domain:'news.example.com',action:'browse',persona:''},
    ].entries()){
      await pane.getByRole('button',{name:'Create agent',exact:true}).first().click();
      const dialog=page.getByRole('dialog',{name:'Create agent',exact:true});
      await dialog.getByLabel('Name',{exact:true}).fill(spec.name);
      await dialog.getByLabel('Role',{exact:true}).fill(spec.role);
      if(spec.persona) await dialog.getByLabel('Persona (SOUL.md)',{exact:true}).fill(spec.persona);
      await dialog.getByLabel('Daily budget (USD)',{exact:true}).fill(spec.daily);
      await dialog.getByLabel('Monthly budget (USD)',{exact:true}).fill(spec.monthly);
      await dialog.getByLabel('Tools',{exact:true}).fill(index?'web.fetch':'web.fetch, web.fetch');
      await dialog.getByLabel('Domains',{exact:true}).fill(spec.domain);
      await dialog.getByLabel('Actions',{exact:true}).fill(spec.action);
      await dialog.getByRole('checkbox',{name:'agent',exact:true}).check();
      if(index===0){
        const name=dialog.getByLabel('Name',{exact:true});
        const daily=dialog.getByLabel('Daily budget (USD)',{exact:true});
        const domains=dialog.getByLabel('Domains',{exact:true});
        const submit=dialog.getByRole('button',{name:'Create agent',exact:true});
        await name.fill('');
        await name.press('Tab');
        await dialog.getByText('Name is required.').waitFor();
        assert.equal(await name.getAttribute('aria-invalid'),'true','blur validation marks the field');
        await name.focus();
        await submit.click();
        await page.waitForFunction(()=>document.activeElement?.id==='new-agent-name',{timeout:2000}).catch(()=>{});
        const focusState=await page.evaluate(()=>({id:document.activeElement?.id||'',tag:document.activeElement?.tagName||'',invalid:[...document.querySelectorAll('[aria-invalid="true"]')].map(element=>element.id),errors:[...document.querySelectorAll('[id$="-error"]')].map(element=>element.textContent)}));
        assert.equal(focusState.id,'new-agent-name','first invalid field is focused '+JSON.stringify(focusState));
        assert.equal(await name.getAttribute('aria-invalid'),'true');
        await dialog.getByText('Name is required.').waitFor();
        await name.fill(spec.name);
        await daily.fill('0');
        await submit.click();
        await page.waitForFunction(()=>document.activeElement?.id==='new-agent-daily-budget',{timeout:2000}).catch(()=>{});
        assert.equal(await page.evaluate(()=>document.activeElement?.id),'new-agent-daily-budget');
        assert.equal(await daily.getAttribute('aria-invalid'),'true');
        await dialog.getByText('Enter a daily budget from 0.01 to 1,000,000.00.').waitFor();
        await daily.fill(spec.daily);
        await domains.fill('https://example.com');
        await submit.click();
        await page.waitForFunction(()=>document.activeElement?.id==='new-agent-domains',{timeout:2000}).catch(()=>{});
        assert.equal(await page.evaluate(()=>document.activeElement?.id),'new-agent-domains');
        assert.equal(await domains.getAttribute('aria-invalid'),'true');
        await dialog.getByText('Domains must be hostnames such as example.com.').waitFor();
        await domains.fill(spec.domain);
        const tools=dialog.getByLabel('Tools',{exact:true});
        await tools.fill('a'.repeat(65));
        await submit.click();
        await page.waitForFunction(()=>document.activeElement?.id==='new-agent-tools',{timeout:2000}).catch(()=>{});
        assert.equal(await page.evaluate(()=>document.activeElement?.id),'new-agent-tools');
        assert.equal(await tools.getAttribute('aria-invalid'),'true');
        await dialog.getByText('Each identifier must be 64 characters or fewer.').waitFor();
        await tools.fill(index?'web.fetch':'web.fetch, web.fetch');
      }
      const previous=new URL(page.url()).searchParams.get('agent');
      const createdResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/agents');
      await dialog.getByRole('button',{name:'Create agent',exact:true}).click();
      assert.equal((await createdResponse).status(),201,'agent create API succeeds');
      await page.waitForURL(url=>url.pathname==='/'&&url.searchParams.get('agent')&&url.searchParams.get('agent')!==previous);
      const id=new URL(page.url()).searchParams.get('agent');
      assert.match(id,/^[0-9a-f-]{36}$/);
      created.push({id,name:spec.name});
      await page.getByRole('link',{name:new RegExp(spec.name)}).waitFor();
    }
    const [first,second]=created;
    await page.getByRole('link',{name:/Audit A/}).click();
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    const settings=page.getByRole('heading',{name:'Agent settings',exact:true});
    await settings.waitFor();
    await page.getByLabel('Role',{exact:true}).fill('Research analyst');
    await page.getByLabel('Persona (SOUL.md)',{exact:true}).fill('You are Audit A, updated. Boundaries: ask before changes.');
    await page.getByLabel('Daily budget (USD)',{exact:true}).fill('12.50');
    await page.getByLabel('Domains',{exact:true}).fill('Example.COM, news.example.com');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Agent settings saved.'}).waitFor();
    await page.reload();
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    assert.equal(await page.getByLabel('Role',{exact:true}).inputValue(),'Research analyst');
    assert.equal(await page.getByLabel('Daily budget (USD)',{exact:true}).inputValue(),'12.50');
    assert.match(await page.getByLabel('Domains',{exact:true}).inputValue(),/example\.com, news\.example\.com/);
    await page.getByRole('tab',{name:'Desktop',exact:true}).click();
    await page.getByRole('status').filter({hasText:/^Live$/}).waitFor();
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Pause agent',exact:true}).click();
    await pane.getByText('Paused',{exact:true}).waitFor();
    await page.getByRole('status').filter({hasText:/^Live$/}).waitFor({state:'detached'});
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Resume agent',exact:true}).click();
    await page.getByRole('status').filter({hasText:/^Live$/}).waitFor();
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Pause agent',exact:true}).waitFor();
    await page.getByRole('tab',{name:'Desktop',exact:true}).click();
    await page.getByRole('status').filter({hasText:/^Live$/}).waitFor();
    await pane.getByRole('button',{name:'Create agent',exact:true}).first().click();
    const deleteCreate=page.getByRole('dialog',{name:'Create agent',exact:true});
    await deleteCreate.getByLabel('Name',{exact:true}).fill('Temporary Agent');
    await deleteCreate.getByLabel('Role',{exact:true}).fill('Temporary');
    await deleteCreate.getByLabel('Daily budget (USD)',{exact:true}).fill('1.00');
    await deleteCreate.getByLabel('Monthly budget (USD)',{exact:true}).fill('2.00');
    const priorAgent=new URL(page.url()).searchParams.get('agent');
    const deleteCreateResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/agents');
    await deleteCreate.getByRole('button',{name:'Create agent',exact:true}).click();
    assert.equal((await deleteCreateResponse).status(),201);
    await page.waitForURL(url=>url.searchParams.get('agent')&&url.searchParams.get('agent')!==priorAgent);
    const deletedId=new URL(page.url()).searchParams.get('agent');
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Delete agent',exact:true}).click();
    const deleteDialog=page.getByRole('dialog',{name:'Delete Temporary Agent?',exact:true});
    const confirmDelete=deleteDialog.getByRole('button',{name:'Delete agent',exact:true});
    assert.equal(await confirmDelete.isDisabled(),true,'delete requires explicit confirmation');
    await deleteDialog.getByLabel('Type Temporary Agent to confirm',{exact:true}).fill('wrong');
    await deleteDialog.getByRole('checkbox',{name:'I understand no backup will be made.',exact:true}).check();
    assert.equal(await confirmDelete.isDisabled(),true,'wrong name keeps deletion disabled');
    await deleteDialog.getByLabel('Type Temporary Agent to confirm',{exact:true}).fill('Temporary Agent');
    assert.equal((await mutation('DELETE','/api/agents/'+deletedId,{origin:'https://denied.example',data:{confirmation:'Temporary Agent',backupAcknowledged:true}})).status(),403,'real-agent delete requires exact origin');
    assert.equal((await mutation('DELETE','/api/agents/'+deletedId,{csrfToken:'0'.repeat(64),data:{confirmation:'Temporary Agent',backupAcknowledged:true}})).status(),403,'real-agent delete requires the session CSRF token');
    assert.equal((await mutation('DELETE','/api/agents/'+deletedId,{data:{confirmation:'wrong',backupAcknowledged:true}})).status(),409,'wrong confirmation is denied before deletion');
    assert.equal((await mutation('DELETE','/api/agents/'+deletedId,{data:{confirmation:'Temporary Agent',backupAcknowledged:false}})).status(),400,'backup acknowledgement is required');
    const deleteResponse=page.waitForResponse(response=>response.request().method()==='DELETE'&&new URL(response.url()).pathname==='/api/agents/'+deletedId);
    await confirmDelete.click();
    assert.equal((await deleteResponse).status(),200,'agent delete API succeeds');
    await page.waitForURL(base+'/');
    await page.getByRole('link',{name:/Temporary Agent/}).waitFor({state:'detached'});
    const screenshot=(await page.screenshot()).toString('base64');
    await page.setViewportSize({width:375,height:800});
    await page.reload();
    await page.getByRole('navigation',{name:'Workspace panes',exact:true}).getByRole('button',{name:'Agents',exact:true}).click();
    await pane.getByRole('link',{name:/Audit A/}).waitFor();
    await pane.getByRole('button',{name:'Create agent',exact:true}).first().click();
    const mobileCreate=page.getByRole('dialog',{name:'Create agent',exact:true});
    await mobileCreate.getByLabel('Name',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false,'agent creation fits at 375 px');
    await page.keyboard.press('Escape');
    await mobileCreate.waitFor({state:'detached'});
    console.log(JSON.stringify({phase:'agents',agents:created,deletedId,checks:['agent_create_edit_pause_resume_delete','agent_modal_focus_and_backup_confirmation','agent_route_origin_csrf_owner_denials','agent_field_errors_and_focus','agent_mobile_create_no_overflow'],screenshot}));
  } else if(input.phase==='layout') {
    const visible=async locator=>await locator.count()>0&&await locator.isVisible();
    const box=async locator=>{const value=await locator.boundingBox();assert.ok(value,'element has a layout box');return value;};
    const agents=page.getByRole('complementary',{name:'Agents pane'});
    const chat=page.getByRole('region',{name:'Chat pane'});
    const panel=page.getByRole('complementary',{name:'Workspace panel'});
    await page.setViewportSize({width:1440,height:900});
    await page.goto(base+'/');
    await page.getByRole('main',{name:'Eclipse Crew workspace'}).waitFor();
    assert.ok(Math.abs((await box(agents)).width-260)<2,'desktop agent pane is 260 px');
    const initial=await box(panel);
    assert.ok(Math.abs(initial.width-380)<2,'desktop panel defaults to 380 px');
    assert.ok((await box(chat)).x>=260,'chat follows the agent pane');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false,'desktop workspace has no page overflow');
    const desktopCapture=(await page.screenshot()).toString('base64');
    const tabs=page.getByRole('tablist',{name:'Workspace panel'});
    assert.equal(await tabs.evaluate(element=>element.scrollWidth<=element.clientWidth),true,'all six panel tabs fit at the 380 px minimum');
    const desktopTab=tabs.getByRole('tab',{name:'Desktop',exact:true});
    const settingsTab=tabs.getByRole('tab',{name:'Settings',exact:true});
    const memoryTab=tabs.getByRole('tab',{name:'Memory',exact:true});
    for(const tab of await tabs.getByRole('tab').all()){
      const controlled=await tab.getAttribute('aria-controls');
      assert.ok(controlled);
      assert.equal(await page.locator('[id="'+controlled+'"]').count(),1,'every tab controls an existing panel');
    }
    assert.equal(await desktopTab.getAttribute('aria-selected'),'true');
    await desktopTab.focus();
    await page.keyboard.press('End');
    assert.equal(await memoryTab.getAttribute('aria-selected'),'true','End selects the last tab');
    await page.keyboard.press('Home');
    assert.equal(await desktopTab.getAttribute('aria-selected'),'true','Home selects the first tab');
    await page.keyboard.press('ArrowRight');
    assert.equal(await settingsTab.getAttribute('aria-selected'),'true','ArrowRight moves tab selection');
    await page.getByRole('link',{name:'Account settings',exact:true}).waitFor();
    await desktopTab.click();
    const separator=page.getByRole('separator',{name:'Resize workspace panel'});
    const handle=await box(separator);
    await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
    await page.mouse.down();
    await page.mouse.move(handle.x-60,handle.y+handle.height/2,{steps:5});
    await page.mouse.up();
    assert.ok((await box(panel)).width>initial.width+30,'pointer drag widens the panel');
    await separator.focus();
    await page.keyboard.press('Home');
    await page.waitForFunction(()=>document.querySelector('[aria-label="Workspace panel"]')?.getBoundingClientRect().width<=381);
    assert.equal(await separator.getAttribute('aria-valuenow'),'380');
    await page.keyboard.press('End');
    await page.waitForFunction(()=>document.querySelector('[aria-label="Workspace panel"]')?.getBoundingClientRect().width>=719);
    assert.ok((await box(panel)).width<=720,'keyboard resize respects 50% maximum');
    await page.keyboard.press('ArrowRight');
    assert.ok((await box(panel)).width<720,'arrow key shrinks the panel');
    const clampHandle=await box(separator);
    await page.mouse.move(clampHandle.x+clampHandle.width/2,clampHandle.y+clampHandle.height/2);
    await page.mouse.down();
    await page.mouse.move(clampHandle.x+500,clampHandle.y+clampHandle.height/2,{steps:5});
    await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('[aria-label="Workspace panel"]')?.getBoundingClientRect().width<=381);
    assert.equal(await separator.getAttribute('aria-valuenow'),'380','pointer resize clamps at the 380 px minimum');
    await page.setViewportSize({width:1280,height:800});
    await page.reload();
    await page.getByRole('main',{name:'Eclipse Crew workspace'}).waitFor();
    assert.ok(Math.abs((await box(agents)).width-260)<2,'1280 px keeps the full agent pane');
    assert.ok((await box(panel)).width>=380&&(await box(panel)).width<=380+60,'1280 px panel stays within its range');
    await page.setViewportSize({width:768,height:900});
    await page.reload();
    await page.getByRole('main',{name:'Eclipse Crew workspace'}).waitFor();
    const rail=page.getByRole('complementary',{name:'Agents rail'});
    assert.ok(Math.abs((await box(rail)).width-56)<2,'tablet agent rail is 56 px');
    assert.equal(await page.getByRole('complementary',{name:'Workspace panel'}).count(),0,'tablet panel is not permanently open');
    const panelOpener=page.getByRole('button',{name:'Open workspace panel',exact:true});
    await panelOpener.click();
    const panelSheet=page.getByRole('dialog',{name:'Workspace panel',exact:true});
    await panelSheet.waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement?.closest('dialog')!==null),true,'sheet receives focus');
    await page.waitForTimeout(250);
    const sheetCapture=(await page.screenshot()).toString('base64');
    for(let index=0;index<8;index++){
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement?.closest('dialog')!==null),true,'focus stays inside the panel sheet');
    }
    await panelSheet.getByRole('button',{name:'Close workspace panel',exact:true}).click();
    await panelSheet.waitFor({state:'detached'});
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Open workspace panel');
    assert.equal(await panelOpener.evaluate(element=>document.activeElement===element),true,'panel opener regains focus');
    const agentOpener=page.getByRole('button',{name:'Open agents',exact:true});
    await agentOpener.click();
    const agentSheet=page.getByRole('dialog',{name:'Agents pane',exact:true});
    await agentSheet.getByRole('button',{name:'Create agent',exact:true}).first().waitFor();
    await page.keyboard.press('Escape');
    await agentSheet.waitFor({state:'detached'});
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Open agents');
    assert.equal(await agentOpener.evaluate(element=>document.activeElement===element),true,'agent opener regains focus');
    await page.setViewportSize({width:375,height:800});
    await page.reload();
    const mobileNav=page.getByRole('navigation',{name:'Workspace panes',exact:true});
    await mobileNav.waitFor();
    assert.equal(await visible(chat),true,'mobile starts on chat');
    assert.equal(await visible(agents),false,'mobile shows one pane at a time');
    await mobileNav.getByRole('button',{name:'Agents',exact:true}).click();
    await agents.getByRole('button',{name:'Create agent',exact:true}).first().waitFor();
    assert.equal(await visible(chat),false);
    const panelButton=mobileNav.getByRole('button',{name:'Panel',exact:true});
    await panelButton.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('complementary',{name:'Workspace panel'}).waitFor();
    assert.equal(await panelButton.getAttribute('aria-pressed'),'true','mobile pane button exposes its selected state');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false,'mobile workspace has no horizontal overflow');
    assert.equal(await page.getByRole('tablist',{name:'Workspace panel'}).evaluate(element=>element.scrollWidth<=element.clientWidth),true,'all six panel tabs fit at 375 px');
    const mobileCapture=(await page.screenshot()).toString('base64');
    assert.equal(await page.getByRole('button',{name:'Open workspace panel',exact:true}).count(),0,'mobile uses the bottom navigation instead of an open button');
    await page.goto(base+'/?agent=not-a-uuid');
    await page.getByRole('complementary',{name:'Agents pane'}).getByRole('alert').filter({hasText:/agent link is invalid/}).waitFor();
    await page.setViewportSize({width:768,height:900});
    await page.goto(base+'/?agent=not-a-uuid');
    await page.getByRole('dialog',{name:'Agents pane',exact:true}).getByRole('alert').filter({hasText:/agent link is invalid/}).waitFor();
    console.log(JSON.stringify({phase:'layout',checks:['workspace_three_pane_resize','workspace_tabs_keyboard','workspace_tablet_sheet_focus','workspace_mobile_tabs_no_overflow','workspace_agent_error_visible'],screenshots:{'workspace-1440':desktopCapture,'workspace-768-sheet':sheetCapture,'workspace-375-panel':mobileCapture}}));
  } else if(input.phase==='chat') {
    await page.setViewportSize({width:1440,height:900});
    await page.goto(base+'/?agent='+input.agents[0]);
    const chat=page.getByRole('region',{name:'Chat pane'});
    await chat.waitFor();
    const composer=chat.getByLabel('Message',{exact:true});
    await composer.waitFor();
    await composer.fill('Please prepare the synthetic brief.');
    const sendResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/agents/'+input.agents[0]+'/messages');
    await chat.getByRole('button',{name:'Send message',exact:true}).click();
    assert.equal((await sendResponse).status(),201,'user message persists through the authenticated route');
    await chat.getByText('Please prepare the synthetic brief.',{exact:true}).waitFor();
    await chat.getByText('Background run completed.',{exact:true}).waitFor({timeout:30000});
    await chat.locator('[data-card-type="clarification"]').getByText('More information needed',{exact:true}).waitFor();
    await chat.locator('[data-card-type="tool_connection"]').getByText('Connect GitHub',{exact:true}).waitFor();
    const routine=chat.locator('[data-card-type="routine"]');
    await routine.getByText('Every weekday at 09:00',{exact:true}).waitFor();
    assert.equal(await routine.getByRole('button').count(),0,'routine confirmation remains a later task');
    assert.equal(await chat.locator('[data-card-type="tool_connection"]').getByRole('button').count(),0,'tool connection remains a later task');
    await page.reload();
    await page.getByRole('region',{name:'Chat pane'}).getByText('Please prepare the synthetic brief.',{exact:true}).waitFor();
    const csrf=await (await context.request.get(base+'/api/auth/csrf')).json();
    const anonymous=await browser.newContext();
    assert.equal((await anonymous.request.get(base+'/api/agents/'+input.agents[0]+'/messages')).status(),401,'chat history requires an owner session');
    await anonymous.close();
    assert.equal((await context.request.post(base+'/api/agents/'+input.agents[0]+'/messages',{headers:{Origin:base},data:{text:'Missing CSRF'}})).status(),403);
    assert.equal((await context.request.post(base+'/api/agents/'+input.agents[0]+'/messages',{headers:{Origin:'https://denied.example','x-csrf-token':csrf.csrfToken},data:{text:'Wrong origin'}})).status(),403);
    assert.equal((await context.request.post(base+'/api/agents/'+input.agents[0]+'/messages',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{text:'Forged role',role:'agent'}})).status(),400,'public chat writes cannot forge agent cards');
    assert.equal((await context.request.get(base+'/api/agents/'+input.agents[0]+'/messages?limit=1')).status(),400,'history rejects unknown query fields');
    assert.equal((await context.request.get(base+'/api/agents/'+input.agents[0]+'/messages?after=not-a-uuid')).status(),400,'history rejects malformed cursors');
    assert.equal((await context.request.get(base+'/api/agents/'+crypto.randomUUID()+'/messages')).status(),404,'history rejects an unowned agent');
    const firstHistory=await (await context.request.get(base+'/api/agents/'+input.agents[0]+'/messages')).json();
    assert.ok(firstHistory.messages.some(message=>message.card.text==='Please prepare the synthetic brief.'));
    assert.ok(firstHistory.messages.some(message=>message.runId&&message.card.text==='Background run completed.'),'background result keeps its run reference');
    await page.goto(base+'/?agent='+input.agents[1]);
    const peerChat=page.getByRole('region',{name:'Chat pane'});
    await peerChat.getByText(/^No conversation yet\./).waitFor();
    assert.equal(await peerChat.getByText('Please prepare the synthetic brief.',{exact:true}).count(),0,'chat history is isolated per agent');
    const secondHistory=await (await context.request.get(base+'/api/agents/'+input.agents[1]+'/messages')).json();
    assert.equal(secondHistory.messages.length,0);
    assert.equal((await context.request.post(base+'/api/agents/'+input.agents[0]+'/pause',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{}})).status(),200);
    await page.goto(base+'/?agent='+input.agents[0]);
    const pausedChat=page.getByRole('region',{name:'Chat pane'});
    await pausedChat.getByText('Please prepare the synthetic brief.',{exact:true}).waitFor();
    assert.equal(await pausedChat.getByLabel('Message',{exact:true}).isDisabled(),true,'paused agent chat is read-only');
    await pausedChat.getByText('Resume this agent to send a message.',{exact:true}).waitFor();
    assert.equal((await context.request.post(base+'/api/agents/'+input.agents[0]+'/resume',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{}})).status(),200);
    await page.setViewportSize({width:375,height:800});
    await page.goto(base+'/?agent='+input.agents[0]);
    await page.getByRole('navigation',{name:'Workspace panes'}).getByRole('button',{name:'Chat',exact:true}).click();
    await page.getByRole('region',{name:'Chat pane'}).getByLabel('Message',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false,'chat fits at 375 px');
    const chatCapture=(await page.screenshot()).toString('base64');
    console.log(JSON.stringify({phase:'chat',checks:['chat_user_message_persists','chat_background_result_polls_live','chat_four_validated_cards_render','chat_route_origin_csrf_owner_and_input_denials','chat_history_isolated_per_agent','chat_paused_read_only','chat_mobile_no_overflow'],screenshot:chatCapture}));
  } else if(input.phase==='models') {
    const modelKey=input.modelKey;
    const anonymous=await browser.newContext();
    const unauthenticated=await anonymous.request.put(base+'/api/models/roles/main',{headers:{Origin:base},data:{kind:'meta',model:'muse-spark-1.3',apiKey:modelKey}});
    assert.equal(unauthenticated.status(),401);
    await anonymous.close();
    const csrf=await (await context.request.get(base+'/api/auth/csrf')).json();
    const missingCsrf=await context.request.put(base+'/api/models/roles/main',{headers:{Origin:base},data:{kind:'meta',model:'muse-spark-1.3',apiKey:modelKey}});
    assert.equal(missingCsrf.status(),403);
    const wrongOrigin=await context.request.put(base+'/api/models/roles/main',{headers:{Origin:'http://evil.test','x-csrf-token':csrf.csrfToken},data:{kind:'meta',model:'muse-spark-1.3',apiKey:modelKey}});
    assert.equal(wrongOrigin.status(),403);
    const unknownField=await context.request.put(base+'/api/models/roles/main',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{kind:'meta',model:'muse-spark-1.3',apiKey:modelKey,ownerId:input.agents[0]}});
    assert.equal(unknownField.status(),400);
    const invalidUrl=await context.request.put(base+'/api/models/roles/main',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{kind:'openai-compatible',model:'muse-glimmer',baseUrl:'https://user:secret@example.test/v1'}});
    assert.equal(invalidUrl.status(),400);
    await page.goto(base+'/settings/models');
    await page.getByRole('heading',{name:'Models',exact:true}).waitFor();
    const mainCard=page.getByRole('region',{name:'Main AI'});
    const samCard=page.getByRole('region',{name:'Vision precision (SAM 3.1)'});
    await mainCard.getByText('Setup needed',{exact:true}).waitFor();
    await mainCard.getByLabel('API key').fill(modelKey);
    const mainSaveResponse=page.waitForResponse(response=>response.url()===base+'/api/models/roles/main'&&response.request().method()==='PUT');
    await mainCard.getByRole('button',{name:'Save Main AI',exact:true}).click();
    const mainSaveBody=await (await mainSaveResponse).text();
    assert.ok(!mainSaveBody.includes(modelKey),'save response never returns the key');
    assert.doesNotMatch(mainSaveBody,/v1\.[A-Za-z0-9_-]+\./,'save response never returns ciphertext');
    await mainCard.getByText(/Saved key .*1234/).waitFor();
    assert.equal(await mainCard.getByLabel('API key').inputValue(),'','key input clears after save');
    await page.reload();
    await page.getByRole('heading',{name:'Models',exact:true}).waitFor();
    const reloadedMain=page.getByRole('region',{name:'Main AI'});
    await reloadedMain.getByText(/Saved key .*1234/).waitFor();
    assert.doesNotMatch(await page.locator('main').innerText(),new RegExp(modelKey),'saved key never returns to the browser');
    assert.doesNotMatch(await page.locator('main').innerText(),/v1\.[A-Za-z0-9_-]+\./,'page never exposes ciphertext');
    const reloadedSam=page.getByRole('region',{name:'Vision precision (SAM 3.1)'});
    await reloadedSam.getByLabel('Mode').selectOption('meta');
    assert.equal(await reloadedSam.getByRole('checkbox',{name:/Use the same key as Main AI/}).isChecked(),true,'same-key defaults on');
    const samSaveResponse=page.waitForResponse(response=>response.url()===base+'/api/models/roles/sam'&&response.request().method()==='PUT');
    await reloadedSam.getByRole('button',{name:'Save SAM',exact:true}).click();
    const samSaveBody=await (await samSaveResponse).text();
    assert.ok(!samSaveBody.includes(modelKey));
    await reloadedSam.getByRole('status').filter({hasText:'SAM saved.'}).waitFor();
    await page.reload();
    await page.getByRole('heading',{name:'Models',exact:true}).waitFor();
    const savedMain=page.getByRole('region',{name:'Main AI'});
    const savedSam=page.getByRole('region',{name:'Vision precision (SAM 3.1)'});
    assert.equal(await savedSam.getByLabel('Mode').inputValue(),'meta');
    assert.equal(await savedSam.getByRole('checkbox',{name:/Use the same key as Main AI/}).isChecked(),true);
    assert.equal(await savedSam.getByLabel('SAM API key').count(),0,'same-key SAM stores no second key');
    await page.route('**/api/models/test',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({models:[{id:'muse-spark-1.3',contextTokens:1048576},{id:'muse-wonder-1.0',contextTokens:null}],latencyMs:7})}));
    await savedMain.getByRole('button',{name:'Test',exact:true}).click();
    await savedMain.getByText('Provider reachable',{exact:true}).waitFor();
    await savedMain.getByText('7 ms',{exact:true}).waitFor();
    assert.equal(await savedMain.getByText('muse-wonder-1.0',{exact:true}).count(),1);
    await page.unroute('**/api/models/test');
    await savedSam.getByRole('button',{name:'Test',exact:true}).click();
    await savedSam.getByText('Live provider testing is not connected yet. Your saved settings are unchanged.',{exact:true}).waitFor();
    await page.setViewportSize({width:375,height:800});
    await page.reload();
    await page.getByRole('heading',{name:'Models',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false,'model settings fit at 375 px');
    const modelsCapture=(await page.screenshot()).toString('base64');
    console.log(JSON.stringify({phase:'models',checks:['model_main_save_masked_encrypted','model_same_key_one_provider','model_saved_test_rendering','model_live_transport_unavailable','model_route_origin_csrf_owner_and_input_denials','model_mobile_no_overflow'],screenshot:modelsCapture}));
  } else if(input.phase==='account') {
    await page.goto(base+'/settings/account');
    await page.getByRole('heading',{name:'Account',exact:true}).waitFor();
    const sessionList=page.getByRole('list',{name:'Active sessions'});
    await sessionList.getByRole('listitem').first().waitFor();
    assert.equal(await sessionList.getByRole('listitem').count(),1);
    assert.equal(await page.getByText('Current session',{exact:true}).count(),1);
    assert.doesNotMatch(await page.locator('main').innerText(),/[0-9a-f]{64}/);
    console.log(JSON.stringify({phase:'account',checks:['expired_and_unrelated_sessions_hidden']}));
  } else {
    await page.setViewportSize({width:375,height:800});
    let streamRequests=0;
    const countStream=request=>{if(request.url().includes('/api/desktop/')&&request.url().includes('/stream'))streamRequests++;};
    page.on('request',countStream);
    await page.goto(base+'/?agent='+input.agents[0]);
    await page.getByRole('complementary',{name:'Workspace panel'}).waitFor();
    await page.getByRole('status').filter({hasText:/^Live$/}).waitFor();
    assert.equal(streamRequests,1,'mobile agent selection opens exactly one live panel');
    await page.goto('about:blank');
    streamRequests=0;
    await page.setViewportSize({width:768,height:900});
    await page.goto(base+'/?agent='+input.agents[0]);
    await page.getByRole('dialog',{name:'Workspace panel',exact:true}).waitFor();
    await page.getByRole('status').filter({hasText:/^Live$/}).waitFor();
    assert.equal(streamRequests,1,'tablet agent selection opens exactly one live panel');
    page.off('request',countStream);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog',{name:'Workspace panel',exact:true}).waitFor({state:'detached'});
    await page.setViewportSize({width:1280,height:720});
    const pixelCounts=async()=>page.locator('[aria-label="Agent screen"] canvas').evaluate(canvas=>{
      const ctx=canvas.getContext('2d');const {data}=ctx.getImageData(0,0,canvas.width,canvas.height);let red=0,blue=0;
      for(let i=0;i<data.length;i+=4){if(data[i]>180&&data[i+1]<100&&data[i+2]<100)red++;if(data[i+2]>180&&data[i]<100&&data[i+1]<100)blue++;}
      return {width:canvas.width,height:canvas.height,red,blue};
    });
    const watch=async(id,color)=>{
      await page.goto(base+'/?agent='+id);
      try {await page.getByRole('status').filter({hasText:/^Live$/}).waitFor();}
      catch(error){console.error(JSON.stringify({desktopStatus:await page.getByRole('status').allTextContents(),desktopMessage:(await page.locator('main').innerText()).slice(0,1200)}));throw error;}
      await page.waitForFunction(color=>{const c=document.querySelector('[aria-label="Agent screen"] canvas');if(!c||!c.width)return false;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(color==='red'?d[i]>180&&d[i+1]<100&&d[i+2]<100:d[i+2]>180&&d[i]<100&&d[i+1]<100)n++;return n>10000;},color);
      return pixelCounts();
    };
    const first=await watch(input.agents[0],'red');
    assert.ok(first.red>10000&&first.red>first.blue);
    const liveCapture=(await page.screenshot()).toString('base64');
    const liveStatus=page.getByRole('status').filter({hasText:/^Live$/});
    const socketsBeforeResize=desktopSocketConnections;
    const resizeHandle=page.getByRole('separator',{name:'Resize workspace panel'});
    const livePanelBefore=await page.getByRole('complementary',{name:'Workspace panel'}).boundingBox();
    await resizeHandle.focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(width=>document.querySelector('[aria-label="Workspace panel"]')?.getBoundingClientRect().width>width,livePanelBefore.width);
    await liveStatus.waitFor();
    await page.waitForTimeout(250);
    assert.equal(desktopSocketConnections,socketsBeforeResize,'resize does not reconnect the desktop stream');
    assert.equal(await page.getByRole('status').filter({hasText:/Connecting/}).count(),0,'resize keeps the desktop connection live');
    assert.equal(await page.locator('[aria-label="Agent screen"] canvas').isVisible(),true);
    const metadata=await (await context.request.get(base+'/api/desktop/'+input.agents[0]+'/stream')).json();
    const denied=await context.request.post(base+'/api/desktop/'+input.agents[0]+'/takeover',{
      headers:{Origin:base,'x-owner-id':input.agents[1]},data:{generation:metadata.generation,connectionId:crypto.randomUUID()}});
    assert.equal(denied.status(),403);
    await page.getByRole('button',{name:'Take over',exact:true}).click();
    await page.getByRole('button',{name:'Hand back',exact:true}).waitFor();
    // Find the synthetic white textarea against the red desktop content, then
    // click through the real scaled takeover overlay rather than DOM control.
    const canvas=page.locator('[aria-label="Agent screen"] canvas');
    const target=await canvas.evaluate(c=>{const ctx=c.getContext('2d');const d=ctx.getImageData(0,0,c.width,c.height).data;for(let y=100;y<600;y++){const white=(y*c.width+100)*4,red=(y*c.width+800)*4;if(d[white]>210&&d[white+1]>210&&d[white+2]>210&&d[red]>180&&d[red+1]<100&&d[red+2]<100)return{x:100,y:y+15,width:c.width,height:c.height};}return null;});
    assert.ok(target,'synthetic remote textarea is visible');
    const bounds=await canvas.boundingBox();assert.ok(bounds);
    await page.mouse.click(bounds.x+target.x*bounds.width/target.width,bounds.y+target.y*bounds.height/target.height);
    const text=page.getByLabel('Type into agent desktop',{exact:true});
    await text.focus();
    await page.keyboard.type('AuditTyping42',{delay:80});
    await page.waitForTimeout(700);
    // Route leave must release the active lease; watching a peer must work.
    const second=await watch(input.agents[1],'blue');
    assert.ok(second.blue>10000&&second.blue>second.red);
    await watch(input.agents[0],'red');
    await page.getByRole('button',{name:'Take over',exact:true}).click();
    await page.getByRole('button',{name:'Hand back',exact:true}).click();
    await page.getByRole('button',{name:'Take over',exact:true}).waitFor();
    const csrf=await (await context.request.get(base+'/api/auth/csrf')).json();
    const logout=await context.request.post(base+'/api/auth/logout',{headers:{Origin:base,'x-csrf-token':csrf.csrfToken},data:{}});
    assert.equal(logout.status(),200);
    await page.getByRole('status').filter({hasText:/^Offline$/}).waitFor({timeout:7000});
    assert.equal((await context.request.get(base+'/api/auth/csrf')).status(),401);
    console.log(JSON.stringify({phase:'desktop',checks:['two_real_rfb_canvas_frames','resize_preserves_live_desktop','takeover_csrf_denied','scaled_pointer_and_ordinary_text_input','route_leave_release','handback','logout_revokes_http_and_stream'],frames:[first,second],screenshot:liveCapture}));
  }
} finally {await browser.close();}
`;

const desktopFixtureProgram = String.raw`
import http from 'node:http';
http.createServer((req,res)=>{
  const a=req.url==='/A';const label=a?'Audit A':'Audit B';const color=a?'240,20,20':'20,20,240';
  res.setHeader('Content-Type','text/html');
  res.end('<!doctype html><title>'+label+'</title><body data-label="'+label+'" style="background:rgb('+color+');margin:30px"><textarea oninput="document.title=document.body.dataset.label+String.fromCharCode(32)+this.value" style="width:400px;height:90px"></textarea><input id="sensitive-password" type="password"><input id="sensitive-code" autocomplete="one-time-code"></body>');
}).listen(18766,'127.0.0.1');
`;

const primitiveProbe = String.raw`
import assert from 'node:assert/strict';import fs from 'node:fs';import{randomUUID}from'node:crypto';
const {ownerId,agentId}=JSON.parse(fs.readFileSync(0,'utf8'));
const request=async(operation,params={})=>{
  const response=await fetch('http://desktop:4310/v1/agents/'+agentId+'/commands',{method:'POST',signal:AbortSignal.timeout(10000),
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.DESKTOP_CONTROL_SECRET},
    body:JSON.stringify({ownerId,agentId,requestId:randomUUID(),operation,...params})});
  return response.json();
};
const status=await request('session.status');assert.equal(status.outcome,'ok');assert.equal(status.result.state,'running');
const generation=status.result.generation;assert.match(generation,/^[0-9a-f-]{36}$/);
const full=await request('capture.screenshot',{generation});assert.equal(full.outcome,'ok');
assert.equal(full.result.source_tag,'tool');assert.equal(full.result.untrusted,true);
assert.equal(full.result.width,1024);assert.equal(full.result.height,768);
const png=Buffer.from(full.result.base64,'base64');assert.equal(png.readUInt32BE(16),1024);assert.equal(png.readUInt32BE(20),768);
const crop=await request('capture.screenshot',{generation,crop:{x:10,y:20,width:120,height:80}});assert.equal(crop.outcome,'ok');
const cropped=Buffer.from(crop.result.base64,'base64');assert.equal(cropped.readUInt32BE(16),120);assert.equal(cropped.readUInt32BE(20),80);
let pages;for(let n=0;n<20;n++){pages=await request('browser.pages',{generation});if(pages.outcome==='ok'&&pages.result.pages.some(p=>p.href.startsWith('http://127.0.0.1:18766/')))break;await new Promise(r=>setTimeout(r,100));}
assert.equal(pages.outcome,'ok');assert.equal(pages.result.source_tag,'tool');assert.equal(pages.result.untrusted,true);
const page=pages.result.pages.find(p=>p.href.startsWith('http://127.0.0.1:18766/'));assert.ok(page);
for(const selector of ['#sensitive-password','#sensitive-code']){
 const result=await request('browser.locator',{generation,pageId:page.pageId,selector,action:'fill',text:'synthetic-denied'});
 assert.equal(result.outcome,'error');assert.equal(result.code,'sensitive_target');
}
console.log(JSON.stringify({checks:['real_full_desktop_png','real_bounded_crop_png','dom_pages_tagged_untrusted','actual_password_and_otp_fields_denied']}));
`;

const chatFixtureProbe = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const input=JSON.parse(process.argv[1]);
const client=await import('./db/client.ts');const{getDatabase}=client.getDatabase?client:client.default;
const schema=await import('./db/schema.ts');const{messages}=schema.messages?schema:schema.default;
const chat=await import('./lib/chat/data.ts');const{appendAgentCard,listAgentMessages}=chat.appendAgentCard?chat:chat.default;
const db=await getDatabase();
if(input.mode==='seed'){
  const before=(await db.select({id:messages.id}).from(messages)).length;
  let invalid=false;
  try{await appendAgentCard(db,input.ownerId,input.agentId,{card:{type:'message',text:''}});}catch(error){invalid=error.code==='invalid_card';}
  const after=(await db.select({id:messages.id}).from(messages)).length;
  assert.equal(invalid,true,'invalid agent card is rejected');
  assert.equal(after,before,'invalid agent card never reaches storage');
  for(const [card,sourceTag] of [
    [{type:'message',text:'Synthetic message card.'},'agent'],
    [{type:'clarification',question:'Which account should I use?',missingParameters:['Account','Site']},'agent'],
    [{type:'tool_connection',tool:'github',name:'GitHub',description:'Connect GitHub to read pull requests.'},'tool'],
    [{type:'routine',goal:'Prepare the daily brief.',steps:['Open the dashboard','Summarize changes'],schedule:'Every weekday at 09:00',timezone:'Asia/Kolkata',tools:['web.fetch'],budgetCents:300,catchUp:'run_once'},'agent'],
  ]) await appendAgentCard(db,input.ownerId,input.agentId,{card,sourceTag});
  let wrongOwner=false;
  try{await appendAgentCard(db,randomUUID(),input.agentId,{card:{type:'message',text:'Cross-owner'}});}catch(error){wrongOwner=error.code==='agent_not_found';}
  assert.equal(wrongOwner,true,'agent cards require exact owner scope');
  const history=await listAgentMessages(db,input.ownerId,input.agentId);
  assert.ok(history.messages.length>=4,'validated cards are readable back');
  const first=history.messages[0];
  const older=await listAgentMessages(db,input.ownerId,input.agentId,{before:first.id});
  assert.equal(older.messages.length,0,'first cursor has no earlier page');
  const newer=await listAgentMessages(db,input.ownerId,input.agentId,{after:first.id});
  assert.ok(newer.messages.length>=3,'after cursor returns the remaining timeline');
  let invalidCursor=false;
  try{await listAgentMessages(db,input.ownerId,input.agentId,{after:randomUUID()});}catch(error){invalidCursor=error.code==='invalid_cursor';}
  assert.equal(invalidCursor,true,'foreign cursors are rejected');
  console.log(JSON.stringify({outcome:'passed',checks:['invalid_agent_card_rejected_without_row','four_cards_seeded','agent_append_owner_scoped','chat_cursor_history_owner_scoped']}));
}else{
  const deadline=Date.now()+60000;
  let found=false;
  while(Date.now()<deadline){
    const history=await listAgentMessages(db,input.ownerId,input.agentId);
    if(history.messages.some(message=>message.card.type==='message'&&message.card.text===input.marker)){found=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  try{
    assert.equal(found,true,'browser message reached durable history');
    await appendAgentCard(db,input.ownerId,input.agentId,{card:{type:'message',text:'Background run completed.'},sourceTag:'agent',runId:randomUUID()});
    fs.writeFileSync(input.resultPath,JSON.stringify({outcome:'passed',checks:['background_result_appended_after_user_message']}),{mode:0o600});
  }catch{
    fs.writeFileSync(input.resultPath,JSON.stringify({outcome:'failed'}),{mode:0o600});
    process.exitCode=1;
  }
}
`;

const accountRollbackProbe = String.raw`
import assert from 'node:assert/strict';import fs from 'node:fs';import{eq,and}from'drizzle-orm';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const client=await import('./db/client.ts');const{getDatabase}=client.getDatabase?client:client.default;
const schema=await import('./db/schema.ts');const{owner,sessions}=schema.owner?schema:schema.default;
const account=await import('./lib/auth/account.ts');const{changeOwnerPassword}=account.changeOwnerPassword?account:account.default;
const passwords=await import('./lib/auth/password.ts');const{verifyPassword}=passwords.verifyPassword?passwords:passwords.default;
const db=await getDatabase();
let failed=false;
try{await changeOwnerPassword(db,input.ownerId,input.currentSessionId,input.currentPassword,'after-rollback-password');}catch{failed=true;}
assert.equal(failed,true,'credential change fails when session revocation is denied');
const owners=await db.select({passwordHash:owner.passwordHash}).from(owner).where(eq(owner.ownerId,input.ownerId)).limit(1);
assert.equal(await verifyPassword(owners[0].passwordHash,input.currentPassword),true,'old password survives rollback');
assert.equal(await verifyPassword(owners[0].passwordHash,'after-rollback-password'),false,'failed replacement is not stored');
const fixture=await db.select({id:sessions.id}).from(sessions).where(and(eq(sessions.ownerId,input.ownerId),eq(sessions.tokenHash,'rollback-fixture-hash'))).limit(1);
assert.equal(fixture.length,1,'other session survives rollback');
console.log(JSON.stringify({outcome:'passed',checks:['password_change_rollback_preserves_credential_and_sessions']}));
`;

const takeoverProbe = String.raw`
import assert from 'node:assert/strict';import fs from 'node:fs';import{randomUUID}from'node:crypto';
const {ownerId,agentId,resultPath}=JSON.parse(process.argv[1]);
const deadline=Date.now()+60000;
const request=async(operation,params={})=>{
 const r=await fetch('http://desktop:4310/v1/agents/'+agentId+'/commands',{method:'POST',signal:AbortSignal.timeout(7000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.DESKTOP_CONTROL_SECRET},body:JSON.stringify({ownerId,agentId,requestId:randomUUID(),operation,...params})});return r.json();
};
try{
 let generation,paused=false;
 while(Date.now()<deadline){const s=await request('session.status');assert.equal(s.outcome,'ok');generation=s.result.generation;if(s.result.takenOver){paused=true;break;}await new Promise(r=>setTimeout(r,100));}
 assert.ok(paused,'observed actual browser takeover');
 for(const [operation,params]of [['capture.screenshot',{}],['input.click',{button:'left',x:900,y:700}]]){const denied=await request(operation,{generation,...params});assert.equal(denied.outcome,'error');assert.equal(denied.code,'takeover_active');}
 let resumed=false;
 while(Date.now()<deadline){const s=await request('session.status');assert.equal(s.outcome,'ok');if(!s.result.takenOver){const capture=await request('capture.screenshot',{generation});if(capture.outcome==='ok'){resumed=true;break;}}await new Promise(r=>setTimeout(r,100));}
 assert.ok(resumed,'agent capture resumed after route leave or handback');
 fs.writeFileSync(resultPath,JSON.stringify({outcome:'passed',checks:['live_takeover_blocks_agent_capture_and_input','agent_capture_resumes_after_release']}),{mode:0o600});
}catch{fs.writeFileSync(resultPath,JSON.stringify({outcome:'failed'}),{mode:0o600});process.exitCode=1;}
`;

const rawRfbProbe = String.raw`
import fs from 'node:fs';import{randomUUID}from'node:crypto';import WebSocket from'ws';
const{ownerId,agentId}=JSON.parse(fs.readFileSync(0,'utf8'));const frames=[];let stage='status',pixelFormat;
try{
 const status=await(await fetch('http://desktop:4310/v1/agents/'+agentId+'/commands',{method:'POST',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.DESKTOP_CONTROL_SECRET},body:JSON.stringify({ownerId,agentId,requestId:randomUUID(),operation:'session.status'})})).json();
 if(status.outcome!=='ok')throw Error();
 const url=new URL('ws://desktop:4310/v1/agents/'+agentId+'/stream');for(const[k,v]of Object.entries({ownerId,generation:status.result.generation,sessionRef:'a'.repeat(64),connectionId:randomUUID()}))url.searchParams.set(k,v);
 stage='upgrade';const ws=new WebSocket(url,{headers:{Authorization:'Bearer '+process.env.DESKTOP_CONTROL_SECRET},handshakeTimeout:3000});
 await new Promise((resolve,reject)=>{let buffer=Buffer.alloc(0),done=false;const timer=setTimeout(()=>finish(true),8000);function finish(failed){if(done)return;done=true;clearTimeout(timer);ws.terminate();failed?reject(Error()):resolve();}
 ws.on('open',()=>{stage='version';});ws.on('error',()=>finish(true));ws.on('close',()=>finish(true));ws.on('message',data=>{if(done)return;frames.push({length:data.length,firstByte:data[0]});buffer=Buffer.concat([buffer,data]);if(buffer.length>8192)return finish(true);while(!done){if(stage==='version'){if(buffer.length<12)return;if(buffer.subarray(0,12).toString()!=='RFB 003.008\n')return finish(true);buffer=buffer.subarray(12);stage='security';ws.send('RFB 003.008\n',{binary:true});}else if(stage==='security'){if(buffer.length<2)return;if(buffer[0]!==1||buffer[1]!==1)return finish(true);buffer=buffer.subarray(2);stage='result';ws.send(Buffer.from([1]));}else if(stage==='result'){if(buffer.length<4)return;if(buffer.readUInt32BE()!==0)return finish(true);buffer=buffer.subarray(4);stage='init';ws.send(Buffer.from([1]));}else if(stage==='init'){if(buffer.length<24)return;const length=buffer.readUInt32BE(20);if(length>4096)return finish(true);if(buffer.length<24+length)return;if(buffer.readUInt16BE()!==1024||buffer.readUInt16BE(2)!==768)return finish(true);pixelFormat={width:buffer.readUInt16BE(),height:buffer.readUInt16BE(2),bitsPerPixel:buffer[4],depth:buffer[5],trueColour:buffer[7]};stage='complete';finish(false);}else return;}});});
 console.log(JSON.stringify({rawRfb:'passed',stage,frames,pixelFormat}));
}catch{console.log(JSON.stringify({rawRfb:'failed',stage,frames}));}
`;

test("fresh Compose browser auth and two real desktop streams", { timeout: 1800000 }, () => {
  const daemon = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(daemon.status, 0, "Docker Desktop Linux engine must be running before this disposable fixture can start");
  assert.equal(daemon.stdout.trim(), "linux");
  const project = `eclipseaudit${randomBytes(6).toString("hex")}`;
  const runId = randomUUID();
  const evidence = path.resolve("data/spikes/audit-repairs", runId);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const summary = { runId, project, suite: "auth-desktop-e2e", outcome: "incomplete", phase: "build", checks: [], cleanup: "pending" };
  const saveSummary = () => writeFileSync(path.join(evidence, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  saveSummary();
  const tempRoot = realpathSync(tmpdir());
  const temp = mkdtempSync(path.join(tempRoot, "eclipse-audit-e2e-"));
  const override = path.join(temp, "override.json");
  const empty = path.join(temp, "empty.env");
  writeFileSync(empty, "", { mode: 0o600 });
  writeFileSync(override, JSON.stringify({ services: {
    ingress: { ports: [] }, app: { environment: { APP_ORIGIN: "http://127.0.0.1:8080" } },
  }, networks: { frontend: { internal: true } } }), { mode: 0o600 });
  // JSON has no Compose !reset tag, so use a tiny YAML override for ports.
  const ports = path.join(temp, "ports.yml");
  writeFileSync(ports, "services:\n  ingress:\n    ports: !reset []\n");
  const bootstrap = randomBytes(24).toString("hex");
  const appPassword = randomBytes(24).toString("hex");
  const migratorPassword = randomBytes(24).toString("hex");
  const controlSecret = randomBytes(32).toString("hex");
  const encryptionKey = randomBytes(32).toString("hex");
  const password = randomBytes(24).toString("hex");
  const replacementPassword = randomBytes(24).toString("hex");
  const modelApiKey = `synthetic-meta-key-${randomBytes(6).toString("hex")}1234`;
  let agents = [randomUUID(), randomUUID()];
  const env = { ...process.env, ...(process.platform === "win32" ? { PATH: `E:\\Apps\\Docker\\resources\\bin;${process.env.PATH ?? ""}` } : {}), COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: [path.resolve("docker-compose.yml"), override, ports].join(path.delimiter), COMPOSE_ENV_FILES: empty,
    POSTGRES_BOOTSTRAP_PASSWORD: bootstrap, POSTGRES_APP_PASSWORD: appPassword, POSTGRES_MIGRATOR_PASSWORD: migratorPassword,
    DESKTOP_CONTROL_SECRET: controlSecret, ENCRYPTION_KEY: encryptionKey, APP_ORIGIN: "http://127.0.0.1:8080",
    DATABASE_URL: `postgresql://eclipse_app:${appPassword}@postgres:5432/eclipse`,
    MIGRATION_DATABASE_URL: `postgresql://eclipse_migrator:${migratorPassword}@postgres:5432/eclipse` };
  const secrets = [bootstrap, appPassword, migratorPassword, controlSecret, encryptionKey, password, replacementPassword, modelApiKey];
  const raw = (args, options = {}) => spawnSync("docker", args, { env, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
  const check = (result, label) => {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    for (const secret of secrets) assert.ok(!output.includes(secret), `${label}: synthetic credential leaked`);
    assert.equal(result.status, 0, `${label}: ${output.slice(-10000)} signal=${result.signal ?? "none"} error=${result.error?.message ?? "none"}`);
    return result.stdout.trim();
  };
  const docker = (args, label, options) => check(raw(args, options), label);
  const compose = (args, label, options) => docker(["compose", "--env-file", empty, ...args], label, options);
  const nodeScript = (script, label) => check(spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 120000 }), label);
  const browserName = `${project}-browser`;
  let browserCreated = false;
  let diagnostic;
  const desktopImages = [];
  try {
    compose(["build", "app", "desktop"], "build disposable app/desktop images", { timeout: 900000 });
    summary.phase = "start";
    saveSummary();
    compose(["up", "-d", "--no-build", "--wait"], "start five-service disposable stack", { timeout: 180000 });
    const postgres = compose(["ps", "-q", "postgres"], "find fixture postgres");
    const desktop = compose(["ps", "-q", "desktop"], "find fixture desktop");
    const app = compose(["ps", "-q", "app"], "find fixture app");
    const ingress = compose(["ps", "-q", "ingress"], "find fixture ingress");
    assert.equal(docker(["port", postgres], "Postgres ports"), "");
    assert.equal(docker(["port", desktop], "desktop ports"), "");
    assert.equal(docker(["port", ingress], "ingress ports"), "");
    summary.phase = "database";
    saveSummary();
    nodeScript("scripts/db-provision.mjs", "provision fresh least-privilege database");
    nodeScript("scripts/db-migrate.mjs", "migrate fresh database");
    const desktopImage = docker(["inspect", "--format", "{{.Image}}", desktop], "find verified desktop image");
    desktopImages.push(`${project}-app:latest`, `${project}-desktop:latest`);
    const frontend = JSON.parse(docker(["network", "inspect", `${project}_frontend`], "verify browser network"))[0];
    assert.equal(frontend.Labels["com.docker.compose.project"], project);
    assert.equal(frontend.Labels["com.docker.compose.network"], "frontend");
    assert.equal(frontend.Internal, true);
    docker(["run", "-d", "--name", browserName, "--label", `com.docker.compose.project=${project}`,
      // Share only this disposable ingress network namespace: localhost HTTP is
      // a browser secure context, with no host publication or insecure-origin flags.
      "--label", "com.docker.compose.service=browser-fixture", "--network", `container:${ingress}`,
      "--user", "65534:65534", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges:true",
      "--security-opt", `seccomp=${path.resolve("docker/desktop/seccomp_profile.json")}`, "--shm-size", "128m",
      "--tmpfs", "/tmp:rw,nosuid,size=536870912,mode=1777", desktopImage, "sleep", "infinity"], "start isolated browser");
    browserCreated = true;
    docker(["exec", "-i", browserName, "sh", "-c", "cat > /tmp/browser-program.mjs"], "install isolated browser program", { input: browserProgram });
    const browser = (phase) => JSON.parse(docker(["exec", "-i", browserName, "node", "/tmp/browser-program.mjs"],
      `real browser ${phase}`, { input: JSON.stringify({ phase, login: "audit-owner@example.test", password, replacementPassword, agents, modelKey: modelApiKey }), timeout: 180000 }));
    summary.phase = "browser-auth";
    const authResult = browser("setup");
    assert.equal(authResult.phase, "setup");
    summary.checks.push(...authResult.checks);
    saveSummary();
    summary.phase = "browser-layout";
    const layoutResult = browser("layout");
    assert.equal(layoutResult.phase, "layout");
    summary.checks.push(...layoutResult.checks);
    for (const [name, data] of Object.entries(layoutResult.screenshots))
      writeFileSync(path.join(evidence, `task018-${name}.png`), Buffer.from(data, "base64"), { mode: 0o600 });
    saveSummary();
    summary.phase = "browser-agents";
    const agentResult = browser("agents");
    assert.equal(agentResult.phase, "agents");
    assert.equal(agentResult.agents.length, 2);
    agents = agentResult.agents.map((agent) => agent.id);
    summary.checks.push(...agentResult.checks);
    writeFileSync(path.join(evidence, "task019-agents.png"), Buffer.from(agentResult.screenshot, "base64"), { mode: 0o600 });
    saveSummary();
    const ownerId = docker(["exec", postgres, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-Atc", "SELECT id FROM public.owner"], "get synthetic owner identity");
    assert.match(ownerId, /^[0-9a-f-]{36}$/);
    const psql = (statement) => docker(["exec", postgres, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-Atc", statement], "database fixture");
    const admin = (command, id, extra = []) => docker(["exec", "--user", "0:0", desktop, "python3", "/opt/eclipse/desktop/bootstrap.py", "--admin", command, ownerId, id, ...extra], `fixture agent ${command}`);
    assert.equal(psql(`SELECT count(*) FROM public.agents WHERE owner_id='${ownerId}'`), "2", "deleted agent rows are removed");
    assert.equal(psql(`SELECT count(*) FROM public.agent_policies WHERE owner_id='${ownerId}'`), "2", "deleted policy rows cascade");
    assert.equal(psql(`SELECT count(*) FROM public.agents WHERE id='${agentResult.deletedId}'`), "0");
    assert.equal(psql(`SELECT daily_budget_cents FROM public.agents WHERE id='${agents[0]}'`), "1250");
    assert.equal(psql(`SELECT domains::text FROM public.agent_policies WHERE agent_id='${agents[0]}'`), "{example.com,news.example.com}");
    assert.equal(psql(`SELECT soul_md LIKE '%updated%' FROM public.agents WHERE id='${agents[0]}'`), "t");
    assert.equal(psql(`SELECT (soul_md LIKE '%Audit B%')::text || '|' || (soul_md LIKE '%permission%')::text FROM public.agents WHERE id='${agents[1]}'`), "true|true", "blank persona gets the bounded default");
    assert.equal(raw(["exec", "--user", "0:0", desktop, "test", "!", "-e", `/workspace/homes/${agentResult.deletedId}`]).status, 0, "deleted home is gone");
    assert.equal(raw(["exec", "--user", "0:0", desktop, "test", "!", "-e", `/workspace/.system/downloads/${agentResult.deletedId}`]).status, 0, "deleted downloads backing is gone");
    assert.equal(raw(["exec", "--user", "0:0", desktop, "test", "!", "-e", `/downloads/${agentResult.deletedId}`]).status, 0, "deleted mounted downloads view is gone");
    assert.equal(raw(["exec", "--user", "0:0", desktop, "test", "-d", `/workspace/homes/${agents[0]}`]).status, 0, "peer home survives deletion");
    assert.notEqual(raw(["exec", "--user", "0:0", desktop, "python3", "/opt/eclipse/desktop/bootstrap.py", "--admin", "inspect", ownerId, agentResult.deletedId]).status, 0, "registry identity is gone");
    summary.checks.push("agent_deleted_from_database_and_desktop_without_peer_loss");
    summary.phase = "browser-chat";
    saveSummary();
    const chatSeed = JSON.parse(docker(["exec", "-i", app, "node", "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", chatFixtureProbe,
      JSON.stringify({ mode: "seed", ownerId, agentId: agents[0] })], "seed validated chat cards through the server-only append boundary", { timeout: 120000 }));
    assert.equal(chatSeed.outcome, "passed");
    summary.checks.push(...chatSeed.checks);
    const chatProbeResultPath = `/var/eclipse/artifacts/${runId}-chat-probe.json`;
    docker(["exec", "-d", app, "node", "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", chatFixtureProbe,
      JSON.stringify({ mode: "background", ownerId, agentId: agents[0], marker: "Please prepare the synthetic brief.", resultPath: chatProbeResultPath })],
    "start background chat-result append probe");
    const chatResult = browser("chat");
    assert.equal(chatResult.phase, "chat");
    const backgroundChat = JSON.parse(docker(["exec", app, "node", "-e", "console.log(require('node:fs').readFileSync(process.argv[1],'utf8'))", chatProbeResultPath], "actual background chat append evidence"));
    assert.equal(backgroundChat.outcome, "passed");
    summary.checks.push(...chatResult.checks, ...backgroundChat.checks);
    writeFileSync(path.join(evidence, "task022-chat.png"), Buffer.from(chatResult.screenshot, "base64"), { mode: 0o600 });
    saveSummary();
    summary.phase = "browser-models";
    const modelsResult = browser("models");
    assert.equal(modelsResult.phase, "models");
    summary.checks.push(...modelsResult.checks);
    assert.equal(psql("SELECT (SELECT count(*) FROM public.providers), (SELECT count(*) FROM public.model_roles), (SELECT count(DISTINCT provider_id) FROM public.model_roles)"), "1|2|1", "one encrypted provider is shared by Main AI and SAM");
    assert.equal(psql("SELECT encrypted_key LIKE 'v1.%' AND key_hint = repeat(chr(8226),4)||'1234' AND position('synthetic-meta-key' in encrypted_key) = 0 FROM public.providers"), "t", "only an authenticated ciphertext and hint are stored");
    assert.equal(psql("SELECT (role = 'sam' AND use_main_key AND mode = 'meta')::text FROM public.model_roles WHERE role = 'sam'"), "true", "SAM uses the Main key");
    summary.checks.push("model_settings_encrypted_at_rest_with_shared_same_key");
    writeFileSync(path.join(evidence, "task020-models.png"), Buffer.from(modelsResult.screenshot, "base64"), { mode: 0o600 });
    saveSummary();
    const expiredSessionId = randomUUID();
    const unrelatedSessionId = randomUUID();
    psql(`INSERT INTO public.sessions (id,owner_id,token_hash,csrf_token,expires_at) VALUES ('${expiredSessionId}','${ownerId}','expired-fixture-hash','fixture-csrf',now() - interval '1 hour')`);
    psql(`INSERT INTO public.sessions (id,owner_id,token_hash,csrf_token,expires_at) VALUES ('${unrelatedSessionId}','${randomUUID()}','unrelated-fixture-hash','fixture-csrf',now() + interval '1 hour')`);
    try {
      const accountResult = browser("account");
      assert.equal(accountResult.phase, "account");
      summary.checks.push(...accountResult.checks);
      saveSummary();
    } finally {
      psql(`DELETE FROM public.sessions WHERE id IN ('${expiredSessionId}','${unrelatedSessionId}')`);
    }
    const rollbackSessionId = randomUUID();
    psql(`INSERT INTO public.sessions (id,owner_id,token_hash,csrf_token,expires_at) VALUES ('${rollbackSessionId}','${ownerId}','rollback-fixture-hash','fixture-csrf',now() + interval '1 hour')`);
    let rollback;
    try {
      psql("REVOKE DELETE ON public.sessions FROM eclipse_app");
      rollback = JSON.parse(docker(["exec", "-i", app, "node", "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", accountRollbackProbe],
        "real database password-change rollback probe",
        { input: JSON.stringify({ ownerId, currentSessionId: randomUUID(), currentPassword: replacementPassword }), timeout: 120000 }));
    } finally {
      psql("GRANT DELETE ON public.sessions TO eclipse_app");
      psql(`DELETE FROM public.sessions WHERE id = '${rollbackSessionId}'`);
    }
    assert.equal(rollback.outcome, "passed");
    summary.checks.push(...rollback.checks);
    saveSummary();
    diagnostic = { app, ownerId, agentId: agents[0] };
    docker(["exec", "-d", "--user", "0:0", desktop, "node", "--input-type=module", "-e", desktopFixtureProgram], "start synthetic local desktop page");
    const displayByAgent = new Map();
    for (const [index, id] of agents.entries()) {
      const identity = JSON.parse(admin("inspect", id));
      const status = JSON.parse(admin("session-start", id));
      const display = status.display ?? (identity.uid - 19900);
      displayByAgent.set(id, { display, uid: identity.uid });
      const navigate = `import fs from 'node:fs';import{spawnSync}from'node:child_process';const runtime=fs.readdirSync('/tmp').filter(n=>n.startsWith('ec-'+process.getuid()+'-')).map(n=>'/tmp/'+n).find(n=>{try{return fs.lstatSync(n).uid===process.getuid()&&spawnSync('xdpyinfo',[],{env:{PATH:process.env.PATH,DISPLAY:':${display}',XAUTHORITY:n+'/Xauthority'},stdio:'ignore',timeout:1000}).status===0;}catch{return false;}});if(!runtime)throw Error('missing_display');const env={PATH:process.env.PATH,DISPLAY:':${display}',XAUTHORITY:runtime+'/Xauthority'};for(const argv of [['key','--clearmodifiers','ctrl+l'],['type','--clearmodifiers','--delay','1','--','http://127.0.0.1:18766/${index ? "B" : "A"}'],['key','Return']])if(spawnSync('xdotool',argv,{env,timeout:2000}).status!==0)throw Error('fixture_navigation');`;
      admin("exec", id, ["node", "--input-type=module", "-e", navigate]);
    }
    const primitives = JSON.parse(docker(["exec", "-i", app, "node", "--input-type=module", "-e", primitiveProbe], "real desktop primitive probes", {
      input: JSON.stringify({ ownerId, agentId: agents[0] }), timeout: 120000,
    }));
    summary.checks.push(...primitives.checks);
    const rfb = JSON.parse(docker(["exec", "-i", app, "node", "--input-type=module", "-e", rawRfbProbe], "real private RFB authentication and ServerInit", {
      input: JSON.stringify({ ownerId, agentId: agents[0] }), timeout: 15000,
    }));
    summary.rfb = rfb;
    saveSummary();
    assert.equal(rfb.rawRfb, "passed", "private real VNC ServerInit completed");
    summary.checks.push("real_private_vnc_authentication_and_rfb_server_init");
    saveSummary();
    summary.phase = "browser-desktop";
    saveSummary();
    const takeoverResultPath = `/var/eclipse/artifacts/${runId}-takeover-probe.json`;
    docker(["exec", "-d", app, "node", "--input-type=module", "-e", takeoverProbe,
      JSON.stringify({ ownerId, agentId: agents[0], resultPath: takeoverResultPath })], "start private takeover deny-path probe");
    const result = browser("desktop");
    assert.equal(result.phase, "desktop");
    const takeoverResult = JSON.parse(docker(["exec", app, "node", "-e", "console.log(require('node:fs').readFileSync(process.argv[1],'utf8'))", takeoverResultPath], "actual takeover deny and resume evidence"));
    assert.equal(takeoverResult.outcome, "passed");
    summary.checks.push(...takeoverResult.checks);
    const { display } = displayByAgent.get(agents[0]);
    const readTitle = () => admin("exec", agents[0], ["node", "--input-type=module", "-e",
      `import fs from 'node:fs';import{spawnSync}from'node:child_process';const runtime=fs.readdirSync('/tmp').find(n=>n.startsWith('ec-'+process.getuid()+'-'));const r=spawnSync('xdotool',['getactivewindow','getwindowname'],{env:{PATH:process.env.PATH,DISPLAY:':${display}',XAUTHORITY:'/tmp/'+runtime+'/Xauthority'},encoding:'utf8',timeout:2000});if(r.status!==0)process.exit(1);console.log(r.stdout);`]);
    // Chromium can update the window title a moment after the last key; poll for up to 5 s so a late
    // title passes while keystrokes that never arrive still fail with the last title seen.
    let title = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      try { title = readTitle(); } catch { title = ""; }
      if (/Audit A AuditTyping42/.test(title)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    assert.match(title, /Audit A AuditTyping42/, `ordinary takeover letters reached the actual remote textarea (last title: ${JSON.stringify(title.trim())})`);
    summary.checks.push(...result.checks);
    summary.frames = result.frames;
    writeFileSync(path.join(evidence, "task018-workspace-live.png"), Buffer.from(result.screenshot, "base64"), { mode: 0o600 });
    summary.outcome = "passed";
    saveSummary();
  } catch (error) {
    summary.reason = `failed_${summary.phase}`;
    if (diagnostic && summary.phase === "browser-desktop") {
      const result = raw(["exec", "-i", diagnostic.app, "node", "--input-type=module", "-e", rawRfbProbe], { input: JSON.stringify(diagnostic), timeout: 15000 });
      if (result.status === 0) {
        try { summary.diagnostic = JSON.parse(result.stdout); console.error(JSON.stringify(summary.diagnostic)); } catch { /* Keep the original acceptance failure. */ }
      }
    }
    saveSummary();
    throw error;
  } finally {
    if (browserCreated) {
      assert.equal(docker(["inspect", "--format", '{{ index .Config.Labels "com.docker.compose.project" }}', browserName], "verify browser cleanup label"), project);
      docker(["rm", "-f", browserName], "remove private browser fixture");
    }
    for (const [kind, args, format] of [
      ["container", ["ps", "-aq"], '{{ index .Config.Labels "com.docker.compose.project" }}'],
      ["network", ["network", "ls", "-q"], '{{ index .Labels "com.docker.compose.project" }}'],
      ["volume", ["volume", "ls", "-q"], '{{ index .Labels "com.docker.compose.project" }}'],
    ]) {
      const ids = docker([...args, "--filter", `label=com.docker.compose.project=${project}`], "identify exact fixture resources").split(/\r?\n/).filter(Boolean);
      for (const id of ids) assert.equal(docker([kind, "inspect", "--format", format, id], "verify exact fixture label"), project);
    }
    compose(["down", "--volumes", "--remove-orphans"], "remove verified disposable stack", { timeout: 120000 });
    for (const tag of desktopImages) {
      const inspected = raw(["image", "inspect", "--format", "{{json .RepoTags}}", tag]);
      if (inspected.status === 0) {
        assert.ok(JSON.parse(inspected.stdout).includes(tag));
        docker(["image", "rm", tag], "remove only disposable image tag");
      }
    }
    const resolved = realpathSync(temp);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith("eclipse-audit-e2e-"));
    rmSync(resolved, { recursive: true, force: true });
    summary.cleanup = "complete";
    saveSummary();
  }
});
