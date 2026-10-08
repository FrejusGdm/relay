# Spec Delta

## Purpose

Each provider's terms limit what relay may do with an account. This capability makes every adapter carry a reviewed, dated record of those terms, shows it to the person, and keeps automatic switching between two accounts of the same provider off.

## ADDED Requirements

### Requirement: Every adapter has a policy file
Each adapter SHALL ship a policy file `src/adapters/<provider>/policy.toml` with `provider`, `display_name`, `checked_on` (a date), `max_age_days`, `sign_in_methods`, `unattended_subscription_use` (`allowed`, `api_key_only` or `unclear`), `same_provider_automatic_switching` (`off`), `usage_signals`, `summary`, `unclear` and at least one `[[terms]]` entry with `title` and `url`. relay SHALL refuse to build when a policy file is missing or invalid.

#### Scenario: Missing field
- **WHEN** the Codex policy file has no `checked_on`
- **THEN** `bun test test/policies` fails with "src/adapters/codex/policy.toml: checked_on is required."

### Requirement: Policy shown before an account is added
`relay account add` SHALL print the provider's `summary`, the `checked_on` date and each terms title with its address before asking for confirmation, and SHALL record in the account's record the `checked_on` date the person saw and when.

#### Scenario: Adding a Codex account
- **WHEN** the person runs `relay account add codex personal`
- **THEN** the output before the question includes "Codex policy notes, checked 2026-10-07:", the summary, and the line "  OpenAI Terms of Use  https://openai.com/policies/terms-of-use/"

### Requirement: Showing a policy
`relay policy show <provider>` SHALL print the whole policy in plain text: the summary, sign-in methods, the usage signals relay uses, the same-provider switching rule, what is unclear, the terms links and the check date.

#### Scenario: Claude policy
- **WHEN** the person runs `relay policy show claude`
- **THEN** the output includes "Automatic switching between two Claude accounts: off." and "Last checked 2026-10-07." and relay exits with code 0

#### Scenario: Unknown provider
- **WHEN** the person runs `relay policy show cursor`
- **THEN** relay prints "relay has no adapter for cursor yet. Supported providers: claude, codex." and exits with code 2

### Requirement: Same-provider automatic switching is off
relay SHALL answer "no" whenever any part of relay asks whether it may move a job automatically between two accounts of the same provider. No setting SHALL change this answer in this version. Moving work between different providers is not affected by this rule.

#### Scenario: Asked for two Claude accounts
- **WHEN** a test asks whether a job may move automatically from `claude:work` to `claude:home`
- **THEN** the answer is no, with the reason "Automatic switching between two Claude accounts is off. Anthropic's terms say plan limits assume ordinary, individual use."

#### Scenario: Asked for two providers
- **WHEN** a test asks the same for `claude:work` to `codex:personal`
- **THEN** this rule does not refuse it

### Requirement: Stale policies are flagged
`relay policy show` SHALL add "This may be out of date." when `checked_on` is older than `max_age_days` (90), and `bun run scripts/check-policies.ts` SHALL exit 1 listing each stale policy, so that the policies are checked again before a release.

#### Scenario: Old policy
- **WHEN** the clock reads 2027-01-10 and the Claude policy was checked on 2026-10-07
- **THEN** `relay policy show claude` includes "Last checked 2026-10-07 (95 days ago). This may be out of date." and `bun run scripts/check-policies.ts` exits 1

### Requirement: Changed policies are announced
When an account's recorded `checked_on` differs from the policy file's current `checked_on`, `relay run` on that account SHALL print one notice line before starting the agent and SHALL then record the new date.

#### Scenario: Policy updated in a new relay version
- **WHEN** `claude:work` was added under the policy checked on 2026-10-07 and the current policy is dated 2027-01-05
- **THEN** `relay run claude:work` first prints "The Claude Code policy notes changed since you last saw them. Read them with relay policy show claude."
