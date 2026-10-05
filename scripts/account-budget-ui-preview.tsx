/** Isolated actual creation forms. Every API is mocked, never places an order. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/app/globals.css'
import { CreateTaskDialog } from '@/components/ai-trading/form/create-task-dialog'
import { CreateQuantDialog } from '@/components/ai-trading/form/create-quant-dialog'
import { CreateHunterDialog } from '@/components/hunter/create-hunter-dialog'
import { useAuthStore } from '@/stores/auth'
import { useAITradingStore } from '@/stores/ai-trading'
import { useHunterStore } from '@/stores/hunter'
import type { AITradingTask } from '@/lib/ai-trading-api'
import type { User } from '@/types'

if (location.hostname !== '127.0.0.1' || location.port !== '5187') throw new Error('只允许隔离验收端口5187')
useAuthStore.setState({user: {id:'fixture', username:'隔离验收', role:'admin', trading_mode:'virtual'} as User, accessToken:'fixture-only'})
localStorage.setItem('access_token', 'fixture-only')
const submitted: unknown[] = []
Object.assign(window, {accountBudgetSubmitted: submitted})
useAITradingStore.setState({tasks:[], createTask: async payload => {
  submitted.push(payload)
  return {...payload, id:'fixture'} as AITradingTask
}})
useHunterStore.setState({groups:[], create: async config => { submitted.push(config) }})
globalThis.fetch = async (input, init) => {
  if (init?.method && init.method !== 'GET') throw new Error('禁止写外部API')
  const path = new URL(String(input), location.origin).pathname
  if (path === '/api/ai/models') return Response.json([{id:'fixture-model', display_name:'验收模型', provider_api_type:'openai', capabilities:['chat']}])
  if (path === '/api/ai-trading/funding-source') return Response.json({source:'site', balance_usdt:20000, site_balance_usdt:20000})
  if (path === '/api/profit-lock-templates') return Response.json([])
  if (path === '/api/hunter/symbols') return Response.json([])
  if (path === '/api/hunter/capabilities') return Response.json({supported_versions:['hunter-v3'], trading_mode:'virtual', execution_mode:'virtual', can_start:true})
  if (path === '/api/ai-anchor/indicators') return Response.json({indicators:{MA:[{key:'period',label:'周期',type:'int',default:20,min:1,max:100}]}})
  if (path.startsWith('/api/market/contracts')) return Response.json([])
  throw new Error('未授权API '+path)
}
function Preview() {
  const [mode, setMode] = useState<string|null>(null)
  return <main className="p-8"><h1>创建任务 · 隔离数据验收</h1><div className="flex gap-8 mt-8">
    <button onClick={()=>setMode('ai')}>验收 AI</button><button onClick={()=>setMode('quant')}>验收量化</button><button onClick={()=>setMode('hunter')}>验收猎手</button>
  </div>
  {mode==='ai' && <CreateTaskDialog open onClose={()=>setMode(null)}/>}
  {mode==='quant' && <CreateQuantDialog open onClose={()=>setMode(null)}/>}
  {mode==='hunter' && <CreateHunterDialog open onClose={()=>setMode(null)}/>}
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview/>)
