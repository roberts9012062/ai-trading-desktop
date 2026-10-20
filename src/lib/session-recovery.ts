/** Cached identity permits local access, never server task creation/approval. */
export function keepLocalSession(error:unknown,knownUser:boolean,nativeDesktop:boolean):boolean {
  const status=(error as {status?:number}|null)?.status
  return nativeDesktop&&knownUser&&status!==401&&status!==403
}
