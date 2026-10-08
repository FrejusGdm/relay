// relay license <activate|status|remove> [<key>] (add-lifetime-license, design decision 10). The
// key is checked on this computer only; this command never opens a network connection.
import { printable, quote } from "../../core/quote";
import { featureUnlocked, type PaidFeature } from "../../license/features";
import { verifyLicenseKey, type KeyProblem } from "../../license/key";
import { licenseFile, readLicense, removeLicense, writeLicense } from "../../license/store";
import { SettingsError } from "../errors";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

const REASONS: Record<KeyProblem, string> = {
  format: 'this is not a relay license key. Copy the whole key; it starts with "relay1.".',
  test_key: "this license key comes from Stripe test mode and does not unlock relay.",
  unknown_key: "this license key was signed with a key that this version of relay does not know. Update relay and try again.",
  signature: "this license key failed its signature check. Copy it again from your license page.",
  product: "this license key is for another product.",
};

const MAX_KEY_BYTES = 4096;
const STDIN_WAIT_MS = 5000;

// The paid features are a parameter so that tests can pass a list; relay passes PAID_FEATURES.
export function licenseCommand(features: readonly PaidFeature[]) {
  return async (ctx: CommandContext): Promise<number> => {
    const [action, extra] = ctx.positionals as [string, string | undefined];
    if (action !== "activate" && action !== "status" && action !== "remove") {
      return usage(ctx, `relay: license needs activate, status or remove, not ${quote(action)}.`);
    }
    if (action !== "activate" && extra !== undefined) {
      return usage(ctx, `relay: license ${action} takes no other argument.`);
    }
    try {
      if (action === "remove") return remove(ctx);
      if (action === "activate") return await activate(ctx, extra);
      return status(ctx, features);
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      ctx.io.err(error.lines.map((line) => `${line}\n`).join(""));
      return ExitCode.Settings;
    }
  };
}

async function activate(ctx: CommandContext, given: string | undefined): Promise<number> {
  if (given === undefined && ctx.io.stdinIsTTY) {
    return usage(ctx, 'relay: license activate needs a key. Run "relay license activate <key>", or pipe the key into it.');
  }
  if (!canCheckKeys(ctx)) return notAvailable(ctx);
  const text = given ?? (await ctx.io.readStdin(MAX_KEY_BYTES, STDIN_WAIT_MS)).toString("utf8");
  const result = verifyLicenseKey(text, ctx.licensePublicKeys);
  if (!result.ok) {
    ctx.log.info("license check failed", { problem: result.problem });
    ctx.io.err(`relay: ${REASONS[result.problem]}\n`);
    return ExitCode.LicenseInvalid;
  }

  const saved = readLicense(ctx.relayHome, process.getuid!());
  const before = saved === null ? null : verifyLicenseKey(saved, ctx.licensePublicKeys);
  writeLicense(ctx.relayHome, text.replace(/\s/g, ""));
  const { licenseId, issued } = result.license;
  ctx.log.info("license activated", { license_id: licenseId });
  const replaced = before?.ok === true && before.license.licenseId !== licenseId
    ? ` It replaces license ${before.license.licenseId}.` : "";
  ctx.io.out([
    `License activated.${replaced}`,
    `License ID: ${licenseId}`,
    `Issued: ${issued}`,
    `relay keeps the key in ${printable(licenseFile(ctx.relayHome))} and checks it on this computer only.`,
  ].map((line) => `${line}\n`).join(""));
  return ExitCode.Ok;
}

function status(ctx: CommandContext, features: readonly PaidFeature[]): number {
  if (!canCheckKeys(ctx)) return notAvailable(ctx);
  const saved = readLicense(ctx.relayHome, process.getuid!());
  if (saved === null) {
    ctx.io.out([
      "License: none",
      "relay's core is free and stays free. A license unlocks the paid features.",
      `Paid features: ${featureList(features)}`,
    ].map((line) => `${line}\n`).join(""));
    return ExitCode.LicenseMissing;
  }
  const result = verifyLicenseKey(saved, ctx.licensePublicKeys);
  if (!result.ok) {
    ctx.log.info("license check failed", { problem: result.problem });
    ctx.io.err(
      `relay: the saved license in ${printable(licenseFile(ctx.relayHome))} is not valid: ${REASONS[result.problem]}\n` +
        'Run "relay license remove", then activate your key again.\n',
    );
    return ExitCode.LicenseInvalid;
  }
  const unlocked = features.filter((feature) => featureUnlocked(feature, result.license));
  ctx.io.out([
    "License: active",
    `License ID: ${result.license.licenseId}`,
    `Issued: ${result.license.issued}`,
    `Paid features: ${featureList(unlocked)}`,
  ].map((line) => `${line}\n`).join(""));
  return ExitCode.Ok;
}

// Removing works even when this version cannot check keys, or the file is unsafe to read.
function remove(ctx: CommandContext): number {
  let licenseId: string | null = null;
  try {
    const saved = readLicense(ctx.relayHome, process.getuid!());
    const result = saved === null ? null : verifyLicenseKey(saved, ctx.licensePublicKeys);
    if (result?.ok === true) licenseId = result.license.licenseId;
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
  }
  if (!removeLicense(ctx.relayHome)) {
    ctx.io.out("No license was saved. Nothing changed.\n");
    return ExitCode.Ok;
  }
  ctx.log.info("license removed", { license_id: licenseId });
  ctx.io.out("License removed.\n");
  return ExitCode.Ok;
}

function featureList(features: readonly PaidFeature[]): string {
  return features.length === 0 ? "none yet" : features.map((feature) => feature.name).join(", ");
}

function canCheckKeys(ctx: CommandContext): boolean {
  return Object.keys(ctx.licensePublicKeys).length > 0;
}

function notAvailable(ctx: CommandContext): number {
  ctx.io.err("relay: this version of relay cannot check license keys yet.\n");
  return ExitCode.NotAvailable;
}

function usage(ctx: CommandContext, line: string): number {
  ctx.io.err(`${line}\n`);
  return ExitCode.Usage;
}
