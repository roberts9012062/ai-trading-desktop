import {useState} from 'react';
import {DEFAULT_FORECAST} from '@/lib/ai-forecast';
import type {HostCredential} from '@/lib/taskhost-client';
import type {ModelInfo,NativeTaskInput} from '@/lib/taskhost-managed';

const field='w-full mt-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2';
const button='rounded border border-[var(--border)] px-3 py-2 disabled:opacity-40';
type Kind=NativeTaskInput['kind'];
const object=(raw:string)=>{const v=JSON.parse(raw||'{}') as unknown;if(!v||Array.isArray(v)||typeof v!=='object')throw new Error('导入内容必须是策略对象');return v as Record<string,unknown>;};

export function nativeFormInput(d:Record<string,FormDataEntryValue>,kind:Kind,request:string):NativeTaskInput{
  const position=String(d.position_mode||'fixed_margin'),timeframe=String(d.timeframe||'1m');
  const settings:Record<string,unknown>={side_mode:String(d.side_mode||'both'),position_mode:position,
    margin_per_trade:position==='fixed_qty'?'0':String(d.margin_per_trade||'100'),leverage:Number(d.leverage||10),
    margin_mode:String(d.margin_mode||'cross'),allocated_capital:String(d.allocated_capital||'0'),risk_style:String(d.risk_style||'balanced'),
    close_on_stop:d.close_on_stop==='on',loss_cooldown_enabled:d.loss_cooldown_enabled==='on',loss_cooldown_limit:Number(d.loss_cooldown_limit||2)};
  if(position==='fixed_qty'){const quantity=Number(d.fixed_qty||1);settings.fixed_qty=quantity;settings.qty_min=quantity;settings.qty_max=quantity;}
  if(d.max_hold_days)settings.max_hold_days=Number(d.max_hold_days);
  if(d.custom_prompt){settings.custom_prompt=String(d.custom_prompt);settings.custom_prompt_enabled=true;}
  Object.assign(settings,object(String(d.settings||'')));
  let strategy:Record<string,unknown>={};
  if(kind==='shortline')strategy=object(String(d.strategy||''));
  if(kind==='forecast')strategy={...DEFAULT_FORECAST,timeframes:[timeframe],bar_count:Number(d.bar_count||60),interval_minutes:Number(d.forecast_interval||5),direction_mode:d.side_mode==='long_only'?'long':d.side_mode==='short_only'?'short':'any',strategy:String(d.risk_style||'balanced'),horizon:String(d.forecast_horizon||'short'),...object(String(d.strategy||''))};
  const input:NativeTaskInput={request_id:request,name:String(d.name||''),kind,symbol:String(d.symbol||'').trim().toLowerCase(),timeframe,credential_id:String(d.credential_id||''),settings,strategy};
  if(kind!=='shortline')input.model_id=String(d.model_id||'');
  return input;
}

export function NativeTaskForm({requestID,models,credentials,disabled,onCreate,onError}:{requestID:string;models:ModelInfo[];credentials:HostCredential[];disabled:boolean;onCreate:(input:NativeTaskInput)=>Promise<boolean>;onError:(message:string)=>void}){
  const [kind,setKind]=useState<Kind>('ai'),[position,setPosition]=useState('fixed_margin'),[imported,setImported]=useState('');
  return <form className="grid gap-4 md:grid-cols-2 mt-6" onSubmit={e=>{
    e.preventDefault();const form=e.currentTarget;
    void(async()=>{try{const input=nativeFormInput(Object.fromEntries(new FormData(form)),kind,requestID);if(await onCreate(input)){form.reset();setImported('');}}catch{onError('策略或高级保护规则格式不正确，请检查导入内容。');}})();
  }}>
    <h3 className="md:col-span-2 font-semibold">在线新建任务</h3>
    <label>任务名称<input name="name" className={field} required maxLength={120}/></label>
    <label>交易方式<select value={kind} className={field} onChange={e=>{setKind(e.target.value as Kind);setImported('');}}><option value="ai">AI 自主交易</option><option value="decision">AI 决策（Jev）</option><option value="forecast">AI 预测交易</option><option value="shortline">短线策略</option></select></label>
    <label>品种<input name="symbol" defaultValue="btcusdt" className={field} required pattern="[A-Za-z0-9]{2,16}[uU][sS][dD][tT]"/></label>
    <label>周期<select name="timeframe" className={field}>{[['1m','1 分钟'],['5m','5 分钟'],['15m','15 分钟'],['30m','30 分钟'],['60m','1 小时'],['240m','4 小时'],['1d','1 天']].map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label>
    <label>交易账户<select name="credential_id" className={field} required><option value="">选择并在账户区完成验证</option>{credentials.filter(c=>c.venue==='okx').map(c=><option key={c.id} value={c.id}>{c.label||c.api_key_masked} · {c.demo?'模拟盘':'实盘'}</option>)}</select></label>
    {kind!=='shortline'&&<label>模型<select key={kind} name="model_id" className={field} required><option value="">选择已加密保存的模型</option>{models.filter(m=>kind==='decision'?m.kind==='jev':m.kind==='openai'||m.kind==='claude').map(m=><option key={m.id} value={m.id}>{m.name} · {m.model_id}</option>)}</select></label>}
    <label>方向<select name="side_mode" className={field}><option value="both">双向</option><option value="long_only">仅做多</option><option value="short_only">仅做空</option></select></label>
    <label>风险风格<select name="risk_style" className={field}><option value="balanced">均衡</option><option value="conservative">保守</option><option value="aggressive">激进</option></select></label>
    <label>仓位方式<select name="position_mode" className={field} value={kind==='shortline'?'fixed_margin':position} onChange={e=>setPosition(e.target.value)}><option value="fixed_margin">每笔固定保证金</option>{kind!=='shortline'&&<><option value="half">本次预算半仓</option><option value="full">本次预算全仓</option><option value="scale_in">按保证金分层加仓</option><option value="fixed_qty">兼容固定手数</option></>}</select></label>
    {position==='fixed_qty'&&kind!=='shortline'?<label>手数<input name="fixed_qty" className={field} type="number" defaultValue={1} min={1} max={10000} required/></label>:<label>每笔保证金（USDT）<input name="margin_per_trade" className={field} type="number" defaultValue={100} min="0.00000001" max="100000000" step="any" required/></label>}
    <label>杠杆<input name="leverage" className={field} type="number" defaultValue={10} min={1} max={100} required/></label>
    <label>保证金模式<select name="margin_mode" className={field}><option value="cross">全仓</option><option value="isolated">逐仓</option></select></label>
    <label>任务资金上限（USDT，0 为账户可用预算）<input name="allocated_capital" className={field} type="number" defaultValue={0} min={0} max={100000000} step="any" required/></label>
    <label>最长持仓天数（留空按周期默认）<input name="max_hold_days" className={field} type="number" min={1} max={365}/></label>
    <label className="flex gap-2 items-center"><input name="close_on_stop" type="checkbox" defaultChecked/>停止时按任务归属平仓</label>
    <label className="flex gap-2 items-center"><input name="loss_cooldown_enabled" type="checkbox" defaultChecked/>启用连续亏损冷静期</label>
    <label>连续亏损次数<input name="loss_cooldown_limit" className={field} type="number" defaultValue={2} min={1} max={10}/></label>
    {kind==='forecast'&&<><label>预测间隔（分钟）<input name="forecast_interval" className={field} type="number" min={5} max={30} defaultValue={5}/></label><label>分析 K 线数量<input name="bar_count" className={field} type="number" min={30} max={100} defaultValue={60}/></label><label>交易周期<select name="forecast_horizon" className={field}><option value="short">短期</option><option value="mid">中期</option><option value="long">长期</option></select></label></>}
    {kind==='ai'&&<label className="md:col-span-2">可选交易提示<textarea name="custom_prompt" className={field} rows={3} maxLength={2000}/></label>}
    {(kind==='shortline'||kind==='forecast')&&<details className="md:col-span-2" open={kind==='shortline'}><summary>{kind==='shortline'?'导入已研究的短线策略':'高级预测指标与多周期设置'}</summary><p className="text-xs my-2 text-[var(--text-muted)]">{kind==='shortline'?'使用客户端研究页导出的完整策略。服务器会验证研究记录、品种、周期和名义金额。':'默认沿用现有预测页的 MA / MACD。可导入完整预测设置。'}</p><input type="file" accept=".json,application/json" onChange={e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>256*1024){onError('策略文件过大');return;}void file.text().then(text=>{object(text);setImported(text);}).catch(()=>onError('无法读取策略文件'));}}/><textarea name="strategy" className={field+' font-mono text-sm'} rows={5} value={imported} onChange={e=>setImported(e.target.value)} required={kind==='shortline'} aria-label="完整策略设置"/></details>}
    <details className="md:col-span-2"><summary>高级保护规则（可选）</summary><p className="text-xs mt-2 text-[var(--text-muted)]">仅填写需要覆盖的完整保护设置；服务器会拒绝不支持的规则。</p><textarea name="settings" className={field+' font-mono text-sm'} rows={3} aria-label="高级保护规则" placeholder={'{"max_profit_pct":"20","max_loss_pct":"10"}'}/></details>
    <button className={button+' md:col-span-2'} disabled={disabled}>由服务器创建并同步到中心</button>
  </form>;
}
