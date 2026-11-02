import {expect,it} from 'vitest';
import {localWorkerInput} from './worker-panel';

it('retains all explicitly configured model records for a multi-task standby account',()=>{
 const input=localWorkerInput({api_key:'fixture-exchange-key',secret:'fixture-exchange-secret',passphrase:'fixture-pass',demo:'on',model_record_id_0:'first-record',model_name_0:'AI',model_kind_0:'openai',base_url_0:'https://first.example',model_id_0:'first-model',model_key_0:'first-private-key',model_record_id_1:'second-record',model_name_1:'Decision',model_kind_1:'jev',base_url_1:'https://second.example',model_id_1:'second-model',model_key_1:'second-private-key'},2);
 expect(input.models.map(m=>[m.id,m.kind,m.api_key])).toEqual([['first-record','openai','first-private-key'],['second-record','jev','second-private-key']]);expect(input.exchange.demo).toBe(true);expect(input).not.toHaveProperty('owner_id');
});
it('shortline standby can omit all models without fabricating a model id',()=>{const input=localWorkerInput({api_key:'fixture',secret:'fixture',passphrase:'fixture'},1);expect(input.models).toEqual([]);expect(input.exchange.demo).toBe(false);});
