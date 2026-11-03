/** Account source is explicit. Standalone never depends on the business server. */
import {desktopSessionUsesTaskHost} from './desktop-login-session'
export function serverAccountMode():boolean {
  if(desktopSessionUsesTaskHost())return false
  try{return localStorage.getItem('atd_account_transport')==='server'}catch{return false}
}
export function setAccountTransport(mode:'standalone'|'server'):void {
  localStorage.setItem('atd_account_transport',mode)
}
