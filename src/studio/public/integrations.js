'use strict';
window.ProjectSetup=(()=>{
  let api;
  const el=id=>document.getElementById(id),node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text || '';return n;};
  function event(msg){
    if(msg.type==='integration_progress'){el('integration-status').textContent=msg.message;el('run-text').textContent=msg.message;return;}
    if(msg.type==='integration_state'){
      el('integration-auto').checked=msg.enabled;el('integration-auto').disabled=false;el('integration-sync').disabled=false;
      const target=el('integration-results');target.replaceChildren();
      const project=msg.plan?.project;if(project)target.append(node('p','Phát hiện: '+[...project.files,...project.dependencies].join(', ')));
      for(const item of [...(msg.plan?.skills || []),...(msg.plan?.mcp || [])]){const card=node('section');card.className='wb-section';card.append(node('h3',item.name),node('p',item.reason || 'Gán cho vai: '+item.roles.join(', ')));const link=node('a','Xem nguồn');link.href=item.url?.startsWith('https://github.com/')?item.url:item.source || `https://github.com/${item.repository}`;link.target='_blank';link.rel='noreferrer';card.append(link);if(item.commit)card.append(node('p',`Commit ${item.commit.slice(0,12)} · ${item.license}`));target.append(card);}
      for(const result of msg.report?.results || [])target.append(node('p',`${result.status} · ${result.id}: ${result.message}`));
      for(const server of msg.report?.connections || [])target.append(node('p',`MCP ${server.id}: ${server.status} · ${server.toolCount} công cụ${server.error?' · '+server.error:''}`));
      el('integration-status').textContent=msg.report?'Đã xử lý các nguồn; xem kết quả và trạng thái từng kết nối.':'Sẵn sàng phân tích dự án. Khi bật tự động, app thiết lập trước lượt làm việc đầu tiên hoặc khi công nghệ thay đổi.';
    }
    if(msg.type==='error'&&el('integration-dialog').open){el('integration-status').textContent=msg.message;el('integration-sync').disabled=false;el('integration-auto').disabled=false;}
  }
  function init(options){api=options;el('integration-stop').onclick=()=>api.send({type:'stop'});el('integration-button').onclick=()=>{el('integration-dialog').showModal();api.send({type:'get_integrations'});};el('integration-auto').onchange=()=>{el('integration-auto').disabled=true;if(!api.send({type:'configure_integrations',enabled:el('integration-auto').checked}))el('integration-auto').disabled=false;};el('integration-sync').onclick=()=>{el('integration-sync').disabled=true;el('integration-status').textContent='Đang tải và thiết lập…';if(!api.send({type:'sync_integrations'}))el('integration-sync').disabled=false;};}
  return {event,init};
})();
