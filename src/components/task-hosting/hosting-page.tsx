import { useEffect, useState, useSyncExternalStore } from "react";
import {invoke,isTauri} from '@tauri-apps/api/core';
import { Link, useNavigate } from "react-router-dom";
import {
  hostSession,
  onHostSessionChange,
  restoreHostSession,
  logoutHost,
  hostRequest,
  type HostedTask,
  type HostCredential,
  type CenterAccount,
} from "@/lib/taskhost-client";
import {
  standaloneAccounts,
  stopStandaloneAccount,
	 saveOnlineStandbyKey,
} from "@/lib/taskhost-standalone";
import {readCenterSnapshot,syncCenterSnapshot,type CenterSnapshotInfo} from '@/lib/taskhost-snapshot';
import {SnapshotPanel} from './snapshot-panel';
import {readVerifiedAccount,verifyHostedAccount,type VerifiedAccountInfo} from '@/lib/taskhost-account';
import {ManagedPanel} from './managed-panel';
import {AccountPanel} from './account-panel';
import {ClientSyncPanel} from './client-sync-panel';
import {clientSyncStatus,onClientSyncChange} from '@/lib/taskhost-client-sync';

const field =
  "w-full mt-2 p-2.5 rounded border border-[var(--border)] bg-[var(--bg-primary)]";
const button =
  "rounded border border-[var(--border)] px-4 py-2 disabled:opacity-40";
export default function HostingPage() {
  const clientSync=useSyncExternalStore(onClientSyncChange,clientSyncStatus,clientSyncStatus);
  const session = useSyncExternalStore(
      onHostSessionChange,
      hostSession,
      () => null,
    ),
    navigate = useNavigate();
  const [ready, setReady] = useState(false),
    [tasks, setTasks] = useState<HostedTask[]>([]),
    [credentials, setCredentials] = useState<HostCredential[]>([]),
    [accounts, setAccounts] = useState<CenterAccount[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [centerKey, setCenterKey] = useState("");

  const [checkpointAvailable,setCheckpointAvailable]=useState(false);
  const [snapshots,setSnapshots]=useState<Record<string,CenterSnapshotInfo>>({});
  const [accountVerificationAvailable,setAccountVerificationAvailable]=useState(false);
  const [verifiedAccounts,setVerifiedAccounts]=useState<Record<string,VerifiedAccountInfo>>({});
  useEffect(() => {
    restoreHostSession();
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready && !session) navigate("/login", { replace: true });
  }, [ready, session, navigate]);
  async function refresh() {
    const owner = hostSession();
    if (!owner) return;
    if (owner.mode === "standalone") {
      const out = await standaloneAccounts();
      if (hostSession() !== owner) return;
      setAccounts(out.accounts);
      setTasks([]);
      setCredentials([]);
    } else {
      const [t, c, capabilities] = await Promise.all([
        hostRequest<{ tasks: HostedTask[] }>("/api/v1/tasks"),
        hostRequest<{ credentials: HostCredential[] }>("/api/v1/credentials"),
        hostRequest<{center_checkpoint_mirror?:boolean;center_account_verification?:boolean}>("/api/v1/capabilities"),
      ]);
      if (hostSession() !== owner) return;
      setTasks(t.tasks);
      setCredentials(c.credentials);
      setCheckpointAvailable(capabilities.center_checkpoint_mirror===true);
      setAccountVerificationAvailable(capabilities.center_account_verification===true);
      setVerifiedAccounts(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>c.credentials.some(credential=>credential.id===id))));
    }
  }
  async function run(action: () => Promise<void>) {
    const owner=hostSession();
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      if(hostSession()===owner)setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      if(hostSession()===owner)setBusy(false);
    }
  }
  useEffect(() => {
    setTasks([]);
    setCredentials([]);
    setAccounts([]);
    setSnapshots({});
    setCheckpointAvailable(false);
    setVerifiedAccounts({});
    setAccountVerificationAvailable(false);
    if (session) void run(refresh);
  }, [session]); // Each identity owns its own response and view.
  useEffect(()=>{if(session?.mode==='server'&&clientSync.syncedAt)void run(refresh)},[session,clientSync.syncedAt]);
  if (!session) return <div className="p-6">正在读取连接…</div>;
  const standalone = session.mode === "standalone";
  async function credential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      data = Object.fromEntries(new FormData(form));
    await run(async () => {
      await hostRequest("/api/v1/credentials", {
        method: "POST",
        body: JSON.stringify({ ...data, demo: data.demo === "on" }),
      });
      form.reset();
      await refresh();
      setMessage("交易所凭证已加密保存。尚未授予策略执行权限。");
    });
  }
  return (
    <main className="mx-auto max-w-6xl p-6 md:p-10 text-[var(--text-primary)]">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border)] pb-6 mb-6">
        <div>
          <p className="text-xs tracking-widest text-emerald-500">
            CYCLEPILOT / TASK HOST
          </p>
          <h1 className="text-2xl font-semibold mt-2">任务托管</h1>
          <p className="text-sm text-[var(--text-muted)] mt-2">
            {standalone ? "单机模式 · 直连接口中心" : session.origin}
          </p>
        </div>
        <div className="flex gap-3">
          <button
            className={button}
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            刷新
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => void run(async()=>{
              if(isTauri())await invoke('taskhost_go_shutdown');
              logoutHost();
              navigate("/login", { replace: true });
            })}
          >
            断开连接
          </button>
        </div>
      </header>
      {message && (
        <p
          role="status"
          className="mb-5 rounded border border-amber-500/30 bg-amber-500/10 p-4 text-sm break-words"
        >
          {message}
        </p>
      )}
      {!standalone&&<ClientSyncPanel/>}
      <ManagedPanel key={session.mode==='server'?`server:${session.origin}:${session.ownerID}`:`standalone:${session.scope}`} credentials={credentials} accounts={accounts}/>
      <div className="mb-7 rounded border border-[var(--border)] p-4 text-sm text-[var(--text-muted)]">
        {standalone
          ? "单机模式仅访问服务器曾签发的托管任务，不提供新建任务。操作结果以中心最新状态为准。"
          : "新建能力由在线服务器明确提供。旧暂存记录仅供核对；新任务请使用 Go 原生任务入口。"}
      </div>
      {!standalone && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold">API VALUE COLLECTION 同步</h2>
          <form
            className="mt-3 flex flex-wrap gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const owner=hostSession();
                const key=centerKey.trim();
                const binding=await hostRequest<{center_user_id:string}>("/api/v1/collection", {
                  method: "POST",
                  body: JSON.stringify({ collection_key: key }),
                });
                if(hostSession()!==owner)return;
                setCenterKey("");
                setVerifiedAccounts({});
                const out = await hostRequest<{ accounts: CenterAccount[] }>(
                  "/api/v1/collection/accounts",
                );
                if(hostSession()!==owner)return;
                setAccounts(out.accounts);
                if(isTauri()&&owner){
                  await saveOnlineStandbyKey(key,binding.center_user_id,owner);
                  setMessage("中心已绑定，本机已加密保存同一中心身份。请配置并启动备用进程，再由中心核对故障接管资格。");
                }else setMessage("中心 Key 已加密保存，已读取已有托管任务。");
              });
            }}
          >
            <input
              className={field + " max-w-lg !mt-0"}
              type="password"
              value={centerKey}
              onChange={(e) => setCenterKey(e.target.value)}
              placeholder="API VALUE COLLECTION Key（ac_…）"
              aria-label="接口中心 Key"
              autoComplete="off"
              required
            />
            <button className={button} disabled={busy}>
              绑定并读取已有任务
            </button>
          </form>
          <button
            className={button + " mt-3"}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const out = await hostRequest<{ accounts: CenterAccount[] }>(
                  "/api/v1/collection/accounts",
                );
                setAccounts(out.accounts);
              })
            }
          >
            刷新中心任务
          </button>
        </section>
      )}
      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-4">中心已有托管任务</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            尚未读取到托管账户。请验证中心 Key、套餐与服务器任务同步状态。
          </p>
        ) : (
          accounts.map((account) => (
            <div
              key={account.account_id}
              className="mb-5 border border-[var(--border)] rounded p-4"
            >
              <div className="flex flex-wrap justify-between gap-3">
                <p className="font-mono text-xs break-all">
                  账户 {account.account_id.slice(0, 16)}… · epoch{" "}
                  {account.epoch} · {account.role || "无执行器"}
                </p>
                {standalone && (
                  <button
                    className={button + " text-amber-500"}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await stopStandaloneAccount(account);
                        await refresh();
                        setMessage(
                          "中心已确认该账户停止。已有持仓不会因此自动平仓，请核对持仓和未确认订单。",
                        );
                      })
                    }
                  >
                    停止此账户全部任务
                  </button>
                )}
              </div>
              {account.recovery_required && (
                <p className="text-amber-500 text-xs mt-2">
                  账户需要恢复核对，禁止直接启动新执行器。
                </p>
              )}
              {!standalone && <SnapshotPanel available={checkpointAvailable} busy={busy} info={snapshots[account.account_id]}
                onSync={()=>void run(async()=>{const owner=hostSession();const info=await syncCenterSnapshot(account.account_id);if(hostSession()!==owner)return;setSnapshots(previous=>({...previous,[account.account_id]:info}));setMessage('中心检查点已完整读取并加密保存。尚未取得执行权，不会自动启动任务。');})}
                onRead={()=>void run(async()=>{const owner=hostSession();const info=await readCenterSnapshot(account.account_id);if(hostSession()!==owner)return;setSnapshots(previous=>({...previous,[account.account_id]:info}));})} />}
              <div className="overflow-x-auto">
                <table className="w-full text-sm mt-4">
                  <thead>
                    <tr className="text-left text-[var(--text-muted)]">
                      <th className="py-2">任务</th>
                      <th>类型</th>
                      <th>状态</th>
                      <th>版本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.tasks.map((task) => (
                      <tr
                        key={task.authority + ":" + task.task_id}
                        className="border-t border-[var(--border)]"
                      >
                        <td className="py-3">
                          {task.config?.task?.name || task.task_id}
                        </td>
                        <td>
                          {task.config?.task?.strategy_type || "已授权策略"}
                        </td>
                        <td>{task.desired_state}</td>
                        <td>{task.revision}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </section>
      {!standalone && (
        <>
          <section className="mb-10">
            <h2 className="text-lg font-semibold mb-4">服务器暂存任务</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[var(--text-muted)]">
                    <th className="py-2">名称</th>
                    <th>类型</th>
                    <th>品种</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr
                      className="border-t border-[var(--border)]"
                      key={task.id}
                    >
                      <td className="py-3">{task.name}</td>
                      <td>{task.kind}</td>
                      <td>{task.symbol}</td>
                      <td>
                        {task.status === "staged"
                          ? "已暂存，未执行"
                          : task.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!tasks.length && (
              <p className="text-sm text-[var(--text-muted)] mt-4">
                暂无暂存任务。
              </p>
            )}
          </section>
          <div className="grid md:grid-cols-2 gap-7">
            <section className="rounded border border-[var(--border)] p-5">
              <h2 className="text-lg font-semibold">交易所凭证</h2>
              <p className="text-xs text-[var(--text-muted)] mt-2 mb-4">
                凭证加密保存，只返回掩码。请使用禁止提币的 Key；若启用 IP 白名单，请按中心私有网关的实际出口配置。
              </p>
              {credentials.map((c) => (
                <AccountPanel key={c.id} credential={c} available={accountVerificationAvailable} busy={busy} info={verifiedAccounts[c.id]}
                  onVerify={()=>void run(async()=>{const owner=hostSession();const info=await verifyHostedAccount(c);if(hostSession()!==owner)return;setVerifiedAccounts(previous=>({...previous,[c.id]:info}));setMessage('账户身份已验证并加密保存。尚未注册任务或取得执行权，不会自动交易。');})}
                  onRead={()=>void run(async()=>{const owner=hostSession();const info=await readVerifiedAccount(c);if(hostSession()!==owner)return;setVerifiedAccounts(previous=>({...previous,[c.id]:info}));})}/>
              ))}
              <form onSubmit={credential} className="space-y-3">
                <label className="block text-sm">
                  交易所
                  <select name="venue" className={field}>
                    <option value="okx">OKX</option>
                    <option value="binance">Binance</option>
                    <option value="gate">Gate</option>
                  </select>
                </label>
                <label className="block text-sm">
                  API Key
                  <input
                    name="api_key"
                    className={field}
                    type="password"
                    autoComplete="off"
                    required
                    minLength={8}
                  />
                </label>
                <label className="block text-sm">
                  Secret
                  <input
                    name="secret"
                    className={field}
                    type="password"
                    autoComplete="off"
                    required
                    minLength={8}
                  />
                </label>
                <label className="block text-sm">
                  Passphrase（OKX 必填）
                  <input
                    name="passphrase"
                    className={field}
                    type="password"
                    autoComplete="off"
                  />
                </label>
                <label className="flex gap-2 text-sm">
                  <input name="demo" type="checkbox" defaultChecked />
                  模拟盘凭证
                </label>
                <button className={button} disabled={busy}>
                  加密保存到服务器
                </button>
              </form>
            </section>

          </div>
        </>
      )}
      <p className="mt-8 text-xs text-[var(--text-muted)]">
        接管仍需中心执行权校验和持仓、订单核对。
        <Link to="/login" className="underline">
          切换服务器或登录方式
        </Link>
      </p>
    </main>
  );
}
