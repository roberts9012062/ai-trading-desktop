import {it,expect,vi} from 'vitest'
const fixture=vi.hoisted(()=>({queries:[] as Record<string,unknown>[],page:0}))
vi.mock('./collection-config',()=>({COLLECTION_BASE:'https://lium.eu.org',collectionGeneration:()=>0,collectionRequest:async(path:string,body?:Record<string,unknown>)=>{
  if(body){fixture.queries.push(body);return {url:'/edge/data?ticket=test'}}
  const count=Number(fixture.queries.at(-1)?.count),page=fixture.page++
  return {records:Array.from({length:count},(_,i)=>({timestamp:1792309500-(page*500+i)*60,open:100,high:101,low:99,close:100,volume:1,closed:true})),ticks:[],quotes:[],meta:{}}
}}))
import {collectionKlines} from './collection-api'
it('fulfills larger chart requests through bounded pages instead of silently truncating to 500',async()=>{
  const result=await collectionKlines('btcusdt','1m',{limit:501})
  expect(result.bars).toHaveLength(501)
  expect(fixture.queries.map(q=>q.count)).toEqual([500,1])
  expect(Number(fixture.queries[1].end)).toBeLessThan(1792309500-499*60)
})
