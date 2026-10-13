import {describe, expect, it} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {EvolutionResearchReport, FormulaEvidencePanel} from './evolution-research-report'

describe('measured evolution research', () => {
  it('separates AI hypothesis, tested rejection and solution', () => {
    const html = renderToStaticMarkup(<EvolutionResearchReport report={{round:1, recipe:{groups:[[9]],weights:[1],rationale:'动量假设'},
      audit:{passed:false,tests:[{name:'相对原式改进',passed:false}],reasons:['收益退化']},
      review:{decision:'rejected',hypothesis:'动量假设',facts:{validation_net_return:-.1},reasons:['收益退化'],next_steps:['缩短重复链'],limitations:['假设不代表实测收益']}}} />)
    expect(html).toContain('AI 研究判断')
    expect(html).toContain('自动审查未通过')
    expect(html).toContain('相对原式改进')
    expect(html).toContain('-10.00%')
    expect(html).toContain('缩短重复链')
    expect(html).not.toContain('全部验收通过')
  })
  it('discloses unavailable evidence rather than implying full coverage', () => {
    const html = renderToStaticMarkup(<FormulaEvidencePanel title="原式取证" evidence={{error:'历史缺失'}} />)
    expect(html).toContain('历史缺失')
    expect(html).not.toContain('封存不可见')
  })
})
