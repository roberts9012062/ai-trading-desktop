import {beforeEach,expect,it,vi} from 'vitest'
const f=vi.hoisted(()=>({scope:'server:user-a',generation:1}))
vi.mock('./collection-config',()=>({collectionScope:()=>f.scope,collectionGeneration:()=>f.generation}))
import {captureOkxConnectivity,clearOkxConnectivity,okxConnectivityStatus,okxReadReceived,okxReadUnavailable} from './okx-connectivity'
beforeEach(()=>{f.scope='server:user-a';f.generation=1;clearOkxConnectivity()})
it('keeps independent stream and account failures until real successful reads arrive',()=>{const current=captureOkxConnectivity();okxReadUnavailable(current,'stream','direct');okxReadUnavailable(current,'account','direct');okxReadReceived(current,'market');expect(okxConnectivityStatus().warnings).toHaveLength(2);okxReadReceived(current,'stream');expect(okxConnectivityStatus().warnings).toEqual([{channel:'account',source:'direct'}]);okxReadReceived(current,'account');expect(okxConnectivityStatus().warnings).toEqual([])})
it('discards warnings and successes from a retired profile or key generation',()=>{const old=captureOkxConnectivity();f.scope='server:user-b';okxReadUnavailable(old,'account','direct');expect(okxConnectivityStatus().warnings).toEqual([]);const current=captureOkxConnectivity();okxReadUnavailable(current,'account','collection');f.generation++;okxReadReceived(current,'account');expect(okxConnectivityStatus().warnings).toHaveLength(1)})
