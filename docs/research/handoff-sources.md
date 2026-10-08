# relay: what the best writing on agent handoffs says

Researched on 2026-10-07. I downloaded each source below from its own page on that day and read
the full text. I did not rely on summaries or on other people's write-ups. Each section says what
the source teaches about passing work from one agent, or one context window, to the next, and then
compares it with relay's handoff in `openspec/changes/add-relay-switch/design.md` (decisions 6 to
13). The last section lists the changes I made to the handoff template and the ideas I did not
adopt, with reasons.

A few terms used below:

- A **context window** is the text a model can see at once: its instructions, the conversation, the
  files it read and the output of the commands it ran. When it is full, the model cannot take in
  more.
- **Compaction** is what an agent tool does when the context window is nearly full: it asks the
  model to summarize the conversation, then starts a fresh context window that holds only the
  summary and a few files.
- A **harness** is the program that runs a model as an agent (Claude Code, Codex CLI). relay is not
  a harness; it starts harnesses and moves work between them.
- A **subagent** is a second agent that a main agent starts for a smaller task, with its own context
  window. It returns a short result to the main agent.

A relay handoff is close to all three situations these sources describe: a new context window
after compaction, a new session of the same agent, and a second agent taking over a task. In every
case the next agent starts with no memory and has only what was written down.

## Summary

- The sources agree on the basic design relay already has: keep the state of the work in files and
  in git, start the next agent with a short prompt that points to those files, and make the next
  agent check the state before it builds on it.
- Every source says the hardest part is deciding what the outgoing agent must write down. The
  things they name most often are: what is half done, decisions and their reasons (including
  decisions nobody stated), instructions the user gave only in conversation, unresolved bugs, and
  surprises learned along the way.
- relay's notes request (design decision 6) already asked for most of this. I changed the lines
  under three of its seven sections (In progress, Decisions and Problems) so that it also asks for
  the finished and remaining parts of a half-done step, for unstated choices and the user's
  conversation-only requests, and for things the agent learned that the code does not show. The
  section headings, the parser, the `checkpoint.md` template (decision 11) and the continuation
  prompt (decision 12) are unchanged.
- One finding belongs to another proposal: relay usually cannot ask the outgoing agent for notes,
  because the agent is at its usage limit. What the user said only in conversation is then lost.
  The per-worker instructions in `add-provider-adapters` could ask agents to write such requests
  into `.relay/task.md` as they go. I did not change that proposal; it is listed at the end as a
  recommendation.

## The sources

| Source | Author or organisation | Published | Read on |
|---|---|---|---|
| [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Justin Young, Anthropic | 2025-11-26 | 2026-10-07 |
| [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Anthropic Applied AI team (Prithvi Rajasekaran, Ethan Dixon, Carly Ryan, Jeremy Hadfield) | 2025-09-29 | 2026-10-07 |
| [Using PLANS.md for multi-hour problem solving](https://cookbook.openai.com/articles/codex_exec_plans) | Aaron Friel, OpenAI (OpenAI Cookbook; the page now says the recipe is archived) | 2025-10-07 | 2026-10-07 |
| [Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md) | OpenAI, Codex documentation | No date shown | 2026-10-07 |
| [Don't build multi-agents](https://cognition.ai/blog/dont-build-multi-agents) | Walden Yan, Cognition | 2025-06-12 | 2026-10-07 |
| [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | Jeremy Hadfield, Barry Zhang, Kenneth Lien, Florian Scholz, Jeremy Fox, Daniel Ford, Anthropic | 2025-06-13 | 2026-10-07 |
| [How Claude remembers your project](https://code.claude.com/docs/en/memory) and [Explore the context window](https://code.claude.com/docs/en/context-window) | Anthropic, Claude Code documentation | No date shown | 2026-10-07 |
| [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), section "Context awareness and multiwindow workflows" | Anthropic, Claude Platform documentation | No date shown | 2026-10-07 |

The first five are the sources the task asked for. I added the last three because they are
primary documentation from Anthropic on the same problem and each adds a point the others do not.

## What each source says

### Anthropic: Effective harnesses for long-running agents

The post describes Claude building a large web app across many sessions, where each session is a
fresh context window. It compares the problem to engineers working in shifts where "each new
session begins with no memory of what came before."

It names four ways the work went wrong and what fixed each one:

- The agent tried to do everything at once, ran out of context in the middle, and left the next
  session a feature that was half built and not described. The next session had to guess what had
  happened. Compaction alone did not fix this, because its summary does not always pass clear
  instructions on.
- A later session saw that much was built and declared the whole job finished.
- The agent marked features as done without testing them end to end.
- Each session spent time working out how to start and test the app.

The fixes were plain files and git. A first session writes a feature list (over 200 entries, all
marked failing), a progress file, a setup script (`init.sh`) and a first commit. Every later
session works on one feature, commits with a descriptive message, and updates the progress file
before it ends. Every session starts the same way: check the working folder, read the progress file
and `git log`, read the feature list, start the app and run a basic end-to-end test to catch a
broken state before adding anything new. The feature list is JSON because the model was less likely
to rewrite JSON than Markdown, and agents may change only its pass or fail field.

How relay compares. relay keeps the job in files (`.relay/task.md`, `checkpoint.md`,
`decisions.md`) and in checkpoint commits, as the post recommends. relay runs the recorded checks
itself before the next agent starts and puts any failure at the top of the prompt, which is a
deterministic version of "run a basic test first". The post's first failure, a half-done step that
nobody described, is the one relay's notes must prevent. The notes request asked only "how far you
got", which invites an answer such as "about halfway". I changed it to ask for the finished part
and the part that is left (see "Changes made").

### Anthropic: Effective context engineering for AI agents

The post defines context engineering as choosing what goes into the model's limited context window
at each step. Its main rule is to find "the smallest possible set of high-signal tokens" that gets
the result you want, because models recall less as the window fills.

Three parts matter for handoffs:

- Keep references, not copies. Agents work well when they hold file paths and load files as needed,
  instead of receiving everything up front. Claude Code loads `CLAUDE.md` at the start and finds
  the rest with search tools.
- Compaction in Claude Code keeps architectural decisions, unresolved bugs and implementation
  details, drops repeated tool output, and reloads the most recently used files. The authors advise
  tuning a summary prompt for recall first (capture everything that matters), then for precision
  (cut what is not needed).
- Structured note-taking: the agent keeps notes in a file outside the context window and reads them
  after a reset. The authors say this suits iterative development with clear milestones, which is
  what a relay job is.

How relay compares. relay's continuation prompt is short and names files instead of copying them
(design decision 8 and 12), and the notes are capped at 400 words. The notes request already asks
for decisions and problems, which match two of the three things compaction keeps. The post's advice
to favour recall first supports asking the outgoing agent for the things that are easy to forget,
which is what the three changes do.

### OpenAI: Using PLANS.md for multi-hour problem solving

This OpenAI Cookbook recipe describes an "ExecPlan" (execution plan): a design document kept in the
repository that Codex follows and updates while it works, sometimes for more than seven hours from
one prompt. `AGENTS.md` tells Codex when to write one and where the rules for it live
(`.agent/PLANS.md`).

The rules are strict. The plan must be self-contained: a reader with only the working tree and the
plan, and no memory of earlier work, must be able to finish the task. It must be possible to restart
from the plan alone. It must keep four sections current:

- Progress, a checklist with times, where a partly done step is split into what is completed and
  what remains;
- Surprises & Discoveries, for unexpected behaviour or bugs found along the way, each with short
  evidence such as test output;
- Decision Log, each decision with its reason, date and author;
- Outcomes & Retrospective, written at milestones and at the end.

Acceptance must be stated as behaviour a person can observe (a command and its expected output),
not as internal details.

How relay compares. relay's `.relay/task.md` plays the part of the plan, and `decisions.md` the part
of the decision log. The notes request already has Done, In progress and Next steps (the Progress
section), Decisions (the Decision Log) and Claims to verify, where each claim carries a command and
its expected result (the observable acceptance). Two parts of the ExecPlan were missing from the
notes: the split of a partly done step into completed and remaining, and the record of surprises
with evidence. I added both to existing sections.

### OpenAI: Custom instructions with AGENTS.md (Codex documentation)

Codex reads `AGENTS.md` files before it does any work. It reads one file from its home folder, then
one file per folder from the project root down to the working folder, where `AGENTS.override.md`
takes the place of `AGENTS.md` in the same folder. It stops adding files at 32 KiB by default
(`project_doc_max_bytes`). It rebuilds this list at the start of every run.

How relay compares. This guide is about standing instructions, not about the state of one job, so
it confirms where relay puts each kind of information: project rules stay in `AGENTS.md`, and the
job's state stays in `.relay/`. The continuation prompt names `AGENTS.md` and `CLAUDE.md` because
Claude Code and Codex read different files (design decision 12), and design decision 17 already
watches `AGENTS.override.md`. relay never writes the handoff into `AGENTS.md`, so the 32 KiB limit
does not affect it. No change.

### Cognition: Don't build multi-agents

Walden Yan argues against systems where several agents split a task and work on the parts without
seeing each other's work. He gives two rules. First, share context: each agent should see the full
history of what the others did, not only the message that assigned its part. Second, "Actions carry
implicit decisions, and conflicting decisions carry bad results." His example: two agents asked to
build parts of a Flappy Bird clone each choose a different visual style, because neither knows the
style the other chose. For tasks too long for one context window, he suggests a model whose job is
to compress the history of actions and conversation into the key details, events and decisions.

How relay compares. relay hands work to one agent at a time, in one worktree, which is the
single-threaded design he recommends. relay does not pass full histories (the vision and design
decision 8 keep transcripts out by default). The outgoing agent's notes are the compression step he
describes. His second rule shows a gap in the notes request: it asked for "Decision. Reason.",
which an agent reads as the decisions it discussed. The choices it made silently (a library, a file
layout, a naming style) are exactly the ones the next agent cannot see. I added them to the
Decisions line.

### Anthropic: How we built our multi-agent research system

This post describes Claude's Research feature, where a lead agent starts subagents that search in
parallel. The points that matter for handoffs:

- The lead agent saves its plan to memory outside the context window, because the context is cut
  off past 200,000 tokens and the plan must survive.
- A short task description, such as a one-line request to research the semiconductor shortage, was too vague: subagents
  repeated each other's work or misread the task. Each subagent needs an objective, an output
  format, guidance on tools and sources, and clear limits.
- Errors compound in long-running agents, so the system resumes from where the agent was, with
  retries and regular checkpoints, instead of starting over.
- In the appendix, agents that reach the context limit summarize finished work into external memory
  and hand over to fresh subagents. Subagents write large results to files and pass back a
  reference, to avoid the information loss the authors call a "game of telephone".
- The authors note that most coding tasks have fewer truly parallel parts than research, and that
  agents are not yet good at coordinating with each other in real time.

How relay compares. relay's continuation prompt gives the next agent an objective (`task.md`), an
output format for its verification (`.relay/verify.md` as a table) and limits (work only inside the
worktree, treat the notes as claims). relay passes files and references, not copied text. relay
saves a checkpoint before every handoff and can roll back. No change.

### Anthropic: Claude Code documentation on memory and the context window

"How Claude remembers your project" explains `CLAUDE.md` (instructions the user writes) and auto
memory (notes Claude writes about corrections and project facts it cannot learn from the code). Its
troubleshooting section says that an instruction that disappeared after compaction was given only
in conversation, and advises: "Add conversation-only instructions to CLAUDE.md to make them persist."

"Explore the context window" lists what survives compaction. Files loaded from disk at the start
(the root `CLAUDE.md`, auto memory, the plan) are read again. A fresh git status is taken. Up to five
of the most recently changed files are re-read. Everything that came through the conversation is
replaced by the summary. Background commands keep running, and Claude is reminded of them so it does
not start a second copy.

How relay compares. A relay handoff is a stronger reset than compaction: the next agent may be a
different program from a different company, and it gets only files. Anything the user said only in
conversation is lost unless the outgoing agent writes it down. The notes request did not ask for
it, so I added it to the Decisions line. When the outgoing agent cannot be asked (the usual case,
because it is at its usage limit), the request never runs; see the recommendation at the end.

### Anthropic: Prompting best practices, "Context awareness and multiwindow workflows"

This page gives Anthropic's general advice for tasks that span several context windows. Use the
first window to set up tests and setup scripts, keep test status in a structured file such as
`tests.json`, and keep free-form progress notes. When a window is cleared, it is often better to
start a new one than to compact, because current models are good at learning the state from the
files. Tell the new window exactly how to start: check the working folder, read the progress notes,
the test file and the git log, and "Manually run through a fundamental integration test before
moving on to implementing new features." Use git to track state, because it is a log and a set of
checkpoints that can be restored.

How relay compares. relay starts a new agent from files, as the page recommends, and its
continuation prompt is prescriptive about the first steps: read the project instructions, read
`task.md` and `checkpoint.md`, inspect `git status` and the diff, verify the claims, then continue.
The integration test before new work is covered by the checks relay runs itself. No change.

## What this means for relay

### What relay already does that the sources recommend

- The job's state lives in files and in git, not in a conversation (all eight sources).
- The next agent starts with a short prompt that names files, and reads them itself (context
  engineering post, research system post, prompting guide).
- The outgoing agent writes a short structured summary instead of passing its transcript
  (Cognition's compression step, the context engineering post's note-taking, the ExecPlan
  sections).
- Claims come with a command and the expected result, and the next agent checks them before it
  continues (ExecPlan acceptance rules, harness post's testing rules).
- Tests run before new work, by relay itself, with the result at the top of the prompt (harness
  post, prompting guide).
- One agent works on the job at a time in its own worktree (Cognition, research system post on
  coding tasks).
- Every handoff is a checkpoint commit that can be restored (harness post, research system post,
  prompting guide).

### Changes made

All three changes are to the lines under the section headings in `NOTES_REQUEST`, the text relay
sends when it asks the outgoing agent for notes (design decision 6). The seven headings, their
order, the parser, the 400-word limit, the claim format, the `checkpoint.md` template (decision 11)
and the prompts (decision 12) are unchanged, so no spec scenario, task or test about headings
changes. Task 3.1 already compares the request text byte for byte with design decision 6. Design
decision 6 now cites the sources next to the text.

1. In progress. Old line: "What you were doing when you stopped, and how far you got." New line:
   "What you were doing when you stopped: the part that is finished and the part that is left."
   Sources: the harness post (a half-done step that nobody described made the next session guess)
   and the ExecPlan Progress rule (split a partly done step into completed and remaining).
2. Decisions. Old line: "Decision. Reason." New line adds: "Include choices you made without
   stating them (for example a library, a file layout or a naming style) and anything the user
   asked for in this session that is not written down in the project's files." Sources: Cognition's
   second rule (actions carry decisions nobody stated) and the Claude Code memory documentation
   (instructions given only in conversation are lost at compaction).
3. Problems. Old line: "Anything that is broken, blocked or uncertain." New line adds: "and
   anything you learned that the code does not show (for example a test that needs a running
   service). Give the evidence, such as an error message." Sources: the ExecPlan "Surprises &
   Discoveries" section (with evidence), and the context engineering post (compaction keeps
   unresolved bugs).

The notes stay inside the fence in `checkpoint.md`, and the next agent still treats them as claims
to check. A request the user made that appears in the notes is therefore information for the next
agent, not an instruction it must follow. That is the right level of trust, because relay cannot
confirm that the user really said it.

### Ideas considered and not adopted

- Pass full transcripts (Cognition's first rule). Not adopted. The vision and design decision 8
  keep transcripts out by default, because they cost context, can hold secrets, and come from
  another company's format. Cognition itself proposes compression for long tasks, which is what the
  notes are. The evaluation in `add-handoff-evaluation` measures whether more context helps.
- A dedicated model to write the summary (Cognition). Not adopted. relay does not run models of
  its own; agents own cognition. The outgoing agent writes the notes, and relay builds them from
  facts when it cannot.
- New sections in the notes, such as separate "Surprises", "Outcomes" or "Instructions from the
  user" headings (ExecPlan, Claude Code documentation). Not adopted. The content fits under existing
  headings, and a new heading would change the parser, the spec's seven-heading scenario, the golden
  files and the claim counting for a small gain.
- A JSON feature list with a pass field (harness post, prompting guide). Not adopted here.
  The feature list belongs to `.relay/task.md`, which `add-checkpoint-engine` defines, not to the
  handoff. It may be worth a later proposal if the evaluation shows agents declaring jobs finished
  too early.
- A setup script such as `init.sh` (harness post, prompting guide). Not adopted. The person's
  recorded checks (design decision 9) already tell every agent how to test the project, and relay
  runs them itself.
- Tell the next agent to fix broken tests before anything else (harness post, prompting guide).
  Not adopted. relay already runs the checks and puts failures first in the prompt. A fixed rule to
  fix first could make the agent undo the half-done step that caused the failure, when finishing it
  is the right move. The notes' Next steps and the verification step let the next agent decide.
- Make the notes self-contained like an ExecPlan. Not adopted. The ExecPlan is the whole plan;
  relay's notes are one part of the handoff, next to `task.md`, `decisions.md`, `checkpoint.md` and
  the repository. Making the notes self-contained would repeat those files and break the 400-word
  limit.
- Add `git log` to the prompt's first steps (harness post, prompting guide). Not adopted.
  `checkpoint.md` already lists the commits since the job started, and the prompt tells the agent to
  read it.
- Record a date and author for each decision (ExecPlan Decision Log). Not adopted. relay's event
  log already records which worker ran when, and the handoff commit records the handoff.

### A recommendation for another proposal

relay can ask the outgoing agent for notes only when it can still answer (design decision 6). The
main reason relay exists is that an agent hit its usage limit, and then it cannot be asked. In that
case the next agent gets notes built by relay from events and the repository, and anything the user
said only in conversation is gone. The Claude Code documentation's advice (write conversation-only
instructions into a file so they persist) applies here before the handoff, not during it.

The per-worker instructions in `add-provider-adapters` (design decision 7, `src/run/instructions.ts`)
already ask agents to keep `.relay/task.md` and `.relay/decisions.md` current. They could also ask
agents to write any request the user makes in conversation into `.relay/task.md` when they receive
it. I did not change that proposal, because this item was limited to the handoff template. Josué
should decide whether to add it.

## What I could not verify

- The Codex AGENTS.md guide, the Claude Code documentation pages and the prompting guide show no
  publication date. I give the date I read them.
- The OpenAI Cookbook page now marks the PLANS.md recipe as archived and says it may name outdated
  models. I found no newer OpenAI page that replaces it, so I used it for its method, not for its
  model names.
- None of the sources measured a handoff between two different agent products (for example Claude
  Code to Codex). Their evidence comes from one agent across many context windows, or from agents
  of the same system. Whether their advice holds across products is what `add-handoff-evaluation`
  should measure.
