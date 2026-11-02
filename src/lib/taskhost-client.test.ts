import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  normalizeHost,
  loginHost,
  hostRequest,
  createHostedTask,
  logoutHost,
  hostSession,
  enterStandalone,
} from "./taskhost-client";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  logoutHost();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  logoutHost();
  vi.unstubAllGlobals();
});
it("requires HTTPS remotely and rejects URLs containing credentials or paths", () => {
  expect(normalizeHost("192.0.2.3:8787")).toBe("https://192.0.2.3:8787");
  expect(normalizeHost("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  for (const input of [
    "http://192.0.2.3:8787",
    "https://name:secret@example.com",
    "https://example.com/api",
    "https://example.com?key=secret",
  ])
    expect(() => normalizeHost(input)).toThrow();
});
it("only installs a session after a verified handshake and never stores the login key", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ service: "taskhost-go", initialized: true }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          service: "taskhost-go",
          access_token: "short-session",
          owner_id: "owner",
          expires_at: new Date(Date.now() + 300000).toISOString(),
        }),
      ),
    );
  await loginHost("https://example.com", "thk_" + "a".repeat(43));
  expect(hostSession()).toMatchObject({
    mode: "server",
    origin: "https://example.com",
    token: "short-session",
  });
  expect(
    JSON.stringify(vi.mocked(sessionStorage.setItem).mock.calls),
  ).not.toContain("thk_");
  expect(vi.mocked(fetch).mock.calls[1][1]).toMatchObject({
    redirect: "error",
  });
});
it("refuses new task creation in standalone mode before any business-server fetch", async () => {
  enterStandalone({
    scope: "collection:existing",
    centerUserID: "center-user",
  });
  await expect(
    createHostedTask({
      request_id: "request-0123456789",
      name: "x",
      kind: "ai",
      symbol: "btcusdt",
      credential_id: "c",
      config: {},
    }),
  ).rejects.toThrow("服务器");
  expect(fetch).not.toHaveBeenCalled();
});
it("never creates an offline task when the server cannot be reached", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ service: "taskhost-go", initialized: true }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          service: "taskhost-go",
          access_token: "short-session",
          owner_id: "owner",
          expires_at: new Date(Date.now() + 300000).toISOString(),
        }),
      ),
    );
  await loginHost("https://example.com", "thk_" + "a".repeat(43));
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network"));
  await expect(
    createHostedTask({
      request_id: "request-0123456789",
      name: "x",
      kind: "ai",
      symbol: "btcusdt",
      credential_id: "c",
      config: {},
    }),
  ).rejects.toThrow("结果未确认");
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("discards a response from a previous identity", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ service: "taskhost-go", initialized: true }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          service: "taskhost-go",
          access_token: "short-session",
          owner_id: "owner",
          expires_at: new Date(Date.now() + 300000).toISOString(),
        }),
      ),
    );
  await loginHost("https://example.com", "thk_" + "a".repeat(43));
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = hostRequest("/api/v1/tasks");
  logoutHost();
  resolve(new Response('{"tasks":[]}'));
  await expect(pending).rejects.toThrow("会话已变化");
});
