import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {expect,it} from 'vitest'
import {PaperResearchSettings} from './paper-research-settings'
import {MiningFeatureSettings} from './mining-feature-settings'

it('separates the 64 primitive features from six paper families and twelve formulas',()=>{
 const ids=Array.from({length:64},(_,i)=>i)
 const html=renderToStaticMarkup(<><MiningFeatureSettings selected={ids} onChange={()=>{}}/><PaperResearchSettings selected={ids} enabled onChange={()=>{}}/></>)
 expect(html).toContain('基础特征（64/64）')
 expect(html).toContain('6 类 / 12 个方向公式')
 expect(html).toContain('订单流价格残差')
 expect(html).toContain('资金拥挤价格残差')
 expect(html).not.toContain('70/70')
})

it('reports selected-feature compatibility without promising actual market-data coverage',()=>{
 const html=renderToStaticMarkup(<PaperResearchSettings selected={[0,46,48,50]} enabled={false} disabled onChange={()=>{}}/>)
 expect(html).toContain('按已选基础特征可构造 3 类')
 expect(html).toContain('真实数据覆盖由引擎检查')
 expect(html).toContain('disabled')
 expect(html).not.toContain('checked=""')
})
