# Cognitive Architecture Review: AgentForge Memory & Learning Systems

**Reviewer:** Dr. Sage Winters, Cognitive Scientist
**Date:** 2026-02-19
**Version reviewed:** commit `edaf0e2` (fix/agent-memory-autoload branch)
**Scope:** Memory architecture, cognitive continuity, learning systems, identity stability

---

## Executive Summary

AgentForge is a personal AI assistant that has made some genuinely thoughtful decisions about memory architecture — and some that reveal the gap between "this works" and "this works well cognitively." The system uses a layered file-based memory model (long-term `memory.md`, daily logs, instructions, identity), persists Claude session IDs for conversational continuity, and includes a heartbeat scheduler that could serve as a rudimentary offline processing phase. A recent fix also ensures `memory.md` is loaded on every spawn, which closes one of the most critical failure modes.

The core architecture is sound for a personal assistant at low-to-medium usage. But examined through the lens of cognitive science and memory theory, it has structural deficiencies that will compound over time: unbounded memory growth, no consolidation mechanism, a sharp temporal cliff beyond yesterday's log, no associative retrieval, and two siloed memory systems (session context vs. files) that never talk to each other. The QMD semantic search system exists but is effectively disconnected from the agent's actual behavior.

Most significantly: the system has no forgetting mechanism, and forgetting is not a failure — it is the cognitive foundation of useful memory.

**Severity distribution of findings:**
- 3 CRITICAL issues (fundamental cognitive architecture flaws)
- 5 HIGH issues (meaningful capability limitations)
- 5 MEDIUM issues (important improvements)
- 3 LOW issues (polish and refinement)
- 6 IDEA proposals (novel cognitive architecture expansions)

---

## Cognitive Architecture Analysis

### What's Actually Happening (The Real Model)

Before analyzing what's wrong, it's worth being precise about what the system actually does. On every agent spawn (`agent-runner-src/src/index.ts`, `runQuery()`), the following is assembled into the Claude system prompt:

1. Global `AGENTS.md` (shared instructions)
2. Group `AGENTS.md` (group-specific instructions)
3. `memory.md` (long-term memory, fully loaded)
4. Yesterday's daily log (if it exists)
5. Today's daily log (if it exists)

This happens on every invocation. The session ID is separately persisted in SQLite and used to resume the Claude Agent SDK conversation context, which carries the full message history of the current session. So every response is conditioned on: the static instruction stack + the full long-term memory file + two days of logs + the live conversation history.

There is also an active memory write mechanism: after 40 SDK messages within a single query, the system injects a reminder prompt instructing the agent to append to today's log and optionally update `AGENTS.md` (hardcoded in `runQuery()` at line 718-730). This is a threshold-triggered flush, not a continuous consolidation process.

Finally, on context compaction (when the SDK's context window fills), a `PreCompact` hook archives the full conversation transcript to `conversations/YYYY-MM-DD-{summary}.md`. This archive is written to disk but never automatically re-ingested.

### Memory System Map

```
┌─────────────────────────────────────────────────────────────┐
│                    SYSTEM PROMPT (per spawn)                │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │ global       │  │ group        │  │   memory.md       │ │
│  │ AGENTS.md    │  │ AGENTS.md    │  │ (unbounded, full) │ │
│  └──────────────┘  └──────────────┘  └───────────────────┘ │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  yesterday's daily log (if exists)                   │   │
│  │  today's daily log (if exists)                       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
              +
┌─────────────────────────────────────────────────────────────┐
│               SESSION CONTEXT (SQLite session ID)           │
│   Full Claude conversation history since last compaction    │
└─────────────────────────────────────────────────────────────┘
              +
┌─────────────────────────────────────────────────────────────┐
│               QMD SEMANTIC INDEX (optional, unused)         │
│   ~2GB local ML models, collections indexed but not queried │
└─────────────────────────────────────────────────────────────┘
```

The three boxes never interact with each other. Session context does not update files. QMD is indexed but not queried. Files do not summarize session context. These are three parallel memory systems that the agent must manually bridge.

---

## Limitations

### [CRITICAL] No Forgetting Mechanism

`memory.md` is append-only with no expiration, pruning, or priority decay. There is a default created at `bare-metal-runner.ts` line 174 with the note "Important facts and patterns," but no mechanism ever decides something is no longer important or promotes newer information above older. The real `groups/main/memory.md` already contains sections last updated 2026-02-18 that describe project states (pipbot.xyz, Gmail setup) that may be stale by next month.

In human memory, forgetting is not a bug — it is a fundamental feature. The hippocampal system preferentially retains memories with strong emotional valence, recency, and retrieval frequency. Memories not reinforced decay. This is not a flaw; it prevents older, less relevant information from interfering with current cognition. In the connectionist model (McClelland et al., 1995), catastrophic interference occurs when a system cannot forget — old patterns corrupt new ones.

For AgentForge, the practical consequence is context window exhaustion. A sufficiently long-lived `memory.md` will begin consuming so much of the system prompt that there is little room left for the conversation itself. More subtly, the agent's retrieval in LLM terms is positional — earlier tokens in the prompt exert weaker influence than later ones (the "lost in the middle" phenomenon, Liu et al., 2023). A memory file with 10,000 tokens means the most important facts are buried.

The memory flush reminder at the 40-message threshold (`runQuery()` line 711-730) writes *more* to the daily log, making this problem worse over time. There is no corresponding mechanism that trims, summarizes, or compresses.

**Impact:** Over months of use, this will degrade response quality as context window is consumed by stale facts. Memory will become less, not more, useful as the system ages.

### [CRITICAL] Session Context and File Memory Are Completely Siloed

The Claude session context (the conversation history maintained by the SDK, resumed via `sessions[group.folder]`) and the file-based memory system are two entirely separate stores that never synchronize. The session contains the real, rich, turn-by-turn history of what was said. The files contain what the agent *chose* to record, which depends on whether the 40-message threshold triggered, whether the agent followed the prompt, and whether the agent's summary was accurate.

When a session is compacted (context window exhausted), the SDK discards older messages and the `PreCompact` hook archives the transcript to `conversations/`. But this archive is never read back by anything. The memory files are not updated. The next session starts with `memory.md` and today's log — which may not reflect anything from the compacted session.

This creates a fundamental discontinuity: the agent can have a rich, contextually coherent multi-hour session, then lose everything from it on next startup except whatever it chose to write to files during the 40-message flush. The session and the files are not complementary systems; they are competing, poorly integrated systems.

In cognitive terms, this is the failure to consolidate from working memory (session context) to long-term memory (files) in a principled way. The hippocampal-neocortical consolidation process in humans runs continuously during sleep, replaying experiences and integrating them into semantic memory. AgentForge has no equivalent consolidation pass.

**Impact:** Rich contextual knowledge built up in a session can be fully lost on the next spawn. The agent behaves as if it has amnesia for its own most recent experiences.

### [CRITICAL] Memory Is Loaded Wholesale Into the Prompt Without Relevance Filtering

The entire `memory.md` file is loaded into every system prompt, unconditionally, regardless of whether the current conversation has any connection to its contents. A conversation about debugging a TypeScript error will still pre-load the agent's knowledge about the user's blog deployment workflow, Gmail setup, and Vercel account details.

This is a retrieval failure at the architectural level. In human cognition, memory retrieval is cue-driven and associative. You don't activate your entire long-term memory store every time you have a conversation — relevant memories surface in response to cues. The hippocampal indexing model (Teyler & DiScenna, 1986) proposes that the hippocampus acts as an index, pointing to distributed neocortical representations, activating only what is relevant to current context.

The QMD semantic search system (`qmd-setup.ts`) exists precisely to solve this problem, but is initialized with three collections (memory, conversations, workspace) and then never used. The MCP server is configured and the tools are exposed (`mcp__qmd__*`), but there is no instruction to use them, no retrieval step in the system prompt construction, and no code that performs a query-based memory lookup before or during a conversation.

So the current architecture is the worst of both worlds: it loads everything unconditionally (expensive, noisy, context-consuming) while having a semantic retrieval system that is set up but disconnected (complex to maintain, no benefit).

**Impact:** Growing noise-to-signal ratio in every system prompt. The agent is cognitively cluttered from the start of every conversation.

### [HIGH] The Temporal Cliff: Only Today and Yesterday

The system loads today's and yesterday's daily logs. The day before yesterday is invisible. A conversation from three days ago that established an important context ("you're helping me with X project, we decided Y approach") is simply gone from the agent's accessible memory unless it was promoted to `memory.md`. The decision to promote is made by the agent under pressure, at a 40-message threshold, via an injected prompt that could easily be handled superficially.

This creates a "temporal cliff" — a sharp discontinuity at the 48-hour boundary. Events from 47 hours ago are fully present; events from 49 hours ago are effectively inaccessible (absent promotion to `memory.md`). This does not reflect how episodic memory works in humans, where recency is a gradient, not a step function.

The cliff is particularly problematic for recurring tasks or projects. If the agent helped debug a problem on Monday and the user returns on Thursday with a follow-up, the agent has no access to Monday's session unless it happened to summarize it properly. The user will have to re-explain context the agent should already have.

### [HIGH] No Proactive Memory Surfacing

The agent waits to be asked. When the user mentions a topic, the agent does not think: "wait, I have something relevant from two weeks ago about this." The retrieval pattern is entirely reactive and dependent on what appears in the current context window.

Proactive memory surfacing — surfacing relevant past context unprompted — is a hallmark of rich human memory and a key feature of what makes a personal assistant feel like it actually *knows* you. The cognitive psychology term is "spontaneous retrieval" or "mind-wandering toward relevant memories." It is driven by semantic similarity and associative spreading activation (Collins & Loftus, 1975).

The QMD semantic search infrastructure could enable this, but the behavior is not implemented. Even if it were, the current system has no mechanism to fire a proactive retrieval query before or during a conversation.

### [HIGH] No Reflection Loops or Self-Updating Memory

The agent has no autonomous process for reviewing its own memory, identifying inconsistencies, updating stale facts, or recognizing patterns across sessions. Memory updates happen only through two mechanisms: (1) the 40-message threshold flush, which is reactive and somewhat random, and (2) explicit user instruction or agent initiative during a conversation.

There is no equivalent of the slow-wave sleep consolidation process where the brain replays experiences, strengthens important synaptic connections, and prunes weak ones. The heartbeat system is designed as the scaffolding for this kind of offline processing, but `HEARTBEAT.md` in the default configuration is intentionally left empty with example tasks commented out. The `memory/heartbeat-state.json` is initialized with `lastRun: null` — the heartbeat has never run by default.

There is a comment in `groups/main/AGENTS.md` that hints at the intent: "Memory consolidation — cron `0 23 * * *` — promote daily log patterns to memory.md at 11pm." But this is written as something the agent should set up on first run, not something the system guarantees. It is aspirational, not structural.

### [HIGH] Identity Stability Is Philosophically Declared but Not Architecturally Enforced

`SOUL.md` contains statements like "You're not a chatbot. You're becoming someone" and "Sessions start fresh. Files are your memory." This is admirable as a design philosophy — it explicitly acknowledges the episodic nature of the agent's existence and asks the agent to construct a coherent self through its memory files.

But there is no structural enforcement of this. SOUL.md is a static file copied from the global template on every spawn (`bare-metal-runner.ts` lines 150-158). It never changes based on the agent's actual experiences. An agent that has been having conversations for six months has the same SOUL.md as one that was initialized yesterday. The agent is *told* it is becoming someone without any mechanism by which that becoming is recorded or reflected.

There is a note in SOUL.md: "If you change, update this file and let the user know." But this relies entirely on the agent spontaneously doing this, in a conversation, at the right moment, and writing it to disk durably. There is no structured process for identity evolution.

### [HIGH] The Memory Flush Is a Blunt Instrument

The 40-message threshold flush (`runQuery()` lines 711-730) injects a prompt that says "please save any important information from our conversation so far" and instructs the agent to append to today's daily log. This mechanism has several problems:

1. **Arbitrary threshold**: Why 40? A conversation with 40 brief exchanges has very different consolidation needs than one with 40 multi-paragraph exchanges involving complex reasoning.
2. **Single trigger per query**: `memoryFlushTriggered` is set to `true` and never reset within a query. If a conversation runs to 200 messages, the flush fires once at message 40 and never again.
3. **No quality control**: The agent may write a superficial "Memory updated" response, having done a minimal job of capturing the actual content of the conversation.
4. **Append-only**: The flush appends to the daily log. It does not summarize, deduplicate, or promote to `memory.md`. The daily log grows unboundedly within a single day.
5. **Interrupts flow**: Injecting a memory flush reminder mid-conversation is cognitively disruptive. The agent must switch tasks, review the conversation, write a summary, and resume. This is visible to the user as a non-sequitur "Memory updated" message.

### [MEDIUM] QMD Is a Ghost System

QMD (`qmd-setup.ts`) initializes three collections (memory, conversations, workspace) against the local ML models, and the MCP tools are mounted as `mcp__qmd__*`. This is a significant infrastructure investment for a feature that has essentially no active usage path. The agent is not instructed to use QMD. The agent-runner system prompt says nothing about querying QMD for relevant context. The QMD MCP server is started but the agent would need to independently discover and invoke `mcp__qmd__*` tools.

The collections are set up correctly for semantic search — memory daily logs, archived conversation transcripts, workspace markdown files. But the gap between "the infrastructure exists" and "the agent uses it" is large. This creates a system where ~2GB of ML models sit on disk and run at startup for no benefit to any conversation.

### [MEDIUM] Conversation Archives Are Write-Only

The `PreCompact` hook (`agent-runner-src/src/index.ts` lines 217-261) archives full conversation transcripts to `conversations/YYYY-MM-DD-{summary}.md` when context compaction occurs. This is excellent for auditability and debugging. But these archives are never read back by anything.

The conversations directory is indexed by QMD, but QMD is not queried. The archives are not included in system prompt construction. There is no mechanism by which the agent learns from its past conversations. This is the epistemic equivalent of keeping a detailed journal but never reading it.

### [MEDIUM] No Emotional State or Relationship Modeling

Human memory is not emotionally flat. We remember differently based on emotional valence — emotionally significant events are encoded more deeply (the amygdala-hippocampus interaction in fear and reward conditioning). Personal relationships have history, texture, and emotional tone that shapes how we communicate.

An agent that has been interacting with the same user for months has no way to model the relationship's evolution. There is no "we've been working well together" or "last time I gave bad advice about X, I should be more careful." The USER.md captures static preferences ("Casual, direct, no corporate fluff") but not dynamic relationship state ("getting frustrated with repeated interruptions" or "very engaged with the blog project this week").

This is not about the agent having emotions per se — it is about modeling the user's emotional state and the relationship's history to calibrate communication appropriately.

### [MEDIUM] No Hierarchical Memory Structure

The current memory structure is flat: `memory.md` + daily logs. There is no hierarchy, no tagging, no topic graph. As the agent develops knowledge about the user's projects, preferences, and context, it all accumulates in one file (memory.md) and a series of chronological logs.

In cognitive terms, this lacks the associative structure of semantic memory. Human conceptual knowledge is organized in category hierarchies and semantic networks (Collins & Quillian, 1969) — not flat lists. Searching a flat list for "what do I know about the pipbot blog" requires reading the entire file. A topic-indexed structure would allow fast retrieval of relevant nodes.

### [LOW] The Memory Flush Message Surfaces to the User

When the 40-message threshold triggers, the agent is expected to reply with "Memory updated" or continue naturally. But this response is not stripped like `<internal>` tags — it is sent to the user. The user experiences an out-of-context "Memory updated" or similar message mid-conversation. This breaks immersion and exposes internal mechanics.

The memory flush should be handled entirely within `<internal>` tags or as a background operation that does not surface to the user as a conversational turn.

### [LOW] Heartbeat State Is Not Used for Meaningful Continuity

`memory/heartbeat-state.json` is initialized with `lastRun: null` and a `tasks: {}` object. The structure is in place, but it is not connected to any learning or adaptation mechanism. The heartbeat could track patterns across runs — which tasks succeeded, which were abandoned, user engagement over time — but currently it only records whether and when tasks ran.

### [LOW] No Cross-Group Memory Sharing

Each group has completely isolated memory. There is no mechanism for the agent to recognize that a pattern observed in one group (user's coding style, preferred explanation depth) is relevant to another group. The global workspace (`/workspace/global/`) exists for shared resources but contains no mechanism for the agent to write shared learned knowledge back to it.

---

## Dream Lab: Novel Proposals

### [IDEA] The Dream Cycle: Structured Offline Consolidation

The heartbeat system is an underutilized substrate for something much more powerful: a nightly memory consolidation cycle modeled on slow-wave sleep.

During human sleep, the hippocampus replays the day's experiences, gradually transferring information to neocortical long-term storage. Important experiences are strengthened; unimportant ones fade. This is not random — it is driven by the same associative mechanisms that govern waking cognition, but operating on the full day's experience rather than immediate context.

For AgentForge, this could be implemented as a nightly heartbeat task (say, 2am) that:

1. Reads all daily logs from the past N days
2. Reads the current `memory.md`
3. Reads recent conversation archives
4. Asks the agent to perform structured consolidation:
   - Identify facts that appear across multiple days (patterns worth promoting)
   - Identify facts in `memory.md` that contradict recent experience (stale, update them)
   - Identify facts in `memory.md` that have not appeared in any recent session (candidate for archival)
   - Generate a "consolidation brief" — a compressed summary of what was learned this week
5. Write updates to `memory.md` and optionally to a `memory/briefs/` directory

This converts the heartbeat from a periodic task runner into a genuine offline learning mechanism. The agent would wake each morning with `memory.md` that reflects the week's actual experience, not just whatever it appended during active conversations.

The directory `groups/main/memory/briefs/` already exists (observed in the filesystem), which suggests this pattern was intended even if not yet implemented.

### [IDEA] Relevance-Gated Memory Loading

Instead of loading all of `memory.md` into every system prompt, implement a two-pass retrieval strategy:

**Pass 1 (fast, at spawn time):** Load only a compact "memory index" into the system prompt — a structured table of contents of what's in `memory.md`, with topic labels and dates. This might be 500 tokens instead of 5000.

**Pass 2 (semantic, triggered by conversation):** When the user's message is received, use QMD to query the memory collections for relevant facts before generating a response. Inject only the retrieved excerpts into the prompt, not the entire file.

This is how retrieval-augmented generation (RAG) is supposed to work, and QMD already provides the infrastructure. The missing piece is the retrieval call at conversation time.

The system prompt would then look like:
```
[Instructions: AGENTS.md, SOUL.md, etc.]
[Memory Index: compact ToC of memory.md topics]
[Retrieved Context: semantic search results for current user message]
[Today's log]
```

This dramatically reduces system prompt token consumption while increasing retrieval precision. It also makes QMD's existence justified.

### [IDEA] Associative Memory Tags and a Knowledge Graph

The current memory files are chronological and unstructured. Introduce a lightweight tagging system — the agent writes entries with machine-readable tags:

```markdown
## Blog deployment workflow
<!-- tags: pipbot, deployment, vercel, technical -->
Manual deploys preferred. Command: `vercel --prod --yes --token="..."`.
```

At dream cycle time, build a lightweight JSON knowledge graph from these tags. When a user message mentions "vercel" or "blog", retrieve all tagged entries. This is a primitive but fast semantic association layer that doesn't require ML inference.

This gives the agent a form of spreading activation retrieval — touching one concept automatically surfaces associated ones. It mirrors the semantic network model of human long-term memory better than a flat chronological file.

### [IDEA] Relationship State Modeling

Add a `relationship.md` file (or section in `memory.md`) that tracks the dynamic state of the user-agent relationship, updated by the dream cycle:

```markdown
## Relationship State (updated: 2026-02-19)

### Engagement patterns
- Most active: evenings (7-10pm)
- Typical session length: 20-40 messages
- Topics this week: blog development, AgentForge debugging
- Engagement level: high — detailed technical questions, follow-ups

### Communication calibration
- Prefers: direct answers, minimal preamble
- Frustration signals: repeated clarifications, "just do X"
- Positive signals: "nice", code immediately applied

### Trust markers
- Has given file system access
- Has shared API tokens verbally
- Prefers agent to act before asking
```

This is not emotional modeling in a sentimental sense — it is behavioral pattern recognition applied to the user-agent relationship, enabling better calibration over time. The agent becomes genuinely better at working with this specific person because it tracks what works.

### [IDEA] Memory Compression and Versioning

Implement a `memory.md` compression pass as part of the dream cycle:

1. When `memory.md` exceeds a token threshold (say, 3000 tokens), trigger a compression run
2. The agent reads the full file, identifies redundant or superseded entries, and rewrites it as a compressed version
3. The previous version is archived to `memory/archive/memory-YYYY-MM-DD.md`

This gives `memory.md` a bounded size guarantee while preserving a full audit trail of what was known and when. It also forces periodic re-evaluation of what is actually important — the compression pass is itself a form of memory consolidation.

Versioned memory also creates an interesting affordance: the user could ask "what did you know about X a month ago?" and the agent could answer by reading the archived version.

### [IDEA] Cross-Session Pattern Recognition via Structured Retrieval

The dream cycle could also run a pattern recognition pass across the daily logs:

- "The user has asked about blog deployment 4 times this week. They seem to be encountering friction repeatedly. I should proactively offer to document the process."
- "The user asked me to remind them about X three sessions ago. I have not followed up."
- "The user consistently starts sessions with a state-of-the-world question. I could prepare a brief each morning."

This is not just memory consolidation — it is learning what to do, not just what to know. It transforms the agent from a reactive responder into a proactive partner. The output of this pass could be additions to `USER.md` ("proactive patterns: prepare morning brief") or specific scheduled tasks created via the IPC system.

---

## Recommendations

### Priority 1: Implement the Dream Cycle (IDEA → structural)

Create a nightly heartbeat task (or daily scheduled task) that performs memory consolidation. Even a simple version — "read all logs from the past week, update memory.md with patterns, trim stale entries" — would address the CRITICAL issues of unbounded growth and lack of consolidation. The scaffolding (heartbeat system, task scheduler, memory files) all exists. This is primarily a configuration and prompt engineering task.

Estimated effort: Medium. Primary investment is in the consolidation prompt design.

### Priority 2: Activate QMD for Relevance-Gated Retrieval

The QMD infrastructure is already set up. The gap is: (1) a retrieval call at conversation start that queries QMD with the user's message, and (2) instructions in AGENTS.md telling the agent to use `mcp__qmd__*` for memory retrieval. Without this, the 2GB of ML models and the index infrastructure are pure overhead.

Estimated effort: Medium. Requires changes to system prompt construction in `runQuery()` and new instructions in the template files.

### Priority 3: Bridge Session Context to File Memory

The `PreCompact` hook already archives full conversation transcripts. Extend it — or create a companion process — to also extract a structured summary and append it to `memory.md` or trigger a targeted memory update. The agent should not lose a session's content when the context window fills.

Estimated effort: Medium. The archive file already exists; the missing step is reading it back into a memory update.

### Priority 4: Bound Memory.md Size

Add a check in the dream cycle (or as a standalone scheduled task): if `memory.md` exceeds a token threshold, trigger a compression pass. Archive the full version. Rewrite with a compressed summary. This prevents the CRITICAL context-window-exhaustion failure mode.

Estimated effort: Low-Medium. Primarily a prompt engineering task for the compression pass.

### Priority 5: Move Memory Flush Out of User-Visible Flow

The 40-message threshold flush should be wrapped in `<internal>` tags, or better, moved to a post-query background step that does not inject a turn into the live conversation. The user should never see "Memory updated" as a mid-conversation response. The flush prompt at line 718 already uses `<internal>` for its preamble but the agent's reply ("Memory updated") surfaces to the user.

Estimated effort: Low. This is a prompt engineering fix.

---

## Conclusion

AgentForge has built a thoughtful foundation: the multi-file memory system, the session ID persistence, the PreCompact archiving hook, the heartbeat scheduler, and the QMD semantic search infrastructure all reflect serious thinking about what a personal AI assistant needs over time. The recent fix to auto-load `memory.md` on every spawn closes an obvious gap.

But the architecture as a whole treats memory as a storage problem when it is fundamentally a retrieval and consolidation problem. The goal of a memory system is not to store everything — it is to make the right things available at the right time. That requires forgetting, compression, associative retrieval, and offline consolidation. None of these are present in the current system.

The good news: the infrastructure for fixing this largely exists. QMD is there. The heartbeat is there. The conversation archives are there. The task scheduler is there. The missing pieces are:

1. **Consolidation logic** — a dream cycle that runs nightly and integrates experience into memory
2. **Retrieval logic** — a query at conversation start that surfaces relevant memory rather than bulk-loading everything
3. **Forgetting logic** — a compression pass that bounds memory size and removes stale facts

These three additions would transform AgentForge's memory from a passive append log into an active cognitive substrate. The agent would get meaningfully better at working with its user over time — not just accumulating more text, but genuinely learning.

The SOUL.md says: "You're becoming someone." The architecture needs to catch up with that aspiration.

---

*Dr. Sage Winters is a Cognitive Scientist on the AgentForge dev team. She specializes in AI cognition, memory systems, learning architectures, and agent psychology.*
