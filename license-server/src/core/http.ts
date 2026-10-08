// The plain request and response the handlers use, so tests call them without the Azure runtime,
// and the headers every answer carries (add-lifetime-license, design decisions 7 and 11).
import type { StripeApi } from "./stripe-client";
import type { Settings, SettingsResult } from "./settings";

export interface PlainRequest {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
  body: Uint8Array;
}

export interface PlainResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type LogValue = string | number | boolean | null | string[];
export type Log = (level: "info" | "warn" | "error", message: string, fields?: Record<string, LogValue>) => void;

export interface Deps {
  settings: SettingsResult;
  stripe: (settings: Settings) => StripeApi;
  log: Log;
}

const SHARED = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): PlainResponse {
  return { status, headers: { "Content-Type": "application/json", ...SHARED, ...headers }, body: JSON.stringify(body) };
}

export function html(status: number, title: string, lines: string[]): PlainResponse {
  const body = [
    "<!doctype html>",
    '<html lang="en">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    ...lines.map((line) => `<p>${line}</p>`),
    "</html>",
    "",
  ].join("\n");
  return { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SHARED }, body };
}

export function redirect(location: string): PlainResponse {
  return { status: 303, headers: { Location: location, ...SHARED }, body: "" };
}

// Every function answers this way while a setting is missing or wrong, and logs only the names.
export function notConfigured(log: Log, problems: string[]): PlainResponse {
  log("error", "settings invalid", { settings: problems });
  return json(503, { error: "not_configured" });
}

// The error's class name only: a Stripe error message can quote the request.
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
