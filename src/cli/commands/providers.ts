// relay providers [--json] (the provider-adapters spec, "Detecting installed providers").
import { createAdapterRegistry } from "../../adapters/registry";
import type { Detection, ProviderId, Transport } from "../../adapters/types";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

const TRANSPORTS: Record<ProviderId, { ids: Transport[]; text: string }> = {
  claude: { ids: ["claude-print", "claude-interactive"], text: "headless (claude -p), interactive" },
  codex: { ids: ["codex-app-server", "codex-exec", "codex-interactive"], text: "headless (app server, codex exec fallback), interactive" },
};

export async function providers(ctx: CommandContext): Promise<number> {
  const registry = createAdapterRegistry({}, ctx.env);
  const found = await Promise.all(registry.providers().map(async (id) => {
    const adapter = registry.get(id);
    return { id, adapter, detection: await adapter.detect() };
  }));
  if (ctx.values.json === true) {
    ctx.io.out(`${JSON.stringify({
      providers: found.map(({ id, adapter, detection }) => ({
        id,
        installed: detection.installed,
        version: detection.version ?? null,
        transports: TRANSPORTS[id].ids.map((transport) => ({ id: transport, capabilities: adapter.capabilities(transport) })),
      })),
    })}\n`);
    return ExitCode.Ok;
  }
  const name = (displayName: string, detection: Detection) =>
    `${displayName} ${detection.version ?? "(version unknown)"}` + (detection.tooOld ? ` (relay needs ${detection.tooOld.oldest} or newer)` : "");
  const installed = found.filter(({ detection }) => detection.installed);
  const width = Math.max(0, ...installed.map(({ adapter, detection }) => name(adapter.displayName, detection).length)) + 3;
  ctx.io.out(found.map(({ id, adapter, detection }) => {
    const first = id.padEnd(9);
    if (!detection.installed) return `${first}not installed\n`;
    return `${first}${name(adapter.displayName, detection).padEnd(width)}${TRANSPORTS[id].text}\n`;
  }).join(""));
  return ExitCode.Ok;
}
