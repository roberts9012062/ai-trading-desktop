import { afterEach, expect, it, vi } from "vitest";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { loginHost, logoutHost, hostSession } from "./taskhost-client";

afterEach(() => {
  logoutHost();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("passes the no-redirect policy through the real Tauri SDK and refuses a redirected handshake", async () => {
  const configs: Array<{ url: string; maxRedirections?: number }> = [];
  const reads = new Map<number, number>();
  const nativeBridge = vi.fn(async (command: string, args: unknown) => {
    const wire = args as {
      rid?: number;
      clientConfig?: { url: string; maxRedirections?: number };
    };
    if (command === "plugin:http|fetch") {
      configs.push(wire.clientConfig!);
      return configs.length;
    }
    const rid = wire.rid!;
    if (command === "plugin:http|fetch_send") {
      return {
        rid,
        url: configs[rid - 1].url,
        status: rid === 1 ? 200 : 307,
        statusText: rid === 1 ? "OK" : "Temporary Redirect",
        headers: [
          ["Content-Type", "application/json"],
          ["Location", "https://another.invalid/receive"],
        ],
      };
    }
    if (command === "plugin:http|fetch_read_body") {
      const previous = reads.get(rid) ?? 0;
      reads.set(rid, previous + 1);
      if (previous > 0) return [1];
      const body =
        rid === 1
          ? { service: "taskhost-go", initialized: true }
          : { detail: "redirect refused" };
      return [...new TextEncoder().encode(JSON.stringify(body)), 0];
    }
    if (command === "plugin:http|fetch_cancel_body") return null;
    throw new Error(`Unexpected native command: ${command}`);
  });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: nativeBridge } });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  vi.stubGlobal("fetch", nativeFetch);
  logoutHost();
  await expect(
    loginHost("https://configured.invalid", "thk_" + "a".repeat(43)),
  ).rejects.toThrow("redirect refused");
  expect(configs).toHaveLength(2);
  for (const config of configs) {
    expect(config.maxRedirections).toBe(0);
    expect(new URL(config.url).origin).toBe("https://configured.invalid");
  }
  expect(hostSession()).toBeNull();
});
