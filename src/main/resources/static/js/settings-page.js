import {requestJSON} from './core/api-request.js';
import {presets,describePreset} from './industry/industry-profiles.js';
const el=id=>document.getElementById(id);
try{el('management-theme').value=localStorage.getItem('cam_theme')==='dark'?'dark':'light';document.documentElement.dataset.theme=el('management-theme').value;}catch{el('theme-feedback').textContent='无法读取本机显示偏好。';}
el('management-theme').onchange=()=>{document.documentElement.dataset.theme=el('management-theme').value;try{localStorage.setItem('cam_theme',el('management-theme').value);el('theme-feedback').textContent='已保存当前浏览器主题，其他已打开页面刷新后生效。';}catch{el('theme-feedback').textContent='本机保存失败；当前显示已改变，刷新后可能丢失。';}};
for(const preset of presets()){const p=document.createElement('p'),strong=document.createElement('strong');strong.textContent=preset.name+'：';p.append(strong,document.createTextNode(describePreset(preset.values).map(d=>d.label+' '+d.text).join('，')));el('process-presets').append(p);}
let generation=0;
async function refresh(){const request=++generation;el('refresh-capabilities').disabled=true;el('capabilities-error').hidden=true;
 try{const data=await requestJSON('/api/v2/capabilities');if(request!==generation)return;
  el('engine-rows').replaceChildren();el('runtime-limits').replaceChildren();
  const engines=[...data.engines,...(data.slittingEngine?[{...data.slittingEngine,modes:['一维分切'],shapes:['幅宽订单'],coordinateResolutionMm:data.slittingEngine.lengthResolutionMm,resolutionLabel:'长度 '}]:[])];
  for(const engine of engines){const tr=document.createElement('tr');for(const text of [engine.id,engine.available?'可用':'不可用',(engine.modes || []).join(' / ')+' · '+(engine.shapes || []).join(' / '),(engine.resolutionLabel || '')+(engine.coordinateResolutionMm ?? '未知')+' mm']){const td=document.createElement('td');td.textContent=text;tr.append(td);}el('engine-rows').append(tr);}
  for(const [key,label]of Object.entries({workers:'并行作业数',queueCapacity:'等待队列容量',maxStoredJobs:'归档作业上限',maxPieces:'矩形裁片上限',maxContourPieces:'轮廓裁片上限',maxTimeLimitSeconds:'单作业时限上限（秒）',maxRequestBytes:'请求大小上限（字节）'})){
   const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=data.limits?.[key]??'未知';el('runtime-limits').append(dt,dd);
  }
  el('capabilities-state').textContent='契约 '+data.schemaVersion+' · '+(data.features?.distributedWorkers?'支持多实例调度':'当前为本机调度')+' · 当前查询时间 '+new Date().toLocaleTimeString('zh-CN');
 }catch(error){if(request===generation){el('capabilities-error').textContent='能力读取失败：'+error.message+' 上次结果可能已过期。';el('capabilities-error').hidden=false;}}
 finally{if(request===generation)el('refresh-capabilities').disabled=false;}
}
el('refresh-capabilities').onclick=refresh;await refresh();
