// GET /v1/providers (design.md decision 14): each supported provider with its accounts.
import type { Database } from "bun:sqlite";
import { PROVIDERS } from "../../adapters/providers";
import { listAccounts, PROVIDER_NAMES } from "../../state/queries";
import type { Route } from "../router";
import { snapshotResponse } from "../snapshot";

export function providerRoutes(db: Database): Route[] {
  return [
    {
      method: "GET",
      path: "/v1/providers",
      handle: () =>
        snapshotResponse(db, () => {
          const accounts = listAccounts(db);
          return {
            providers: PROVIDERS.map((id) => ({
              id,
              name: PROVIDER_NAMES[id] ?? id,
              accounts: accounts.filter((account) => account.provider === id),
            })),
          };
        }),
    },
  ];
}
