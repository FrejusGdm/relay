import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { createT3Client, T3Error } from "../../src/t3/client";
import { readConnection, tokenGetter } from "../../src/t3/connection";
import { signIn, signOut, type SignInOptions } from "../../src/t3/oauth";
import { memorySecretStore, type SecretStore } from "../../src/t3/secrets";
import { startFakeT3, type FakeT3Options, type FakeT3 } from "../fakes/fake-t3";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const timeoutMessage = "T3 Code did not send relay back within 2 minutes. Run relay t3 connect again.";

async function authorize(fake: FakeT3, address: URL): Promise<URL> {
  const url = new URL(address);
  url.searchParams.set("pairing_code", fake.pairingCode);
  const response = await fake.fetch(url);
  expect(response.status).toBe(302);
  const location = response.headers.get("Location");
  if (!location) throw new Error("The fake T3 server did not return a callback address.");
  return new URL(location);
}

async function visit(callback: URL): Promise<Response> {
  // Native fetch errors may contain the callback code. Never pass them to the test runner.
  try { return await fetch(callback, { redirect: "error" }); }
  catch { throw new Error("The callback listener could not be reached."); }
}

async function setup(fakeOptions: FakeT3Options = {}) {
  const fake = await startFakeT3(fakeOptions);
  cleanup.push(() => fake.stop());
  const relayHome = mkdtempSync(join(tmpdir(), "relay-t3-oauth-"));
  cleanup.push(() => { rmSync(relayHome, { recursive: true, force: true }); });
  const store = memorySecretStore();
  const lines: string[] = [];
  let callbackAddress: URL | undefined;
  const options: SignInOptions = {
    url: fake.url, relayHome, version: "0.1.0", store,
    now: () => new Date("2026-10-08T00:00:00.000Z"),
    callbackTimeoutMs: 2_000,
    print: (line) => { lines.push(line); },
    async openBrowser(url) {
      expect(lines[0]).toBe('T3 Code will ask for a pairing code and an access level. Choose "full-access": T3 only lets relay act on threads whose permission mode is not broader than relay\'s, and new T3 threads use full access. relay never changes a thread\'s permission mode.');
      callbackAddress = await authorize(fake, url);
      const response = await visit(callbackAddress);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/plain");
      expect(await response.text()).toBe("relay is connected. You can close this tab.");
    },
  };
  return { fake, store, lines, options, callbackAddress: () => callbackAddress };
}

async function listenerStopped(address: URL): Promise<boolean> {
  // Probe without a code or verifier, and suppress native connection errors.
  try { await fetch(new URL("/callback", address), { redirect: "error" }); return false; }
  catch { return true; }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("sign-in saves the grant in the injected store and a tokenGetter client can list projects", async () => {
  const { fake, store, options, callbackAddress } = await setup();
  expect(await signIn(options)).toEqual({ serverVersion: "1.0.0", expiresAt: new Date("2026-11-07T00:00:00.000Z") });
  const token = await store.get(fake.url);
  expect(typeof token === "string" && token.length > 0).toBe(true);
  const registration = JSON.parse((await store.get(`${fake.url}#client`))!);
  expect(typeof registration.client_id).toBe("string");
  expect(registration.issuer).toBe(new URL(fake.url).origin);
  const path = join(options.relayHome, "t3", "connection.json");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8").includes(token!)).toBe(false);
  expect(readConnection(options.relayHome)?.expires_at).toBe("2026-11-07T00:00:00.000Z");
  expect(await listenerStopped(callbackAddress()!)).toBe(true);
  const client = createT3Client({
    url: fake.url, version: options.version, token: tokenGetter(store, fake.url),
    logger: { info() {}, warn() {} },
  });
  cleanup.push(() => client.close());
  expect(await client.call("t3_project_list", {})).toEqual({ projects: [] });
});

test("the callback ignores wrong states, paths and methods, then accepts the right GET", async () => {
  const { fake, options } = await setup();
  options.openBrowser = async (url) => {
    const callback = await authorize(fake, url);
    const wrong = new URL(callback);
    wrong.searchParams.set("state", crypto.randomUUID());
    expect((await visit(wrong)).status).toBe(404);
    const wrongPath = new URL(callback);
    wrongPath.pathname = "/other";
    expect((await visit(wrongPath)).status).toBe(404);
    // Use a URL without a code for the method check.
    const methodUrl = new URL("/callback", callback);
    methodUrl.searchParams.set("state", callback.searchParams.get("state")!);
    const method = await fetch(methodUrl, { method: "POST" });
    expect(method.status).toBe(404);
    expect((await visit(callback)).status).toBe(200);
  };
  await signIn(options);
});

test("sign-in keeps credentials pending through tool checks and saves token before registration", async () => {
  const { fake, store, options } = await setup();
  let toolsChecked = false;
  let credentialsStayedPending = false;
  options.fetch = async (url, init) => {
    const response = await fake.fetch(url, init);
    if (new URL(url).pathname === "/mcp" && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as { method?: string };
      if (request.method === "tools/list") {
        toolsChecked = true;
        credentialsStayedPending = (await store.get(fake.url)) === null
          && (await store.get(`${fake.url}#client`)) === null
          && readConnection(options.relayHome) === null;
      }
    }
    return response;
  };
  const writes: string[] = [];
  let savedAfterToolCheck = true;
  let connectionSavedLast = true;
  const originalSet = store.set.bind(store);
  store.set = async (name, value) => {
    savedAfterToolCheck &&= toolsChecked;
    connectionSavedLast &&= readConnection(options.relayHome) === null;
    writes.push(name);
    await originalSet(name, value);
  };
  await signIn(options);
  expect(credentialsStayedPending).toBe(true);
  expect(savedAfterToolCheck).toBe(true);
  expect(connectionSavedLast).toBe(true);
  expect(writes).toEqual([fake.url, `${fake.url}#client`]);
  expect(readConnection(options.relayHome)).not.toBeNull();
});

test("the injected deadline closes the listener and returns the exact timeout message", async () => {
  const { fake, options, store } = await setup();
  let callback: URL | undefined;
  options.callbackTimeoutMs = 250;
  options.openBrowser = async (url) => { callback = await authorize(fake, url); };
  const error: unknown = await signIn(options).catch((error: unknown) => error);
  expect(error instanceof Error && error.message === timeoutMessage).toBe(true);
  expect(callback !== undefined).toBe(true);
  expect(await listenerStopped(callback!)).toBe(true);
  expect((await store.get(fake.url)) === null).toBe(true);
  expect((await store.get(`${fake.url}#client`)) === null).toBe(true);
  expect(readConnection(options.relayHome)).toBeNull();
});

test("Nothing on disk: no file, log or printed line contains the token, code or verifier", async () => {
  const { fake, store, lines, options, callbackAddress } = await setup();
  let verifier = null as string | null;
  options.fetch = async (url, init) => {
    if (new URL(url).pathname === "/token") verifier = new URLSearchParams(String(init?.body)).get("code_verifier");
    return fake.fetch(url, init);
  };
  await signIn(options);
  const token = await store.get(fake.url);
  const code = callbackAddress()?.searchParams.get("code");
  expect(!!token && !!code && !!verifier).toBe(true);
  for (const secret of [token!, code!, verifier!]) {
    for (const path of filesUnder(options.relayHome)) expect(readFileSync(path, "utf8").includes(secret)).toBe(false);
    expect(lines.some((line) => line.includes(secret))).toBe(false);
  }
});

test("signOut removes the token, client registration and connection file", async () => {
  const { fake, store, options } = await setup();
  await signIn(options);
  await signOut(options);
  expect((await store.get(fake.url)) === null).toBe(true);
  expect((await store.get(`${fake.url}#client`)) === null).toBe(true);
  expect(existsSync(join(options.relayHome, "t3", "connection.json"))).toBe(false);
  await signOut(options);
});

test("an old T3 build fails with too_old and leaves no saved connection or credentials", async () => {
  const { fake, store, options } = await setup({ omitTools: ["t3_thread_configure"] });
  const error: unknown = await signIn(options).catch((error: unknown) => error);
  expect(error instanceof T3Error && error.kind === "too_old").toBe(true);
  expect((await store.get(fake.url)) === null).toBe(true);
  expect((await store.get(`${fake.url}#client`)) === null).toBe(true);
  expect(readConnection(options.relayHome)).toBeNull();
});

test.each([60, 5_184_000])("expiry uses the shorter of the issued lifetime and thirty days: %s seconds", async (seconds) => {
  const { options } = await setup({ expiresIn: seconds });
  const result = await signIn(options);
  expect(result.expiresAt.getTime()).toBe(options.now!().getTime() + Math.min(seconds, 2_592_000) * 1000);
});

test("successful renewal replaces the token and connection record without registering again", async () => {
  const { fake, store, options } = await setup();
  await signIn(options);
  const registration = await store.get(`${fake.url}#client`);
  const oldToken = await store.get(fake.url);
  let registrations = 0;
  options.fetch = async (url, init) => {
    if (new URL(url).pathname === "/register") registrations++;
    return fake.fetch(url, init);
  };
  const writes: string[] = [];
  const originalSet = store.set.bind(store);
  store.set = async (name, value) => {
    writes.push(name);
    await originalSet(name, value);
  };
  options.now = () => new Date("2026-10-09T00:00:00.000Z");
  await signIn(options);
  expect((await store.get(`${fake.url}#client`)) === registration).toBe(true);
  expect((await store.get(fake.url)) !== oldToken).toBe(true);
  expect(registrations).toBe(0);
  expect(writes).toEqual([fake.url]);
  expect(readConnection(options.relayHome)?.connected_at).toBe("2026-10-09T00:00:00.000Z");
  expect(readConnection(options.relayHome)?.expires_at).toBe("2026-11-08T00:00:00.000Z");
});

test.each(["timeout", "wrong pairing code"])("failed renewal preserves the old token, registration and connection file: %s", async (failure) => {
  const { fake, store, options } = await setup();
  await signIn(options);
  const oldToken = `old-${crypto.randomUUID()}`;
  await store.set(fake.url, oldToken);
  // Force a new registration, so an early write or failure cleanup would be detected.
  await store.delete(`${fake.url}#client`);
  const registration = await store.get(`${fake.url}#client`);
  const path = join(options.relayHome, "t3", "connection.json");
  const record = readFileSync(path, "utf8");
  let writes = 0;
  let deletions = 0;
  const originalSet = store.set.bind(store);
  const originalDelete = store.delete.bind(store);
  store.set = async (name, value) => { writes++; await originalSet(name, value); };
  store.delete = async (name) => { deletions++; return originalDelete(name); };
  options.callbackTimeoutMs = 250;
  let pairingRejected = false;
  options.openBrowser = async (address) => {
    if (failure === "wrong pairing code") {
      const wrong = new URL(address);
      wrong.searchParams.set("pairing_code", "wrong");
      pairingRejected = (await fake.fetch(wrong)).status === 400;
    }
  };
  const error: unknown = await signIn(options).catch((error: unknown) => error);
  expect(error instanceof Error && error.message === timeoutMessage).toBe(true);
  if (failure === "wrong pairing code") expect(pairingRejected).toBe(true);
  expect((await store.get(fake.url)) === oldToken).toBe(true);
  expect((await store.get(`${fake.url}#client`)) === registration).toBe(true);
  expect(readFileSync(path, "utf8") === record).toBe(true);
  expect(writes).toBe(0);
  expect(deletions).toBe(0);
});

test("OAuth token errors cannot print the submitted code or verifier", async () => {
  const { fake, options } = await setup({ echoTokenError: true });
  let code: string | null = null;
  let verifier: string | null = null;
  options.fetch = async (url, init) => {
    if (new URL(url).pathname === "/token") {
      const params = new URLSearchParams(String(init?.body));
      code = params.get("code");
      verifier = params.get("code_verifier");
    }
    return fake.fetch(url, init);
  };
  const captured: string[] = [];
  const originalPrint = options.print;
  const spies = [
    spyOn(options, "print").mockImplementation((line) => { captured.push(line); originalPrint(line); }),
    ...(["log", "warn", "error", "info"] as const).map((method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(format(...args));
      })),
  ];
  let error: unknown;
  try { error = await signIn(options).catch((error: unknown) => error); }
  finally { for (const spy of spies) spy.mockRestore(); }
  expect(!!code && !!verifier).toBe(true);
  expect(captured.some((line) => line.includes(code!) || line.includes(verifier!))).toBe(false);
  expect(error instanceof Error && error.message === "relay could not connect to T3 Code. Run relay t3 connect again.").toBe(true);
});

test("sign-in completes when the browser opener follows the redirect but never resolves", async () => {
  const { fake, options } = await setup();
  let visitTask: Promise<Response> | undefined;
  options.openBrowser = async (address) => {
    visitTask = visit(await authorize(fake, address));
    await visitTask;
    await new Promise<void>(() => {});
  };
  expect((await signIn(options)).serverVersion).toBe("1.0.0");
  expect((await visitTask)?.status).toBe(200);
});

test.each(["token exchange", "second connect"])("the deadline remains active after the callback during %s", async (stage) => {
  const { fake, options, store } = await setup();
  options.callbackTimeoutMs = 250;
  let stalled = false;
  options.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if ((stage === "token exchange" && path === "/token")
      || (stage === "second connect" && path === "/mcp" && new Headers(init?.headers).has("Authorization"))) {
      stalled = true;
      return new Promise<Response>(() => {});
    }
    return fake.fetch(url, init);
  };
  const error: unknown = await signIn(options).catch((error: unknown) => error);
  expect(stalled).toBe(true);
  expect(error instanceof Error && error.message === timeoutMessage).toBe(true);
  expect((await store.get(fake.url)) === null).toBe(true);
  expect((await store.get(`${fake.url}#client`)) === null).toBe(true);
  expect(readConnection(options.relayHome)).toBeNull();
});

test("store and SDK failures cannot expose a secret in an error", async () => {
  const { fake, options } = await setup();
  const secret = crypto.randomUUID();
  const store: SecretStore = {
    async get() { throw new Error(secret); }, async set() { throw new Error(secret); }, async delete() { return false; },
  };
  const storeError: unknown = await signIn({ ...options, store }).catch((error: unknown) => error);
  expect(storeError instanceof Error && !storeError.message.includes(secret)).toBe(true);
  const sdkError: unknown = await signIn({ ...options, fetch: async () => { throw new Error(secret); } }).catch((error: unknown) => error);
  expect(sdkError instanceof Error && !sdkError.message.includes(secret)).toBe(true);
  expect((await options.store.get(fake.url)) === null).toBe(true);
});

test("a browser failure prints the sign-in address and the person can still complete sign-in", async () => {
  const { fake, options, lines } = await setup();
  const visits: Promise<void>[] = [];
  options.openBrowser = async () => { throw new Error("The browser is unavailable."); };
  options.print = (line) => {
    lines.push(line);
    if (line.startsWith("http://")) {
      // Keep the simulated person's visit observable without making print asynchronous.
      visits.push((async () => {
        const response = await visit(await authorize(fake, new URL(line)));
        expect(response.status).toBe(200);
      })());
      void visits[visits.length - 1]!.catch(() => {});
    }
  };
  await signIn(options);
  await Promise.all(visits);
  expect(visits).toHaveLength(1);
  expect(lines[1]).toBe("relay could not open your browser. Open this address to connect to T3 Code:");
});

test("an authorization response with the wrong issuer is rejected without saving a token", async () => {
  const { fake, options, store } = await setup();
  options.openBrowser = async (url) => {
    const callback = await authorize(fake, url);
    callback.searchParams.set("iss", "http://127.0.0.1:1");
    expect((await visit(callback)).status).toBe(200);
  };
  const error: unknown = await signIn(options).catch((error: unknown) => error);
  expect(error instanceof Error).toBe(true);
  expect((await store.get(fake.url)) === null).toBe(true);
  expect((await store.get(`${fake.url}#client`)) === null).toBe(true);
  expect(readConnection(options.relayHome)).toBeNull();
});

test("the fake refuses a wrong pairing code and a wrong PKCE verifier", async () => {
  const { fake, options, store } = await setup();
  options.openBrowser = async (address) => {
    const wrong = new URL(address);
    wrong.searchParams.set("pairing_code", "wrong");
    expect((await fake.fetch(wrong)).status).toBe(400);
    const callback = await authorize(fake, address);
    const response = await fake.fetch(new URL("/token", fake.url), {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code", code: callback.searchParams.get("code")!,
        client_id: address.searchParams.get("client_id")!, redirect_uri: address.searchParams.get("redirect_uri")!,
        code_verifier: crypto.randomUUID(),
      }),
    });
    expect(response.status).toBe(400);
    // The failed exchange consumed this code; approve again for the real SDK exchange.
    expect((await visit(await authorize(fake, address))).status).toBe(200);
  };
  await signIn(options);
  expect((await store.get(fake.url)) !== null).toBe(true);
});
