# Agent instructions

Read `VISION.md` before doing anything. The plan and the open decisions are in
`docs/ROADMAP.md`, the task board is kept privately, and the research is in
`docs/research/`. Never assume an answer to a decision that
`docs/ROADMAP.md` lists as open.

## Plan changes with OpenSpec

Every change starts as an OpenSpec change proposal in `openspec/changes/` and follows
the rules in `openspec/config.yaml`. A change is built only after Josué approves it.

## Design

Read `DESIGN.md` and open `docs/design/preview.html` before any user-facing work
(website, Mac app, CLI output). It is the current direction, not a final decision;
do not deviate from it without Josué's approval.

## Rules

- **No code until the proposals are approved.** Josué starts implementation himself
  with the jstack loop; it is paused until then.
- **Use official commands and existing tools** instead of code written from scratch.
  Look up the current documentation before choosing a command.
- **Run agents on the Mac.** When code exists, edit on the Mac and install, build and
  test on the Omarchy machine (see the `jstack-remote-build` skill), because the Mac
  has almost no free disk.
- **Research** follows the `jstack-research` skill; anything visual follows the
  `jstack-design` skill.
- **Write plainly** (the `plain-writing` skill): complete sentences, standard terms,
  no invented labels.
- Git on the Omarchy machine has no email. Commit with
  `git -c user.name="Josué" -c user.email="110553712+FrejusGdm@users.noreply.github.com" commit`.
