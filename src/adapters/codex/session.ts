// A short Codex app-server session for one request, such as account/rateLimits/read or hooks/list:
// start, handshake, ask, and stop within 10 seconds.
import { join } from "node:path";
import type { Account } from "../../core/config/types";
import { resolveHomedir, resolveRelayHome } from "../../core/paths";
import { recordReading } from "../../accounts/availability";
import { VERSION } from "../../core/version";
import { now } from "../../platform/clock";
import { JsonLineParser } from "../lines";
import { startHeadless } from "../process";
import type { HeadlessProcess } from "../process";
import { findProgram } from "../program";
import type { Availability } from "../types";
import { settlesWithin } from "../worker";
import { availabilityFromRateLimits } from "./app-server";
import { RpcClient, RpcError } from "./rpc";

export async function initializeCodex(rpc: RpcClient, timeoutMs: number): Promise<void> {
  await rpc.request("initialize", {
    clientInfo: { name: "relay", title: "relay", version: VERSION },
    capabilities: { experimentalApi: false, requestAttestation: false },
  }, { timeoutMs });
  await rpc.notify("initialized");
}

type SessionResult = { status: "answer"; result: unknown } | { status: "error"; error: RpcError } | { status: "unknown" };

// One short session, including its handshake and shutdown, shares one deadline.
export async function readCodexSession(
  account: Account, env: Record<string, string>, cwd: string, method: string, params: unknown,
  adapterEnv: Record<string, string | undefined> = env, timeoutMs = 10_000,
): Promise<SessionResult> {
  const path = findProgram("codex", adapterEnv);
  if (path === null) return { status: "unknown" };
  const home = resolveRelayHome(env, resolveHomedir(env));
  const deadline = performance.now() + Math.max(0, timeoutMs);
  const remaining = () => Math.max(0, deadline - performance.now());
  let child: HeadlessProcess | undefined;
  const rpc = new RpcClient((line) => child!.write(line));
  const parser = new JsonLineParser();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requesting = false;
  try {
    child = await startHeadless({ path, args: ["app-server"], cwd, env, input: "pipe",
      logPath: join(home, "logs", "workers", `availability-${account.provider}-${account.name}.log`),
      onLine(stream, line) {
        if (stream !== "out") return;
        const parsed = parser.parse(line);
        if (parsed !== null) rpc.receive(parsed.value);
      },
    });
    const agent = child;
    void agent.exited.then(() => rpc.close());
    timer = setTimeout(() => { agent.signal("SIGKILL"); rpc.close(); }, remaining());
    await initializeCodex(rpc, remaining());
    requesting = true;
    return { status: "answer", result: await rpc.request(method, params, { timeoutMs: remaining() }) };
  } catch (error) {
    return requesting && error instanceof RpcError ? { status: "error", error } : { status: "unknown" };
  } finally {
    if (child !== undefined) {
      child.closeInput();
      if (!(await settlesWithin(child.exited, remaining()))) child.signal("SIGKILL");
      await child.exited;
    }
    clearTimeout(timer);
    rpc.close();
  }
}

export async function codexAvailability(
  account: Account, env: Record<string, string>, adapterEnv: Record<string, string | undefined>,
): Promise<Availability> {
  const response = await readCodexSession(account, env, resolveHomedir(env),
    "account/rateLimits/read", undefined, adapterEnv);
  const reading: Availability = response.status === "answer" ? availabilityFromRateLimits(response.result, account.id)
    : response.status === "error" ? {
      account: account.id, state: "unavailable", windows: [], source: "provider_api", observedAt: now(),
      detail: `Codex is not signed in on this account. Run relay account login codex:${account.name}.`,
    } : {
      account: account.id, state: "unknown", windows: [], source: "none", observedAt: now(),
      detail: "relay could not read Codex's rate limits.",
    };
  // A failed attempt says nothing about the account, so it does not replace an earlier reading.
  if (response.status !== "unknown") recordReading(resolveRelayHome(env, resolveHomedir(env)), account, reading);
  return reading;
}
