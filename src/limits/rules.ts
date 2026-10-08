import {
  LIMIT_WINDOWS, type AccountId, type LimitAction, type LimitWindow, type RelayConfig,
} from "../core/config/types";

export interface LimitRule {
  account: AccountId;
  window: LimitWindow;
  threshold: number;
  action: LimitAction;
  switchTo: AccountId | null;
  switchToIgnored: boolean;
}

export function resolveLimitRules(config: RelayConfig): LimitRule[] {
  const included = new Set([
    ...config.t3.instances.map((instance) => instance.account),
    ...config.limits.map((setting) => setting.account),
  ]);
  const rules: LimitRule[] = [];
  for (const account of config.accounts) {
    if (!included.has(account.id)) continue;
    for (const window of LIMIT_WINDOWS) {
      const setting = config.limits.find((item) => item.account === account.id && item.window === window);
      const switchTo = setting?.switchTo ?? null;
      const threshold = setting?.threshold ?? (window === "five_hour" ? 100 : 90);
      const action = setting?.action ?? (window === "five_hour" ? "wait" : switchTo !== null ? "switch" : "notify");
      rules.push({
        account: account.id, window, threshold, action, switchTo,
        switchToIgnored: action !== "switch" && switchTo !== null,
      });
    }
  }
  return rules;
}

export function windowWords(window: LimitWindow): "5-hour" | "weekly" {
  return window === "five_hour" ? "5-hour" : "weekly";
}

export function describeRule(rule: LimitRule): string {
  const action = rule.action === "switch" ? `switch to ${rule.switchTo}` : rule.action;
  const ignored = rule.switchToIgnored ? " (switch_to is ignored)" : "";
  return `${rule.account} · ${rule.window}: ${action} at ${rule.threshold}%${ignored}`;
}
