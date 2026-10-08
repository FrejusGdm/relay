# relay license server

The Azure Functions API that sells and delivers relay's lifetime license with Stripe Checkout.
`docs/licensing.md` in the repository root explains how it works, its settings and how to test it.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```
