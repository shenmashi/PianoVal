import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {webkit} from '@playwright/test';

const base=(process.env.PIANOVAL_TEST_URL||'http://localhost:8766/').replace(/\/?$/,'/');
const browser=await webkit.launch();
const results=[];
const username=process.env.PIANOVAL_TEST_USERNAME,password=process.env.PIANOVAL_TEST_PASSWORD;
if(!username||!password)throw new Error('Set PIANOVAL_TEST_USERNAME and PIANOVAL_TEST_PASSWORD for your test instance');
try{
  for(const account of [username]){
    const context=await browser.newContext({viewport:{width:1180,height:900},hasTouch:true});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'#piano');
    await page.locator('[name=username]').fill(username);
    await page.locator('[name=password]').fill(password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.locator('#logout').waitFor({state:'visible'});
    assert.equal(await page.locator('#account-name').textContent(),username);
    await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.startsWith('曲谱已就绪'),null,{timeout:60000});
    if(!await page.locator('#piano-start').isVisible())await page.locator('.nav-item[data-view=piano]').click();
    const sockets=[];
    page.on('websocket',socket=>socket.on('framereceived',({payload})=>{try{sockets.push(JSON.parse(String(payload)));}catch{}}));
    await page.locator('#piano-start').click();
    await page.waitForFunction(()=>document.querySelector('#piano-ready-status').dataset.phase==='ready',null,{timeout:45000});
    assert.equal(await page.locator('body').evaluate(body=>body.classList.contains('sidebar-collapsed')),true);
    await page.locator('#simulator-target').click();
    await page.waitForFunction(()=>document.querySelector('#practice-latency-log').textContent.includes('推理'),null,{timeout:15000});
    // Exiting during a live test must flush PCM and save before revoking the cookie.
    await page.locator('#logout').click();
    await page.waitForURL(/\/auth\/login/, {timeout:45000});
    assert.equal((await context.request.get(base+'auth/session')).status(),200);
    assert.equal((await (await context.request.get(base+'auth/session')).json()).authenticated,false);
    assert.equal((await context.request.get(base+'api/studio/state')).status(),401);
    const ready=sockets.find(message=>message.type==='ready');
    assert.ok(ready?.sessionId);
    assert.ok(sockets.some(message=>message.type==='notes'&&message.serverTiming));
    assert.ok(sockets.some(message=>message.type==='complete'));
    await page.locator('[name=username]').fill(username);
    await page.locator('[name=password]').fill(password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.locator('#logout').waitFor({state:'visible'});
    const report=await(await context.request.get(base+'api/studio/test-runs/'+ready.sessionId)).json();
    assert.equal(report.status,'completed');
    assert.ok(report.latencyLog.some(entry=>entry.kind==='model_window'));
    assert.ok(report.latencyLog.some(entry=>entry.kind==='browser_window'));
    assert.ok(report.latencyLog.some(entry=>entry.kind==='session_end'));
    assert.deepEqual(errors,[]);
    if(account===username)await page.screenshot({path:'test-evidence/auth-webkit-workspace.png'});
    results.push({username,browser:'WebKit',websocketReady:true,complete:true,logoutRevoked:true,menuCollapsed:true,latencyEntries:report.latencyLog.length,errors});
    await page.locator('#logout').click();await page.waitForURL(/\/auth\/login/);
    await context.close();
  }
  await writeFile('test-evidence/auth-webkit.json',JSON.stringify({base,results},null,2));
  console.log(JSON.stringify(results));
}finally{await browser.close();}
