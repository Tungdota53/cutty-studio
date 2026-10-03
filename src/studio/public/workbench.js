'use strict';
window.Workbench = (() => {
  let api, state, selected, previewURL;
  const el = id => document.getElementById(id);
  const node = (tag,text,cls) => { const n=document.createElement(tag); n.textContent=text || ''; if(cls)n.className=cls; return n; };
  const send = data => api.send({...data,sessionId:api.session()});
  function refresh(){send({type:'get_workbench'});}
  function section(title){const box=node('section','', 'wb-section');box.append(node('h3',title));el('wb-content').append(box);return box;}
  function render(){
    if(!state)return;
    el('wb-content').replaceChildren();
    const c=state.context;
    const overview=section('Context được giữ');overview.append(node('p',`${(c.window || c.stats?.window || 0).toLocaleString('vi-VN')} token · ${c.groups?.length || 0} nhóm lượt · ${c.pins?.length || 0} ghi nhớ · ${c.attachments?.length || 0} tệp`));
    for(const [items,type] of [[c.pins || [],'unpin_context'],[c.attachments || [],'detach_context']])for(const item of items){const row=node('div','', 'wb-row');row.append(node('span',`${item.label || item.path} · ~${item.tokens || 0} token`));const remove=node('button','Bỏ','quiet-button');remove.onclick=()=>send({type,id:item.id});row.append(remove);overview.append(row);const content=node("details");content.append(node("summary","Xem nội dung nguồn"),node("pre",item.content || item.preview || ""));overview.append(content);}
    const form=node('form');const pin=node('textarea');pin.placeholder='Ghim yêu cầu, quyết định hoặc ràng buộc phải giữ khi nén';pin.required=true;const add=node('button','Ghim vào context','primary-button');form.append(pin,add);form.onsubmit=e=>{e.preventDefault();send({type:'pin_context',content:pin.value});};overview.append(form);
    const attach=node('form');const file=node('input');file.placeholder='Đường dẫn tệp trong dự án, ví dụ README.md';file.required=true;attach.append(file,node('button','Thêm tệp','quiet-button'));attach.onsubmit=e=>{e.preventDefault();send({type:'attach_context',path:file.value});};overview.append(attach);
    const details=node('details');details.append(node('summary','Các nguồn và lượt trong context'));for(const item of c.messages || [])details.append(node('p',`${item.role} · ~${item.tokens} token · ${item.preview || ''}`));for(const item of c.summarySources || [])details.append(node('p',typeof item==='string'?item:JSON.stringify(item)));overview.append(details);
    const recovery=section('Phục hồi phiên');const resume=node('button','Tiếp tục phiên gián đoạn','primary-button');resume.disabled=!state.resume?.resumable || api.busy();resume.onclick=()=>{el('workbench-dialog').close();api.resume();};recovery.append(node('p',state.resume?.uncertain?.length?`${state.resume.uncertain.length} thao tác chưa xác định kết quả; app giữ dấu vết và tránh phát lại.`:'Các kết quả công cụ đã hoàn tất được lưu để tiếp tục.'),resume);
    const undo=section('Checkpoint và hoàn tác');for(const cp of state.checkpoints || []){const button=node('button',`${cp.tool} · ${new Date(cp.createdAt).toLocaleString('vi-VN')} · ${cp.status}`,'wb-checkpoint');button.onclick=()=>send({type:'checkpoint_diff',id:cp.id});undo.append(button);if(cp.warnings?.length)undo.append(node("p",cp.warnings.join(" · ")));}if(!state.checkpoints?.length)undo.append(node('p','Checkpoint xuất hiện khi agent sửa tệp hoặc chạy lệnh.'));undo.append(node('div','', 'wb-checkpoint-detail'));undo.lastChild.id='wb-checkpoint-detail';
    const budget=section('Ngân sách mỗi agent / nhiệm vụ'),bf=node('form');
    const input=(label,value,numeric=true)=>{const field=node('label',label),box=node('input');if(numeric){box.type='number';box.min='0';box.step='any';}box.value=value ?? '';field.append(box);bf.append(field);return box;};
    const tokens=input('Token tối đa (0 = không giới hạn)',state.runBudget?.maxTokens || 0);tokens.step='1';
    const dollars=input('USD tối đa (0 = không giới hạn)',state.runBudget?.maxCostUSD || 0);
    const model=input('Model cần tính giá',api.config()?.model || '',false),price=state.modelRates?.[model.value];
    const incoming=input('USD / triệu token đầu vào',price?.inputPerMillion),outgoing=input('USD / triệu token đầu ra',price?.outputPerMillion),cached=input('USD / triệu token cache (có thể bỏ trống)',price?.cachedInputPerMillion);
    model.onchange=()=>{const rate=state.modelRates?.[model.value];incoming.value=rate?.inputPerMillion ?? '';outgoing.value=rate?.outputPerMillion ?? '';cached.value=rate?.cachedInputPerMillion ?? '';};
    bf.append(node('button','Lưu ngân sách','primary-button'));
    bf.onsubmit=e=>{e.preventDefault();const rates={...(state.modelRates || {})};if(incoming.value!==''||outgoing.value!==''||cached.value!==''){if(!model.value.trim()||incoming.value===''||outgoing.value==='')return api.toast('Nhập tên model và cả hai đơn giá vào/ra.');rates[model.value.trim()]={inputPerMillion:Number(incoming.value),outputPerMillion:Number(outgoing.value),...(cached.value!==''?{cachedInputPerMillion:Number(cached.value)}:{})};}send({type:'configure_budget',budget:{maxTokens:Number(tokens.value),maxCostUSD:Number(dollars.value)},rates});};
    budget.append(bf,node('p','Cảnh báo từ 80%; dừng trước lượt gọi tiếp theo khi hết ngân sách. Chi phí chưa biết nếu chưa nhập đơn giá.'));
    const usage=node('div');usage.id='wb-usage';budget.append(usage);const latest=new Map();for(const item of state.telemetry || [])latest.set(item.taskId || item.agentId || 'agent',item);for(const item of latest.values())usage.append(node('p',`${item.taskId || item.agentId || 'Agent'}: ${item.estimatedTokens?'~':''}${item.tokens || 0} token · ${item.costUSD==null?'chưa có giá':(item.costEstimated?'~':'')+Number(item.costUSD).toFixed(4)+' USD'} · ${Math.round((item.durationMs || 0)/1000)}s`));
    const mcp=section('Tìm công cụ MCP');const mf=node('form');const query=node('input');query.placeholder='Tìm theo nhiệm vụ hoặc tên công cụ';mf.append(query,node('button','Tìm công cụ','quiet-button'));mf.onsubmit=e=>{e.preventDefault();send({type:'get_mcp_tools',query:query.value});};mcp.append(mf);const tools=node('div');tools.id='wb-mcp-tools';mcp.append(tools);
  }
  function event(msg){
    if(msg.type==='progress_event'&&msg.eventType==='budget_update'&&state?.sessionId===msg.sessionId){state.telemetry=(state.telemetry || []).filter(item=>(item.taskId || item.agentId)!==(msg.taskId || msg.agentId));state.telemetry.push(msg);const usage=el('wb-usage');if(usage){usage.replaceChildren();for(const item of state.telemetry)usage.append(node('p',`${item.taskId || item.agentId || 'Agent'} · ${item.estimatedTokens?'~':''}${item.tokens} token · ${item.costUSD==null?'chưa có giá':Number(item.costUSD).toFixed(4)+' USD'} · ${Math.round(item.durationMs/1000)}s · ${item.warnings.join(' · ')}`));}}
    if(msg.type==='workbench_state'&&msg.sessionId===api.session()){state=msg;render();}
    if(msg.type==='budget_config'){api.toast('Đã lưu ngân sách cho các lượt chạy mới.');refresh();}
    if(msg.type==='checkpoint_detail'&&msg.sessionId===api.session()){
      selected=msg;const target=el('wb-checkpoint-detail');target.replaceChildren();const files=[];
      for(const file of msg.files || []){if(!file.changed)continue;const label=node('label');const box=node('input');box.type='checkbox';box.value=file.path;label.append(box,node('span',file.path));target.append(label);files.push(box);const diff=node('pre',`TRƯỚC\n${file.before || '(chưa có)'}\n\nSAU\n${file.after || '(đã xóa)'}`);target.append(diff);}
      const restore=node('button','Hoàn tác các tệp đã chọn','quiet-button');restore.disabled=api.busy();restore.onclick=()=>{const paths=files.filter(f=>f.checked).map(f=>f.value);if(paths.length)send({type:'restore_checkpoint',id:selected.id,files:paths});else api.toast('Chọn tệp cần hoàn tác.');};target.append(restore);
    }
    if(msg.type==='mcp_catalog'){const target=el('wb-mcp-tools');if(target){target.replaceChildren();const items=Array.isArray(msg.catalog)?msg.catalog:(msg.catalog.tools || []);for(const item of items)target.append(node('p',`${item.serverId || ''} · ${item.title || item.name || item.id} · ${item.readOnly?'chỉ đọc':'có thể thay đổi dữ liệu'}`));if(!items.length)target.append(node('p','Không có công cụ phù hợp.'));}}
    if(msg.type==='preview_ready'){previewURL=msg.url;el('inspector').hidden=true;window.TeamMap?.view('chat');el('preview-pane').hidden=false;el('web-preview').src=previewURL;el('preview-entry-label').textContent=msg.entry;el('preview-console').replaceChildren();}
    if(msg.type==='preview_changed'&&previewURL&&!el('preview-pane').hidden)el('web-preview').src=previewURL;
    if(msg.type==='run_end'&&el('workbench-dialog').open)refresh();
  }
  function init(options){api=options;el('workbench-button').onclick=()=>{api.ensureSession();el('workbench-dialog').showModal();el('wb-content').textContent='Đang tải…';refresh();};el('wb-refresh').onclick=refresh;el('preview-button').onclick=()=>el('preview-dialog').showModal();el('preview-form').onsubmit=e=>{e.preventDefault();send({type:'start_preview',entry:el('preview-entry').value});el('preview-dialog').close();};el('preview-close').onclick=()=>{send({type:'stop_preview'});el('web-preview').src='about:blank';el('preview-pane').hidden=true;};el('preview-reload').onclick=()=>{if(previewURL)el('web-preview').src=previewURL;};addEventListener('message',e=>{if(e.source!==el('web-preview').contentWindow||e.origin!=='null'||!e.data?.vibePreview)return;const row=node('p',`${e.data.kind}: ${String(e.data.text).slice(0,8000)}`);row.dataset.kind=e.data.kind;el('preview-console').append(row);while(el('preview-console').children.length>100)el('preview-console').firstChild.remove();});}
  return {init,event};
})();
