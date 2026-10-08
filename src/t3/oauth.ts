import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/client";
import { T3Error, T3_TOOLS } from "./client";
import { removeConnection, writeConnection } from "./connection";
import type { SecretStore } from "./secrets";

export interface SignInOptions {
  url: string;
  relayHome: string;
  version: string;
  store: SecretStore;
  openBrowser: (url: URL) => Promise<void>;
  print: (line: string) => void;
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  callbackTimeoutMs?: number;
  now?: () => Date;
}

const TIMEOUT = "T3 Code did not send relay back within 2 minutes. Run relay t3 connect again.";
const EXPLANATION = 'T3 Code will ask for a pairing code and an access level. Choose "full-access": T3 only lets relay act on threads whose permission mode is not broader than relay\'s, and new T3 threads use full access. relay never changes a thread\'s permission mode.';
const MAX_LIFETIME = 30 * 86_400_000;
const OAUTH_ERRORS = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope", "invalid_redirect_uri",
  "invalid_client_metadata", "access_denied", "server_error",
]);

// Only a command at the keyboard calls this. The daemon never starts a TCP listener.
export async function signIn(options: SignInOptions): Promise<{ serverVersion: string | null; expiresAt: Date }> {
  let resource: URL;
  try { resource = new URL(options.url); }
  catch { throw new Error("t3.url: relay only connects to T3 Code on this computer (127.0.0.1 or localhost)."); }
  if (resource.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(resource.hostname)
    || resource.pathname !== "/mcp" || resource.search || resource.hash || resource.username || resource.password) {
    throw new Error("t3.url: relay only connects to T3 Code on this computer (127.0.0.1 or localhost).");
  }
  const now = options.now ?? (() => new Date());
  const state = crypto.randomUUID();
  const abort = new AbortController();
  let active = true;
  let accepted = false;
  let pendingTokens: Parameters<OAuthClientProvider["saveTokens"]>[0] | undefined;
  let pendingRegistration: { client_id: string; issuer: string } | undefined;
  let verifier: string | undefined;
  let discovery: Parameters<NonNullable<OAuthClientProvider["saveDiscoveryState"]>>[0] | undefined;
  let issuedAt: Date | undefined;
  let expiresAt: Date | undefined;
  let authorizationCode: string | null = null;
  let resolveCallback!: (params: URLSearchParams) => void;
  const callback = new Promise<URLSearchParams>((resolve) => {
    resolveCallback = resolve;
  });
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  void deadline.catch(() => {});
  const listener = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (!active || accepted || request.method !== "GET" || url.pathname !== "/callback"
        || url.searchParams.get("state") !== state) return new Response(null, { status: 404 });
      accepted = true;
      resolveCallback(url.searchParams);
      // Graceful stop lets the one accepted response finish before closing the socket.
      void listener.stop();
      return new Response("relay is connected. You can close this tab.", {
        headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
      });
    },
    // Bun must never print an exception containing the request's authorization code.
    error() { return new Response(null, { status: 500 }); },
  });
  const timer = setTimeout(() => {
    active = false;
    abort.abort();
    void listener.stop(true);
    rejectDeadline(new Error(TIMEOUT));
  }, options.callbackTimeoutMs ?? 120_000);
  const requireActive = () => { if (!active) throw new Error(TIMEOUT); };
  const provider: OAuthClientProvider = {
    redirectUrl: `http://127.0.0.1:${listener.port}/callback`,
    clientMetadata: {
      client_name: "relay", application_type: "native",
      redirect_uris: [`http://127.0.0.1:${listener.port}/callback`],
      grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
    },
    async clientInformation(ctx) {
      // Return the issuer too: the SDK checks this stamp so a client ID is never used with another
      // authorization server, and registers again when it is missing.
      if (pendingRegistration) return { client_id: pendingRegistration.client_id, issuer: pendingRegistration.issuer };
      const stored = await options.store.get(`${options.url}#client`);
      if (stored === null) return undefined;
      let info: unknown;
      try { info = JSON.parse(stored); } catch { return undefined; }
      if (typeof info !== "object" || info === null) return undefined;
      const registration = info as { client_id?: unknown; issuer?: unknown };
      // The SDK also asks without an issuer before discovery or a new connection.
      const issuer = ctx?.issuer ?? resource.origin;
      if (typeof registration.client_id !== "string" || registration.issuer !== issuer) return undefined;
      return { client_id: registration.client_id, issuer };
    },
    async saveClientInformation(info, ctx) {
      requireActive();
      pendingRegistration = { client_id: info.client_id, issuer: ctx?.issuer ?? resource.origin };
    },
    async tokens() {
      // Connecting is an explicit renewal. Reuse the public registration, not an old grant.
      return pendingTokens;
    },
    async saveTokens(tokens) {
      requireActive();
      issuedAt = now();
      const seconds = tokens.expires_in;
      const lifetime = seconds !== undefined && Number.isFinite(seconds) && seconds >= 0
        ? Math.min(MAX_LIFETIME, seconds * 1000) : MAX_LIFETIME;
      expiresAt = new Date(issuedAt.getTime() + lifetime);
      pendingTokens = tokens;
    },
    state: () => state,
    saveDiscoveryState(s) { discovery = s; },
    discoveryState: () => discovery,
    async redirectToAuthorization(url) {
      requireActive();
      options.print(EXPLANATION);
      // Do not let a server put a token, code or verifier in browser arguments or output.
      for (const key of ["access_token", "refresh_token", "code", "code_verifier"]) {
        if (url.searchParams.has(key)) throw new Error("T3 Code sent an invalid sign-in address.");
      }
      if (url.origin !== resource.origin) throw new Error("T3 Code sent an invalid sign-in address.");
      const storedToken = await options.store.get(options.url);
      if ([storedToken, verifier].some((secret) => secret && url.toString().includes(secret))) {
        throw new Error("T3 Code sent an invalid sign-in address.");
      }
      void options.openBrowser(url).catch(() => {
        if (active) {
          options.print("relay could not open your browser. Open this address to connect to T3 Code:");
          options.print(url.toString());
        }
      });
    },
    saveCodeVerifier(value) { requireActive(); verifier = value; },
    codeVerifier() {
      if (verifier === undefined) throw new Error("T3 Code sign-in must be started again. Run relay t3 connect.");
      return verifier;
    },
  };
  const fetch: NonNullable<SignInOptions["fetch"]> = async (target, init) => {
    requireActive();
    const url = new URL(target);
    if (url.origin !== resource.origin) throw new Error("T3 Code sent an invalid sign-in address.");
    const headers = new Headers(init?.headers);
    if (url.href !== resource.href) headers.delete("Authorization");
    const response = await (options.fetch ?? globalThis.fetch)(target, {
      ...init, headers, redirect: "error",
      signal: init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal,
    });
    if (url.pathname !== resource.pathname && response.status >= 400) {
      let code = "server_error";
      try {
        const body: unknown = await response.json();
        if (typeof body === "object" && body !== null && "error" in body
          && typeof body.error === "string" && OAUTH_ERRORS.has(body.error)) code = body.error;
      } catch { /* Never pass untrusted OAuth error text to the SDK. */ }
      return new Response(JSON.stringify({ error: code }), {
        status: response.status, headers: { "Content-Type": "application/json" },
      });
    }
    return response;
  };
  const clients: Client[] = [];
  const transports: StreamableHTTPClientTransport[] = [];
  const connect = async () => {
    requireActive();
    const client = new Client({ name: "relay", version: options.version });
    client.onerror = () => {}; // SDK errors can contain server response text.
    const transport = new StreamableHTTPClientTransport(resource, { authProvider: provider, fetch });
    clients.push(client);
    transports.push(transport);
    await client.connect(transport);
    return client;
  };
  const flow = async () => {
    let client: Client;
    try { client = await connect(); }
    catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const params = await callback;
      authorizationCode = params.get("code");
      requireActive();
      await transports[0]!.finishAuth(params);
      client = await connect();
    }
    const { tools } = await client.listTools();
    if (T3_TOOLS.some((tool) => !tools.some((entry) => entry.name === tool))) {
      throw new T3Error("too_old", "this T3 Code build cannot be driven by other programs. Install a nightly build from v0.0.46-nightly.20261006.2752 or later.");
    }
    if (!pendingTokens || !issuedAt || !expiresAt) throw new Error("T3 Code did not complete sign-in. Run relay t3 connect again.");
    const serverVersion = client.getServerVersion()?.version ?? null;
    // Server text is untrusted. An echoed secret must never enter the connection record.
    const token = pendingTokens.access_token;
    if (serverVersion && [token, authorizationCode, verifier].some((secret) => secret && serverVersion.includes(secret))) {
      throw new Error("T3 Code sent an invalid server version.");
    }
    verifier = undefined;
    authorizationCode = null;
    requireActive();
    await options.store.set(options.url, token);
    if (pendingRegistration) {
      await options.store.set(`${options.url}#client`, JSON.stringify(pendingRegistration));
    }
    writeConnection(options.relayHome, {
      v: 1, url: options.url, connected_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(), server_version: serverVersion,
    });
    return { serverVersion, expiresAt };
  };
  try {
    // The deadline still applies after the callback, through token exchange and tool checks.
    return await Promise.race([flow(), deadline]);
  } catch (error) {
    active = false;
    abort.abort();
    if (error instanceof T3Error) throw error;
    if (error instanceof Error && error.message === TIMEOUT) throw new Error(TIMEOUT);
    throw new Error("relay could not connect to T3 Code. Run relay t3 connect again.");
  } finally {
    active = false;
    abort.abort();
    clearTimeout(timer);
    verifier = undefined;
    authorizationCode = null;
    discovery = undefined;
    pendingTokens = undefined;
    pendingRegistration = undefined;
    await listener.stop(true);
    for (const client of clients) await client.close().catch(() => {});
    for (const transport of transports) await transport.close().catch(() => {});
  }
}

export async function signOut(options: { url: string; relayHome: string; store: SecretStore }): Promise<void> {
  // Try every deletion even if one fails; never repeat a store's raw error.
  const results = await Promise.allSettled([
    options.store.delete(options.url), options.store.delete(`${options.url}#client`),
    Promise.resolve().then(() => removeConnection(options.relayHome)),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("relay could not forget its T3 Code connection. Run relay t3 disconnect again.");
  }
}

export async function openT3Browser(url: URL): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url.toString()], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    const opened = await Promise.race([
      child.exited.then((code) => code === 0),
      new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), 1_000); }),
    ]);
    if (opened) return;
  } catch { /* Do not repeat native process errors. */ }
  finally { clearTimeout(timer); }
  throw new Error("relay could not open your browser.");
}
