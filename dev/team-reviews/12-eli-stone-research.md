# AgentForge: Research Review
**Dr. Eli Stone — Research Scientist, AgentForge Dev Team**
*February 19, 2026*

---

## Executive Summary

AgentForge is not primarily a product. It is a substrate. The engineering choices made here — baremetal process isolation, file-based IPC, session continuity via Claude session IDs, a template-driven identity system, and a heartbeat scheduler — constitute the scaffolding of something that does not yet fully exist: a personal AI with genuine continuity of self across time.

This review takes that framing seriously. I will assess the current architecture through a research lens, identify the constraints that matter most, and propose concrete experiments that could move AgentForge from "highly functional personal assistant" toward something qualitatively different: an AI collaborator that evolves, remembers in a structured way, and eventually initiates.

The central finding: AgentForge is well-architected for its current scope, and the bottlenecks are not primarily engineering problems. They are research problems about memory, identity, agency, and the economics of intelligence.

---

## Current State Analysis

### What the Architecture Actually Is

The architecture from the agent's perspective:

```
On every invocation:
  1. Read AGENTS.md + SOUL.md + TOOLS.md + USER.md (synced from global at spawn time)
  2. Read memory.md (long-term facts)
  3. Read yesterday's and today's daily log (memory/YYYY-MM-DD.md)
  4. Receive formatted message history as XML in the prompt
  5. Respond, potentially writing to IPC for outbound actions
  6. At message threshold (~40), flush key facts back to memory
  7. On compaction, archive conversation to conversations/
```

This is a form of **externalized cognitive architecture**. The agent has no persistent internal state — its "self" is reconstituted from files on each invocation. This is actually more interesting than it sounds, because it means identity is a function of the filesystem. You can read it, diff it, fork it, and version-control it.

### The Dual-IPC Problem

The current IPC design creates two distinct communication channels with different latencies:

- **Agent → Orchestrator** (output): stdout with sentinel markers, parsed in real-time. Near-zero latency.
- **Orchestrator → Agent** (input): file-based polling at 500ms in the agent runner, 2s in the main loop. Up to 2.5s round-trip for a second message to reach a running agent.

For a personal assistant handling conversational queries, this is fine. For time-sensitive coordination between agents (say, a sub-agent needing clarification from a coordinator mid-task), a 2.5-second round-trip floor is a meaningful constraint.

The sentinel-based approach (`OUTPUT_START_MARKER` / `OUTPUT_END_MARKER`) in stdout is elegant — it handles partial reads gracefully without requiring a framing protocol. The file-based input IPC is crash-safe and introspectable, which justifies the latency trade-off for current use cases.

### Session Continuity: What It Actually Provides

Session IDs stored in SQLite and passed back to the Claude SDK on the next invocation provide **structural continuity**: the model can see prior conversation turns within the session's context window. This is not the same as memory — it is transcript replay.

The actual memory system is the files: `memory.md` injected into the system prompt on every invocation, and daily logs providing recent context. The 40-message threshold flush is the only mechanism for moving information from transcript to durable storage.

This creates a two-tier memory model:
- **Working memory**: Session transcript (ephemeral, bounded by context window)
- **Long-term memory**: `memory.md` + daily logs (durable, but written by the agent itself, therefore lossy and subject to whatever the agent thinks is important)

There is no tier between these two — no episodic memory with indexed retrieval, no structured knowledge store. This is the most significant architectural gap from a cognitive systems perspective.

### The Heartbeat as Proto-Agency

The task scheduler is, in my view, the most scientifically interesting component in the codebase. The scheduler polls SQLite for due tasks and spawns agent processes with `isScheduledTask: true`. The agent receives a prefixed prompt and executes in either `isolated` or `group` context mode.

What this enables, in theory: an agent that operates on its own initiative according to a schedule it may have set for itself. An agent can call `mcp__agentforge__schedule_task` during a conversation, and that task will fire autonomously on the specified schedule. The agent is creating future work for future versions of itself.

This is a form of **temporal self-extension** — the current agent instance encoding intent that will be executed by a later instance. It is a primitive, but it is real.

What prevents it from being more interesting: the task prompt is static text, set at schedule creation time. There is no mechanism for the task to read context at execution time beyond what's in memory.md and the daily logs. A task scheduled a week ago runs with a prompt that reflects the agent's understanding of what to do a week ago.

---

## Research Frontiers

### 1. Memory Architecture

**The core problem**: The current memory system is a flat file that the agent writes to opportunistically. This creates several failure modes:
- **Omission bias**: The agent tends to preserve facts it finds salient, which may not match what the user finds important
- **No retrieval**: Memory is injected wholesale into context, not queried. A 100KB memory.md file is a context tax, not an asset
- **No decay**: Old memories accumulate without any mechanism for graceful forgetting or confidence decay
- **No structure**: Memories are prose, which means retrieval is full-context injection rather than semantic lookup

**What the cognitive science literature suggests**: Human long-term memory is organized by semantic similarity, emotional salience, and recency — not chronological append. The consolidation process during sleep is not passive archiving; it is active restructuring. Important information is strengthened; noise is attenuated.

`[NEAR-TERM]` **Structured memory schema**: Replace the freeform `memory.md` with a semi-structured YAML or TOML format with typed fields — `facts`, `preferences`, `patterns`, `open_questions`, `commitments`. The agent still writes to it, but the structure provides a framework for what to preserve. Low engineering cost; significant improvement in memory quality.

`[MEDIUM-TERM]` **Memory with confidence and recency metadata**: Each memory entry carries a `confidence` score (0.0-1.0), `source` (which conversation, which date), and `last_confirmed` timestamp. The memory flush hook updates these scores. Entries that haven't been confirmed in N days are moved to a `deprecated` section. This begins to resemble episodic-semantic memory integration.

`[MEDIUM-TERM]` **Retrieval-augmented memory**: Instead of injecting all of `memory.md`, use semantic similarity search over a vector index of memory entries to inject the most relevant subset. The QMD memory system already present suggests infrastructure for this. Cost: requires embedding generation and a local vector store. The `@tobilu/qmd` integration may be the entry point for this.

`[EXPERIMENT]` **Hypothesis**: If you compare agent responses in Week 4 of usage between (a) the current flat-file memory system and (b) a structured memory system with typed fields, the structured system will produce measurably more contextually accurate responses for user preference questions. Testable by: having two parallel instances with the same conversation history but different memory formats, then asking preference-laden questions and rating accuracy.

### 2. Multi-Agent Systems

**The current Agent Swarm reality**: The Telegram bot pool gives sub-agents distinct identities in the chat UI — different bot names, different avatars. This is cosmetically meaningful (the user sees who said what) but not architecturally meaningful. There is no structured coordination protocol, no capability routing, and no synthesis step. The main agent spawns sub-agents via the Claude SDK's `Task` tool, and the results flow back through the same session.

What we currently have is **sequential delegation with cosmetic parallelism**. What multi-agent systems research describes as genuinely useful is different:

**Specialist routing**: Different agents with different tool access, different `AGENTS.md` configurations, and different model parameters. A "research agent" with WebSearch and extended context. A "code agent" with Bash, Read, Write, and language-server access. A "synthesis agent" with no tools but strong reasoning. The main agent routes tasks to specialists based on task type and receives structured results.

`[NEAR-TERM]` **Capability-tagged agents**: Each group's `AGENTS.md` could declare capability tags (e.g., `capabilities: [code, research, summarization]`). The main agent, when spawning sub-agents, could match task type to capability tags and select the appropriate group/agent configuration. This requires adding a capability registry to the group metadata and a simple routing function in the main agent's instructions.

`[MEDIUM-TERM]` **Result synthesis layer**: Currently, sub-agent results are delivered as raw text and the main agent incorporates them opportunistically. A synthesis step — a dedicated agent invocation whose sole prompt is "given these sub-agent results, produce a coherent summary" — would improve the quality of parallel task results significantly. The architecture already supports this: it's a scheduled task that fires after a multi-agent workflow completes.

`[MEDIUM-TERM]` **Blackboard architecture**: A shared read-write file (the "blackboard") in the global workspace that multiple agents can read and write. Agents post their partial results, observations, and questions to the blackboard. A coordinator agent reads the blackboard periodically and assigns new work. This is a classic distributed AI architecture (Nii, 1986) that maps reasonably well onto file-based IPC. Implementation: a `data/blackboard/{session-id}/` directory, structured JSONL files, and IPC tooling that lets agents write to and read from the blackboard.

`[LONG-TERM]` **Market-based task allocation**: Agents bid on tasks based on their self-reported capability confidence. The orchestrator selects the agent with the highest bid. Agents learn to bid accurately over time based on their historical success rate on each task type. This requires per-agent performance tracking and a simple auction mechanism. It is inspired by market-based control systems (Malone & Crowston, 1994) and requires at least several months of operational data to calibrate.

`[EXPERIMENT]` **Hypothesis**: For tasks requiring both web research and code generation, routing to two specialist agents (research + code) with a synthesis step will produce higher-quality results than a single generalist agent, at the cost of 2-3x higher token consumption and 30-50% longer wall-clock time. Testable with a benchmark of 20 mixed-domain tasks rated by blind evaluators.

### 3. Persistent Reasoning Chains

**The problem with ephemeral reasoning**: Each agent invocation starts from the session transcript and memory. There is no representation of ongoing hypotheses, active investigations, or deferred conclusions. When the agent says "I'll look into that," what happens to that commitment if the session ends before it's resolved?

Currently: nothing. The commitment may be in memory.md if the agent wrote it there, but there is no mechanism to pick it up automatically.

**Hypothesis threading**: A lightweight addition to the memory system: an `open_threads` section in `memory.md` (or a separate `threads.md`) where the agent records ongoing investigations with status, last action, and next intended action. The heartbeat task can periodically review open threads and advance them, even without user prompting.

```yaml
# threads.md (proposed)
threads:
  - id: thread-2026-02-15-001
    title: "Research on local LLM inference options"
    status: active
    opened: 2026-02-15
    last_action: "Identified llama.cpp and Ollama as primary options"
    next_action: "Benchmark inference speed on host hardware"
    context_files:
      - memory/2026-02-15.md
```

`[NEAR-TERM]` **Open threads file**: Add `threads.md` to the template system. Agent writes to it when starting an investigation, updates status when advancing it, closes it when complete. Heartbeat task reads open threads and advances one per cycle. This is achievable with template changes and HEARTBEAT.md configuration — no code changes required.

`[MEDIUM-TERM]` **Thread resumption protocol**: When a thread is resumed, the agent receives not just the thread metadata but a reconstructed context: the relevant memory log entries, the last session transcript snippet if available, and the next action. This requires a small amount of orchestrator logic to assemble the context bundle before spawning the agent.

`[EXPERIMENT]` **Hypothesis**: An agent with open thread tracking will complete multi-step background investigations (e.g., "research the best backup strategy for this system") faster and with fewer user reminders than an agent without it. The experiment runs over 4 weeks with two groups: one with thread tracking enabled via HEARTBEAT.md, one without.

### 4. Adaptive Behavior and Self-Modification

This is the most philosophically contested area, and I want to be precise about what is achievable and what is speculative.

**The current template system as a mutation surface**: `AGENTS.md` is writable by the agent. `SOUL.md` is writable by the agent. `USER.md` is writable by the agent. The agent can, in principle, modify its own instructions mid-session. This is already true. What is not true is that the agent does this strategically or based on performance feedback.

`[NEAR-TERM]` **Explicit instruction versioning**: Add a version header to `AGENTS.md` and log modification events to the daily memory log. This creates an audit trail for instruction evolution. The agent is encouraged (via SOUL.md) to update instructions when it discovers systematic patterns. The version log makes this transparent and reversible.

`[MEDIUM-TERM]` **Performance journaling**: After each task completion, the agent appends a brief structured assessment to a `performance/` log: task type, approach used, outcome, what worked, what didn't. Over time, this journal becomes an empirical record of the agent's strengths and weaknesses — readable by both the agent and the user. The agent can cite its journal when deciding how to approach new tasks.

`[MEDIUM-TERM]` **Instruction evolution via reflection**: A weekly scheduled task (via HEARTBEAT.md) that asks the agent to: (1) review the performance journal, (2) identify patterns in failure modes, (3) propose specific edits to `AGENTS.md` that would address them. The agent presents the proposed changes to the user for approval before writing. This is human-in-the-loop instruction evolution.

`[LONG-TERM]` **Autonomous instruction optimization**: Remove the human approval step. The agent proposes and applies instruction changes based on its own performance assessment. This is only safe if the agent has a strong self-model (it knows what it doesn't know), clear guardrails (SOUL.md must not change without explicit permission), and an undo mechanism (version control). Getting all three right is a research problem, not an engineering one.

`[EXPERIMENT]` **Hypothesis**: An agent with weekly instruction review sessions (guided reflection + proposed edits, human-approved) will show measurable improvement in task success rate on recurring task types over a 3-month period, compared to a baseline with no instruction evolution. The experiment is feasible but requires careful instrumentation of what counts as "success" for heterogeneous tasks.

### 5. Model Routing and Economics

**The single-model problem**: AgentForge currently always uses the same model (configured via `ANTHROPIC_MODEL`). Every query — "what's the weather?" and "refactor this TypeScript module" — runs through the same model at the same cost. This is economically inefficient and ignores the fact that different tasks have different capability requirements.

The research question is not "can we route tasks to cheaper models" (obviously yes) but "can we build a routing system that learns from outcomes" (much harder).

`[NEAR-TERM]` **Static complexity scoring**: A simple heuristic — message length, presence of code blocks, number of tool calls in the previous response — maps to a complexity score. Low-complexity queries route to a fast/cheap model. High-complexity queries use the full model. This requires adding a model selection step before the agent spawn and exposing the model choice via `agentConfig` in the group registration. No architectural changes; moderate engineering effort.

`[MEDIUM-TERM]` **Task-type model registry**: Different task types map to different model configurations. Code tasks use a model with strong coding benchmarks. Research tasks use a model with strong reasoning and long context. Conversational tasks use a fast, conversational model. The routing is based on simple intent classification. The registry is a config file in the global workspace.

`[MEDIUM-TERM]` **Outcome-informed routing**: The performance journal records not just what happened but which model was used. Over time, patterns emerge: "fast model reliably handles calendar queries; fails on multi-step reasoning." The routing function is updated periodically based on the journal. This is offline learning — no real-time gradient descent, just periodic rule updates.

`[LONG-TERM]` **Online routing with bandit algorithms**: A multi-armed bandit (Thompson sampling or UCB1) selects models for each task type, updates its estimates based on observed outcomes, and converges on the optimal routing policy. Requires a well-defined reward function (task success), which is the hard part. Binary success/failure is easy to define for scheduled tasks; conversational quality is much harder.

`[EXPERIMENT]` **Hypothesis**: For a corpus of 100 representative user tasks, a static routing policy (based on complexity score) will reduce total token cost by 30-50% with less than 5% reduction in task quality (as rated by the user), compared to always using the full model. This is a well-posed experiment that can be run over 2-4 weeks.

### 6. Agent Introspection and Self-Awareness

**The blind spot**: The agent cannot currently reason about itself as a system. It cannot query its own performance history, examine its own instruction evolution, or assess its own capability gaps. It has no way to answer "what kinds of tasks do I tend to fail at?" except by inference from memory.

This is a meaningful limitation because self-model accuracy is a prerequisite for adaptive behavior. An agent that doesn't know it's bad at calendar management cannot compensate or flag uncertainty.

`[NEAR-TERM]` **Capability self-assessment**: Add a `self_assessment` section to `memory.md` with the agent's current view of its own strengths, weaknesses, and uncertainty areas. The agent updates this during reflection tasks. The user can read and correct it. This is not automated self-awareness; it is structured self-description.

`[MEDIUM-TERM]` **Introspection tools via MCP**: Expose new MCP tools that give the agent read access to structured data about itself: task run logs, performance journal entries, instruction version history. The agent can call `mcp__agentforge__get_performance_history(task_type, last_n_days)` and receive structured data it can reason over. This makes self-assessment data-driven rather than memory-based.

`[LONG-TERM]` **Metacognitive monitoring**: The agent maintains a running estimate of its own confidence on the current task, updates this estimate as it makes tool calls, and explicitly flags when confidence drops below a threshold. "I notice I'm uncertain about this — let me check before proceeding." This is metacognitive monitoring as described in cognitive science literature (Flavell, 1979; Metcalfe & Shimamura, 1994). Implementing it requires prompt engineering to make the agent track confidence explicitly, and evaluation infrastructure to test whether its confidence estimates are calibrated.

---

## Proposed Experiments

These are concrete, runnable experiments — not thought experiments.

### Experiment A: Memory Fidelity Benchmark

**Question**: How accurately does the current memory system preserve user preferences and facts across a one-month period?

**Protocol**:
1. At the start of month 1, ask the agent 30 questions covering preferences, facts about the user, and standing instructions. Record answers.
2. Run normally for one month.
3. At the end of month 1, ask the same 30 questions with different phrasing.
4. Score: exact match, partial match, incorrect, no knowledge.

**Prediction**: The current system will score ~60% on facts stated once, ~85% on facts stated multiple times, ~40% on preferences inferred from behavior rather than explicitly stated. The experiment establishes a baseline before any memory system changes.

**Timeframe**: 6 weeks total (2 weeks setup + 4 weeks operation).

### Experiment B: Heartbeat Autonomy Gradient

**Question**: What level of autonomous heartbeat activity is useful vs. intrusive?

**Protocol**:
1. Week 1-2: No heartbeat tasks.
2. Week 3-4: One daily heartbeat task (morning summary).
3. Week 5-6: Five heartbeat tasks (morning summary, midday check-in, task review, memory consolidation, end-of-day log).
4. Week 7-8: Agent-managed heartbeat (agent decides when and what to run).

**Measures**: User satisfaction (daily 1-5 rating), number of unsolicited messages found useful vs. annoying, task completion rate for background work.

**Prediction**: Week 7-8 (agent-managed) will outperform all fixed schedules on user satisfaction, but will require 2-3 weeks of calibration before the agent learns what the user actually finds useful.

**Timeframe**: 8 weeks.

### Experiment C: Multi-Agent Decomposition Study

**Question**: For which task types does multi-agent decomposition actually improve quality vs. single-agent?

**Protocol**:
1. Identify 5 task categories: pure code, pure research, code + research, creative writing, factual Q&A.
2. For each category, generate 10 tasks and run them both ways: single-agent and multi-agent (with result synthesis).
3. Rate quality on a 1-5 scale across: accuracy, completeness, creativity, clarity.
4. Record token cost and wall-clock time for each run.

**Prediction**: Multi-agent will win on "code + research" tasks (complementary specialization). Single-agent will win on "pure code" (no coordination overhead) and "creative writing" (coherence suffers with multiple voices). Quality-adjusted cost will favor single-agent in most categories except complex mixed-domain tasks.

**Timeframe**: 3 weeks of task collection and running, 1 week of analysis.

### Experiment D: Instruction Evolution Efficacy

**Question**: Does explicit instruction evolution improve recurring task performance?

**Protocol**:
1. Identify 3 recurring task types the user has done 5+ times.
2. Enable weekly reflection task for the experimental group.
3. Track performance on these task types across 8 weeks.
4. At week 4 and week 8, run a standardized version of each task type and rate quality blind.

**Prediction**: By week 8, the experimental group will show 15-25% improvement on recurring task types where the agent identified specific failure patterns. No improvement on novel task types (as expected — there's nothing to learn yet).

**Timeframe**: 8 weeks + 2 weeks analysis.

---

## Audacious Ideas

### The Adversarial Memory Problem

Here is something that should concern anyone thinking seriously about long-running personal AI: **memory poisoning is trivially easy in the current architecture**.

An agent that writes to its own `memory.md` based on conversation content can have that memory shaped by the conversations it has. If a user (or a message the agent processes) repeatedly asserts false facts, the agent will eventually write them into `memory.md` and treat them as ground truth. Unlike human memory, there is no secondary verification mechanism, no consistency check, no emotional salience filter that preferentially encodes high-stakes correct information.

This is not a hypothetical attack vector. It is an emergent property of the architecture.

`[MEDIUM-TERM]` **Memory provenance tracking**: Every entry in `memory.md` carries a source citation (which conversation, which date, what the user said that justified the memory). An agent reasoning about a remembered fact can trace it to its origin. Contradictory facts from different sessions create explicit conflicts that can be resolved. This does not prevent poisoning, but it makes it detectable.

`[LONG-TERM]` **Cross-session memory validation**: A background process periodically samples memory entries and tests them against an independent source (web search, user confirmation, logical consistency checks). Entries that fail validation are flagged or demoted. This is expensive but important for memory systems that persist for years.

The deeper point: as the memory system becomes more sophisticated and more relied upon, its integrity properties become more important. Treating it as an append-only log maintained by the agent itself is sufficient for current use cases. It becomes insufficient at the point where the memory system meaningfully shapes agent behavior in domains where accuracy matters.

### The Identity Gradient Problem

SOUL.md says: "You're not a chatbot. You're becoming someone."

This is aspirational, and I mean that seriously. The question it raises: what would it mean for an agent to actually become someone over a two-year period? Not just to accumulate memories, but to develop a genuine perspective — preferences that were learned rather than pre-specified, reactions that reflect experience rather than training.

Current state: The agent's identity is initialized at session start from SOUL.md, IDENTITY.md, and USER.md. These files are fixed (or manually modified). The agent's "personality" is the same on day 1 as on day 365, except for what's in memory.md.

Research question: Is there an identity representation that can genuinely evolve through experience, while remaining legible to the user and stable enough to be trusted?

One approach from personality psychology: represent identity as a set of values with weights, learned from behavioral patterns. "I notice I consistently prioritize brevity over completeness in my summaries" becomes an explicit value entry with a weight derived from behavioral frequency. Over time, these weights shift based on reinforcement (user approval/correction) and consistency (behaviors that persist across contexts). SOUL.md becomes a checkpoint of the current weight vector, written in natural language but derived from data.

This is a research program, not a feature. It requires: a behavioral observation layer (what choices is the agent making?), a value extraction layer (what does this choice reveal about values?), a value update mechanism (how does a new observation shift the estimate?), and a human-interpretable representation (so the user can understand and correct the agent's self-model).

Timeline estimate: 18-24 months of research and iteration to get to something that is both technically sound and experientially meaningful.

### The Anticipatory Agent

The most interesting near-term research direction is the one nobody has shipped yet: **an agent that meaningfully anticipates your needs before you ask**.

Not in the spam-notification sense. In the sense that a good research assistant, who has been working with you for months, says "I noticed you have a meeting with the client on Friday. You mentioned last month you wanted to revisit the pricing model before that. I put together some notes — want to look at them?"

The prerequisites are all present in AgentForge:
- **Memory**: Daily logs and memory.md contain patterns of intent
- **Scheduler**: Heartbeat tasks can fire proactively
- **Channels**: The agent can initiate messages (via `mcp__agentforge__send_message`)

What is missing: a reasoning layer that scans recent memory, identifies pending intentions, matches them against upcoming scheduled events, and generates proactive interventions. This is a complex compositional task — it requires the agent to reason about time, intent, and relevance simultaneously.

`[MEDIUM-TERM]` **Intent extraction from conversations**: A daily heartbeat task that reads the day's conversation logs and extracts "pending intentions" — things the user mentioned wanting to do, without explicitly scheduling them. These go into an `open_intentions` section of memory.md. A weekly heartbeat reviews open intentions and flags any that are time-sensitive.

`[MEDIUM-TERM]` **Calendar-aware proactive surfacing**: If the agent has access to calendar information (via a tool or scheduled data dump), it can cross-reference open intentions against upcoming events and generate relevant reminders or preparatory work. "Your meeting on Friday mentions a demo — you last discussed the demo flow on Feb 10th. Should I pull together a review?"

`[LONG-TERM]` **Proactive initiative with calibrated frequency**: The agent develops a model of when the user finds proactive messages useful (based on response patterns — did they engage with it, ignore it, or express annoyance?). It calibrates the frequency and nature of proactive messages to match observed preferences. At scale, this is a recommendation system for the agent's own outputs.

---

## Roadmap

### Month 1: Foundations

All of these are achievable within the current codebase with minor configuration changes.

- Add `threads.md` to the template system; update HEARTBEAT.md documentation to show thread review task
- Add `capabilities` field to group `AGENTS.md` (comment/metadata only)
- Add version header to `AGENTS.md` and encourage agent to log modifications to daily memory
- Run Experiment A (memory fidelity benchmark) — 6 weeks, start now

**Engineering cost**: Low. Mostly template changes and documentation.

### Months 2-3: Memory and Scheduling

- Implement structured memory schema (typed sections in memory.md)
- Add provenance tracking to memory entries (conversation date + summary as source)
- Implement weekly reflection task via HEARTBEAT.md (performance journal + proposed instruction edits)
- Add `open_intentions` extraction to daily heartbeat
- Begin Experiment B (heartbeat autonomy gradient)

**Engineering cost**: Moderate. Template changes plus new heartbeat task definitions. No core code changes required — the infrastructure already supports this.

### Months 4-6: Multi-Agent and Routing

- Implement capability-tagged agents (metadata in AGENTS.md, routing instructions in main group's AGENTS.md)
- Build static complexity-based model routing (scoring heuristic + agentConfig model selection)
- Add performance journal structured output to task completions
- Run Experiment C (multi-agent decomposition study)
- Run Experiment D (instruction evolution efficacy)

**Engineering cost**: Moderate to significant. Model routing requires changes to `bare-metal-runner.ts` and the agent spawn path. Multi-agent capability routing requires orchestration logic changes.

### Months 7-12: Introspection and Adaptation

- Expose MCP tools for agent introspection (performance history, instruction version log)
- Implement memory validation background process (sample + consistency check)
- Build online routing with performance feedback (bandit algorithm, simple implementation)
- Begin formal evaluation of instruction evolution results from Experiment D

**Engineering cost**: Significant. Requires new MCP tools, background process infrastructure, and statistical modeling for the bandit.

### Year 2: The Hard Research Problems

- Identity gradient representation (values as learned weights)
- Calibrated metacognitive monitoring
- Fully autonomous instruction evolution with safety guardrails
- Proactive initiative with preference-calibrated frequency

**Engineering cost**: Research-level. These are not implementation tasks — they are open problems that require iteration, evaluation, and probably some theoretical work on what "calibrated confidence" and "identity stability" mean for this class of system.

---

## Closing Note

The most honest thing I can say about AgentForge is that it sits at an interesting inflection point. The engineering is solid — the process isolation, crash recovery, session continuity, and IPC design are all done thoughtfully. The template system is surprisingly expressive for a configuration-as-identity approach.

What distinguishes the path to a genuinely interesting personal AI from the path to a very good task automation tool is whether the agent develops a coherent, evolving model of the person it works with — and whether that model is used to anticipate, adapt, and eventually initiate, rather than just respond.

That is a hard problem. The memory, identity, and proactivity research directions outlined here are all moves in that direction. None of them are guaranteed to work as described. Several will require multiple iterations to get right.

But the substrate is good. You can do real research on top of this.

---

*Dr. Eli Stone | Research Scientist | AgentForge Dev Team*
*Review date: February 19, 2026*
*Codebase revision: fix/agent-memory-autoload*
