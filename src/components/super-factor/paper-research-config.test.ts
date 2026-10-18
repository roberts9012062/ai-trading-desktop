import {expect,it,vi} from 'vitest'
vi.mock('./use-mining-tasks',()=>({useMiningTasks:vi.fn()}))
import {buildSuperFactorMiningConfig} from './super-factor-page'
const form={searchFeatures:[0,46,48,50],symbol:'adausdt',timeframe:'15m',population:40,generations:30,max_depth:4,
 train_ratio:.7,walk_forward_folds:3,islands:1,origin:'local' as const,device:'cpu' as const,name:'test',
 enhanced:true,comboSuper:true,liveGate:true,data_channel:'okx',paperResearch:true}
it('preserves the actual super-factor form switch and the rest of the task configuration',()=>{
 expect(buildSuperFactorMiningConfig(form)).toMatchObject({economic_seed_research:true,search_feature_ids:form.searchFeatures,
   selection_v2:true,evolve_v2:true,combo_super:true,live_entry_gate:.3})
 expect(buildSuperFactorMiningConfig({...form,paperResearch:false}).economic_seed_research).toBe(false)
 expect(buildSuperFactorMiningConfig({...form,origin:'remote'}).economic_seed_research).toBeUndefined()
})
