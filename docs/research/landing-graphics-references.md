# Landing-page graphics references

Researched on 2026-10-08. These are first-party product examples. GitHub,
Trigger.dev, Dagster and n8n images were inspected directly. Temporal's timeline update was read from release notes; the main agent also
inspected its official Full History screenshot to compare the event spine. The observations
describe the published examples, not a claim about every current product screen.
The recommendations below are design proposals, not approved product decisions.
The page's existing copy, fonts and layout remain the constraints.

## 1. GitHub Actions: a graph that reads without motion

The official screenshot places compact job nodes in columns. Each node has a name,
a small status icon and a duration. Pale connectors turn through rounded right
angles and attach to small circular ports. A matrix is summarized as one group
with a completed-job count. The documentation explicitly defines icons as job
status and connections as dependencies. Clicking a job opens its logs.

Sources: [visualization graph documentation](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph),
[official screenshot](https://docs.github.com/assets/cb-63715/images/help/actions/workflow-graph.png).

**Apply to relay:** give tasks fixed positions, recognizable names and one status.
Use a restrained branch and merge for parallel execution. Keep the connectors
visible before any animation begins. Animate an active task's status, not a
collection of anonymous dots that the visitor has to track. Do not draw a
dependency edge where the relationship is actually a worker handoff.

## 2. Trigger.dev: one execution, several distinct moments

The published timeline uses one vertical spine with small event ticks. Labels and
timestamps sit beside the spine. The running interval becomes thicker than the
waiting interval. Triggered, dequeued, started and finished remain distinct
moments; the finished example retains the preceding events. The release notes
describe the full journey from trigger to completion.

Sources: [run timeline release notes](https://trigger.dev/changelog/run-page-timeline),
[official timeline image](https://trigger.dev/changelog/run-page-timeline/run-timeline-definitions.png),
[observability product page](https://trigger.dev/product/observability-and-monitoring).

**Apply to relay:** a job gets one continuous trace, with the worker changing at a
checkpoint. The trace preserves the work already done. A quiet tick marks the
handoff; the active interval resumes on the next worker. Use the existing graphic
labels and leave the surrounding marketing text alone. This is clearer than
recreating the whole job as a new panel after every transition.

## 3. Dagster: progressive detail and meaningful grouping

Dagster's 1.6 release changed lineage from vertical flow to left-to-right flow and
added collapsible asset groups. In the published screenshot three source assets
converge into a collapsed group, which continues through a short chain of further
groups. Nodes carry identity and state while the connectors remain subdued. A
later UI release lets users toggle metadata facets so that lineage can show only
asset names or additional details.

Sources: [1.6 design changes and screenshot](https://dagster.io/blog/dagster-1-6-back-to-black),
[official lineage image](https://dagster.io/blog-assets/5d8f0e4e9b8c8320367c.png),
[lineage facets](https://dagster.io/blog/introducing-the-new-dagster-plus-ui).

**Apply to relay:** simplify the topology first. Show one branch, three meaningful
tasks and one merge. Avoid rendering every provider, checkpoint, document and
status as another graph node. State belongs on the existing object unless it has
its own causal role. A landing-page diagram can use the names-only level of detail.

## 4. Temporal: readable state before detailed history

Temporal's release notes describe event rows that expose important information
for scanning, with related scheduled, started and completed events available
inside the selected row. It supports filtering for pending and failed events,
viewing attempts and retry times, and pausing live updates to investigate.

Source: [event history timeline update](https://temporal.io/changelog/updated-event-history-timeline-view-is-now-available).

**Apply to relay:** an animation should hold the limit and checkpoint states long
enough to read them. A visitor should be able to understand the current state from
the frozen graphic. The active motion should not erase the event that explains
why a handoff occurred. Use this as an interaction principle rather than copying
a dense event-history table into the landing page.

## 5. n8n: connections attach to identifiable objects

The official connection example shows large, recognizable node symbols with
names underneath, plus a secondary operation label. Input and output ports have
distinct positions. The documentation defines a connection as passing data from
one node's output to the next node's input. Its execution documentation distinguishes
the workflow canvas from saved execution inspection.

Sources: [connections and official animation](https://docs.n8n.io/build/understand-workflows/workflow-components/connect-nodes-together),
[execution views](https://docs.n8n.io/build/understand-workflows/understand-executions/types-of-executions).

**Apply to relay:** attach each connector to a visible object. Keep the flow
direction consistent. Provider symbols can identify the workers without becoming
floating decorative logos. Borrow the legibility, while keeping relay's quieter
monochrome styling and avoiding an editor toolbar or a canvas full of controls.

## Proposed direction

Use a small family of real software diagrams rather than one repeated dashboard
card. The handoff is a continuous job trace with a checkpoint. Recovery is a short
git-like branch returning to a saved point. Parallel work is a compact dependency
graph. The time comparison is two aligned execution traces on one axis. Each has
one primary relationship and enough fixed structure to read with motion disabled.

The design recommendation is to animate state changes in place: a completed mark,
an active segment, a worker transition. Settle into a composed final state after
the explanatory sequence. These are inferences from the references, not features
claimed by the source products. None requires changing the landing page's copy,
typography or section layout.
