import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const policy=vi.hoisted(()=>({server:false}))
vi.mock('./desktop-routing',()=>({ensureDesktopRouting:async()=>{},isServerMode:()=>policy.server}))
import { resetSnippetRest, snippetKlines, withSnippetRead } from './snippet-rest'
beforeEach(()=>{resetSnippetRest();policy.server=false;vi.useFakeTimers()})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
it('falls back and cools down for 60 seconds after native 50011',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({code:'50011',data:[]}),{status:429}))
  vi.stubGlobal('fetch',fetch)
  const fallback=vi.fn().mockResolvedValue({symbol:'btcusdt',period:'1m',bars:[],has_more:false})
  const load=()=>snippetKlines('btcusdt','1m')
  await withSnippetRead('first',load,fallback)
  await vi.advanceTimersByTimeAsync(16000)
  await withSnippetRead('second',load,fallback)
  expect(fetch).toHaveBeenCalledTimes(1);expect(fallback).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(45000)
  fetch.mockResolvedValue(new Response(JSON.stringify({code:'0',data:[]})))
  await withSnippetRead('third',load,fallback)
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('deduplicates native reads and protects cached data from consumer mutation',async()=>{
  const load=vi.fn(async()=>({bars:[{close:1}]}));const fallback=vi.fn(async()=>({bars:[{close:0}]}))
  const [a,b]=await Promise.all([withSnippetRead('same',load,fallback),withSnippetRead('same',load,fallback)])
  a.bars[0].close=99
  expect(b.bars[0].close).toBe(1)
  expect((await withSnippetRead('same',load,fallback)).bars[0].close).toBe(1)
  expect(load).toHaveBeenCalledTimes(1);expect(fallback).not.toHaveBeenCalled()
})
it('force-server policy bypasses native cache immediately',async()=>{
  const load=vi.fn().mockResolvedValue('native'),fallback=vi.fn().mockResolvedValue('server')
  expect(await withSnippetRead('policy',load,fallback)).toBe('native')
  policy.server=true
  expect(await withSnippetRead('policy',load,fallback)).toBe('server')
  expect(load).toHaveBeenCalledTimes(1)
})
it('converts daily Beijing pagination cursor and never sends credentials',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({code:'0',data:[]})));vi.stubGlobal('fetch',fetch)
  await snippetKlines('btcusdt','1d',{endTime:'2026-10-01',limit:240})
  const [url,init]=fetch.mock.calls[0]
  expect(new URL(url).searchParams.get('after')).toBe(String(Date.parse('2026-10-01T00:00:00+08:00')))
  expect(new URL(url).searchParams.get('limit')).toBe('100');expect(init.headers).toBeUndefined()
})
