import { expect,it } from 'vitest'
import { RefreshCoordinator } from './refresh-coordinator'
it('queues a fresh read when an update arrives during a shared read',async()=>{
 const c=new RefreshCoordinator();let release!:()=>void,calls=0
 const read=async()=>{calls++;if(calls===1)await new Promise<void>(r=>{release=r})}
 const a=c.run('a',read);await Promise.resolve()
 const b=c.run('a',read,true)
 expect(a).toBe(b);release();await b;expect(calls).toBe(2)
 await c.run('a',read);expect(calls).toBe(3)
})
it('separates account keys and releases a failed read',async()=>{
 const c=new RefreshCoordinator();let release!:()=>void
 const old=c.run('old',()=>new Promise<void>(r=>{release=r}));await Promise.resolve()
 let calls=0;await c.run('new',async()=>{calls++});expect(calls).toBe(1)
 release();await old
 await expect(c.run('new',async()=>{throw new Error('offline')})).rejects.toThrow('offline')
 await c.run('new',async()=>{calls++});expect(calls).toBe(2)
})
