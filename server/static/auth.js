import {appPath} from './paths.js';
import {hasLiveConnection, stopLiveAndWait} from './client.js';

export function loginAddress() {
  return appPath('/auth/login')+'?next='+encodeURIComponent(location.pathname+location.search+location.hash);
}

async function account() {
  const response=await fetch(appPath('/auth/session'),{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw new Error('无法确认登录状态，请刷新后重试');
  const session=await response.json();
  if(session.required&&!session.authenticated){location.replace(loginAddress());return;}
  document.getElementById('account-name').hidden=!session.required;
  document.getElementById('account-name').textContent=session.username||'';
  document.getElementById('logout').hidden=!session.required;
}

document.getElementById('logout').onclick=async(event)=>{
  const button=event.currentTarget;
  button.disabled=true;button.textContent=hasLiveConnection()?'正在保存听琴记录…':'正在退出…';
  try{
    window.dispatchEvent(new Event('pianoval:prepare-logout'));
    await stopLiveAndWait();
    const response=await fetch(appPath('/auth/logout'),{method:'POST',credentials:'same-origin'});
    if(!response.ok)throw new Error('退出失败，请稍后重试');
    location.replace(loginAddress());
  }catch(error){
    button.disabled=false;button.textContent='退出登录';
    const notice=document.getElementById('notice');notice.hidden=false;notice.classList.add('error');notice.textContent=error.message;
  }
};
window.addEventListener('pianoval:login-required',()=>{
  if(!hasLiveConnection())location.replace(loginAddress());
});
void account().catch(error=>{
  const notice=document.getElementById('notice');notice.hidden=false;notice.classList.add('error');notice.textContent=error.message;
});
