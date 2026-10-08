// GET /v1/accounts and GET /v1/accounts/{target} (design.md decision 14). No answer holds a total
// across accounts.
import type { Database } from "bun:sqlite";
import { getAccount, listAccounts } from "../../state/queries";
import { errorResponse } from "../errors";
import type { Route } from "../router";
import { snapshotResponse } from "../snapshot";

const TARGET = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9_-]*$/;

export function accountRoutes(db: Database): Route[] {
  return [
    {
      method: "GET",
      path: "/v1/accounts",
      handle: () => snapshotResponse(db, () => ({ accounts: listAccounts(db) })),
    },
    {
      method: "GET",
      path: "/v1/accounts/{target}",
      handle: (_request, params) => {
        const target = decoded(params.target!);
        if (target === null || !TARGET.test(target)) {
          return errorResponse(
            400,
            "invalid_target",
            `${target ?? params.target} is not an account name. Use provider:account, for example codex:personal.`,
          );
        }
        return snapshotResponse(db, () => {
          const account = getAccount(db, target);
          return account === null
            ? errorResponse(404, "target_not_found", `No account named ${target} in config.toml.`)
            : { account };
        });
      },
    },
  ];
}

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
