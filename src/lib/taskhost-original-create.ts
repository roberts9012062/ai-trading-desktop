/** Original desktop forms submit preferences; the authenticated server owns task identity. */
import type {AITradingTask,CreateTaskPayload} from './ai-trading-api'
import type {AIModel} from '@/types'
import {hostRequest,hostSession,type HostSession,type HostCredential} from './taskhost-client'
import {createManagedTask,controlExistingTask,type NativeTaskInput,type ManagedTask,type ModelInfo} from './taskhost-managed'
import {verifyHostedAccount} from './taskhost-account'

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const flights=new WeakSet<HostSession>()
function decimal(value:unknown):string|null{
 if(value===null)return null
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('金额或保护比例无效，请检查原任务参数')
 const text=String(value);if(!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text))throw new Error('金额精度超出服务器支持范围');return text
}
export function originalTaskInput(payload:CreateTaskPayload,request:string):NativeTaskInput{
 const p=structuredClone(payload),params=(p.strategy_params??{}) as Record<string,unknown>,strategy=p.strategy_type||'ai'
 if(typeof params!=='object'||params===null||Array.isArray(params))throw new Error('策略参数必须是完整配置对象')
 if(p.auto_start!==undefined&&typeof p.auto_start!=='boolean')throw new Error('开始选项无效，尚未提交任务')
 if(p.funding_source&&p.funding_source!=='live')throw new Error('服务器托管任务必须使用明确选择的交易所账户，不能改用站内资金')
 const forecast=strategy==='ai'&&params.mode==='forecast'
 if(!uuid.test(p.host_credential_id||''))throw new Error('请选择当前服务器上的交易账户')
 if(p.icon)throw new Error('当前服务器尚未支持任务自定义图标，请清除图标后创建；不会忽略此设置')
 if(p.loss_cooldown_state)throw new Error('新建任务不能导入旧运行状态，请使用原策略参数重新创建')
 if(!forecast&&p.extra_timeframes?.length)throw new Error('当前服务器尚未支持 AI 实时交易的附加周期，不会忽略多周期设置')
 if(p.eval_interval_sec!=null)throw new Error('当前服务器尚未支持原量化分析间隔，不会改为其他执行频率')
 let kind:NativeTaskInput['kind'],body:Record<string,unknown>
 if(forecast){kind='forecast';if(Object.keys(params).some(k=>!['mode','forecast'].includes(k))||!params.forecast||typeof params.forecast!=='object')throw new Error('预测策略配置不完整');body=params.forecast as Record<string,unknown>}
 else if(strategy==='ai'||strategy==='decision'){
   if(Object.keys(params).length)throw new Error('当前服务器尚未实现此参考因子或量化决策配置，不会丢弃策略参数后创建')
   kind=strategy;body={}
 }else if(strategy==='shortline_factor'&&params.shortline&&typeof params.shortline==='object'){
   if(Object.keys(params).some(k=>k!=='shortline'))throw new Error('短线策略包含未支持参数，请使用已验证的完整短线配置')
   kind='shortline';body=params.shortline as Record<string,unknown>
 }else throw new Error('当前服务器尚未支持这类原量化策略或缺少完整短线验证配置，不会改成其他策略创建')
 if(kind!=='shortline'&&!uuid.test(p.model_row_id||''))throw new Error('请选择当前服务器已保存的 AI 模型')
 if(kind==='shortline'&&p.model_row_id)throw new Error('短线策略不使用模型，不会忽略所选模型')
 const settings:Record<string,unknown>={}
 for(const key of ['symbol_name','side_mode','position_mode','leverage','margin_mode','capital_usage_min_pct','capital_usage_max_pct','risk_style','fixed_qty','qty_min','qty_max','close_rules','stop_rules','loss_cooldown_enabled','loss_cooldown_limit','close_on_stop','custom_prompt_enabled','ai_bars_limit','decision_interval_sec'] as const)if(p[key]!==undefined)settings[key]=p[key]
 for(const key of ['margin_per_trade','allocated_capital','max_profit_pct','max_loss_pct'] as const)if(p[key]!==undefined)settings[key]=decimal(p[key])
 if(p.max_hold_days!=null)settings.max_hold_days=p.max_hold_days
 if(p.custom_prompt!=null)settings.custom_prompt=p.custom_prompt
 return {request_id:request,name:p.name,kind,symbol:p.symbol,timeframe:p.timeframe,credential_id:p.host_credential_id!,...(kind==='shortline'?{}:{model_id:p.model_row_id!}),strategy:body,settings}
}
export async function originalHostModels():Promise<AIModel[]>{
 const session=hostSession();if(session?.mode!=='server')return []
 const out=await hostRequest<{models:ModelInfo[]}>('/api/v1/models')
 if(hostSession()!==session||!Array.isArray(out.models))throw new Error('服务器模型列表未确认')
 return out.models.map(m=>({id:m.id,user_id:session.ownerID,provider_id:m.id,model_id:m.model_id,display_name:m.name,is_multimodal:false,is_custom:true,capabilities:m.kind==='jev'?['decision']:[],created_at:'',provider_name:m.name,provider_api_type:m.kind}))
}
export function notifyHostedCreation(message:string){if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('taskhost-tasks-changed',{detail:{message}}))}
export async function createOriginalHostedTask(payload:CreateTaskPayload):Promise<AITradingTask>{
 const session=hostSession();if(session?.mode!=='server')throw new Error('创建任务必须连接并登录服务器，单机模式不能创建任务')
 if(flights.has(session))throw new Error('任务正在提交，请等待原请求结果，不会重复创建')
 const input=originalTaskInput(payload,crypto.randomUUID())
 flights.add(session)
 try{
   const accounts=await hostRequest<{credentials:HostCredential[]}>('/api/v1/credentials')
   if(hostSession()!==session)throw new Error('服务器或本地配置已变化，请重新打开创建弹窗')
   const selected=accounts.credentials?.find(a=>a.id===input.credential_id&&a.venue==='okx')
   if(!selected)throw new Error('所选账户已不在当前服务器，请重新选择')
   let modelName=input.kind==='shortline'?'短线':''
   if(input.model_id){const models=await originalHostModels();if(hostSession()!==session)throw new Error('服务器已变化');const model=models.find(m=>m.id===input.model_id);if(!model||(input.kind==='decision'?model.provider_api_type!=='jev':!['openai','claude'].includes(model.provider_api_type)))throw new Error('所选模型不在当前服务器或类型不匹配');modelName=model.display_name}
   if(!input.name.trim())input.name=Array.from(`${modelName}·${payload.symbol_name||payload.symbol}·${payload.timeframe}`).slice(0,120).join('')
   try{await verifyHostedAccount(selected)}catch{throw new Error('所选账户验证未确认，请核对服务器的 API Collection Key 与 OKX 凭据。尚未提交任务。')}
   if(hostSession()!==session)throw new Error('服务器或本地配置已变化，尚未提交任务')
   const task=await createManagedTask(input)
   if(hostSession()!==session)throw new Error('创建结果属于原服务器，请在原连接核对任务；不会重新创建')
   let note=`任务已由服务器创建并同步，注册状态：${task.registration}。`
   if(payload.auto_start){
     if(task.registration!=='acknowledged')note+='中心注册尚未确认，尚未发送开始请求。请核对后手动开始。'
     else try{await controlExistingTask(task.account_id,'','resume',task.id);note+='已提交原表单的开始请求，实际运行仍受服务器执行开关、中心租约与风险核验约束。'}
     catch{note+='任务创建已确认，开始结果未确认。请核对中心状态后操作；不会重新创建或重试开始。'}
   }
   notifyHostedCreation(note)
   return projection(task,payload,session.ownerID,note)
 }finally{flights.delete(session)}
}
function projection(task:ManagedTask,p:CreateTaskPayload,owner:string,note:string):AITradingTask{
 return {...p,id:task.id,user_id:owner,name:task.name,model_row_id:task.model_id||null,model_id:null,model_display_name:null,provider_name:null,fixed_qty:p.fixed_qty??1,max_hold_days:p.max_hold_days??undefined,status:task.status,equity_baseline:0,last_run_at:null,next_bar_ts:null,last_bar_time:null,started_at:null,paused_at:null,stopped_at:null,note,created_at:task.created_at||'',updated_at:task.updated_at||'',cash_delta:null,position_sync_status:'unavailable',can_edit:false,can_edit_rules:false}
}
