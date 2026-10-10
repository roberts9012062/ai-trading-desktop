/** NTP midpoint estimate excludes server processing time. Treating response
 * arrival as server send time backdates every sample by response latency. */
export function clockOffset(sent:number,received:number,serverSent:number,serverReceived?:number):number {
  if(serverReceived===undefined||!Number.isFinite(serverReceived)||serverReceived>serverSent)return serverSent-received
  const network=Math.max(0,received-sent-(serverSent-serverReceived))
  return serverSent-received+network/2
}
