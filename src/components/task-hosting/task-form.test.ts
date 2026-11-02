import {expect,it} from 'vitest';
import {nativeFormInput} from './task-form';
import {DEFAULT_FORECAST} from '@/lib/ai-forecast';

const fields={name:'fixture',symbol:'BTCUSDT',timeframe:'5m',credential_id:'server-credential',model_id:'server-model',position_mode:'fixed_margin',margin_per_trade:'100',leverage:'10',close_on_stop:'on',loss_cooldown_enabled:'on'};
it('builds preferences without any client task ID or execution state',()=>{
  const input=nativeFormInput(fields,'ai','fixture-request-0001');
  expect(input.symbol).toBe('btcusdt');expect(input).not.toHaveProperty('id');expect(input).not.toHaveProperty('owner');expect(input).not.toHaveProperty('state');
  expect(input.settings).toMatchObject({margin_per_trade:'100',leverage:10,close_on_stop:true});
});
it('uses the original forecast defaults and keeps the separate strategy kind',()=>{
  const input=nativeFormInput(fields,'forecast','fixture-request-0001');
  expect(input.kind).toBe('forecast');expect(input.strategy).toMatchObject({timeframes:['5m'],bar_count:DEFAULT_FORECAST.bar_count,indicators:DEFAULT_FORECAST.indicators});
});
it('fixed hand counts cannot silently fall back to a one-lot range',()=>{
  const input=nativeFormInput({...fields,position_mode:'fixed_qty',fixed_qty:'5'},'decision','fixture-request-0001');
  expect(input.settings).toMatchObject({margin_per_trade:'0',fixed_qty:5,qty_min:5,qty_max:5});
});
it('disabled stop policy remains an explicit preference and malformed imports are rejected',()=>{
  expect(nativeFormInput({...fields,close_on_stop:''},'ai','fixture-request-0001').settings.close_on_stop).toBe(false);
  expect(()=>nativeFormInput({...fields,strategy:'[]'},'shortline','fixture-request-0001')).toThrow();
});
