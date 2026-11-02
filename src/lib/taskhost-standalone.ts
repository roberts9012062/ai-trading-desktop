import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  enterStandalone,
  hostSession,
  type CenterAccount,
} from "./taskhost-client";

/** This flow contacts the center directly; no business-server credentials are used. */
export async function loginStandalone(key: string) {
  if (!isTauri())
    throw new Error("单机 Key 使用原生安全存储，请在桌面应用中使用");
  if (!/^ac_[A-Za-z0-9_-]{17,157}$/.test(key))
    throw new Error("请输入有效的 API VALUE COLLECTION Key");
  const checked = await invoke<{ permissions?: { user_id?: string } }>(
    "collection_key",
    { scope: "taskhost:login-probe", action: "test", key },
  );
  const user = checked.permissions?.user_id;
  if (!user) throw new Error("接口中心未确认用户身份");
  const scope = `taskhost:standalone:${user}`;
  await invoke("collection_key", { scope, action: "save", key });
  enterStandalone({ scope, centerUserID: user });
}
export async function standaloneAccounts(): Promise<{
  accounts: CenterAccount[];
}> {
  const session = hostSession();
  if (session?.mode !== "standalone") throw new Error("请先完成单机登录");
  const reply = await invoke<{
    code: number;
    data: CenterAccount[];
    msg?: string;
  }>("collection_http", {
    scope: session.scope,
    path: "/v1/execution/accounts",
    body: null,
  });
  if (hostSession() !== session) throw new Error("会话已变化");
  if (reply.code !== 200 || !Array.isArray(reply.data))
    throw new Error(reply.msg || "接口中心托管任务读取失败");
  return { accounts: reply.data };
}
/** Stop is the existing center account-wide control, never represented as a single-task stop. */
export async function stopStandaloneAccount(account: CenterAccount) {
  const session = hostSession();
  if (session?.mode !== "standalone") throw new Error("请先完成单机登录");
  const reply = await invoke<{ code: number; data: unknown; msg?: string }>(
    "collection_http",
    {
      scope: session.scope,
      path: "/v1/execution/stop-account",
      body: { account_id: account.account_id, expected_epoch: account.epoch },
    },
  );
  if (hostSession() !== session)
    throw new Error("会话已变化，请在原中心账户核对停止结果");
  if (reply.code !== 200)
    throw new Error(reply.msg || "中心未确认账户停止结果");
  return reply.data;
}
