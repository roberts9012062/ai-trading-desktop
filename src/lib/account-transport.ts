/** Account source is explicit. Standalone never depends on the business server. */
export function serverAccountMode():boolean {
  try{return localStorage.getItem('atd_account_transport')==='server'}catch{return false}
}
export function setAccountTransport(mode:'standalone'|'server'):void {
  localStorage.setItem('atd_account_transport',mode)
}
