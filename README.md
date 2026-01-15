# Pocket Universe

## Async agents within a main thread block

Async agents are powerful but can lead to work getting orphaned and a bunch of your time and tokens... wasted. You fire, it forgets. Orchestration of such workflow is at best finicky.

**Pocket Universe fixes this.**

- **Fire-and-forget with callback** — Subagents run in parallel, but their output is always piped back to the caller
- **No wasted tokens** — Every model output is captured and delivered, guaranteed
- **Automatic resumption** — Idle agents wake up when messages arrive
- **Complete orchestration** — Main session waits for ALL work to finish before continuing
- **Persistent history** — Agents can recall what previous agents accomplished via the `recall` tool
- **Isolated worktrees** — Each agent works in its own git worktree, no conflicts

Within a single main session call, an entire universe of parallel work can unfold — agents spawning agents, communicating, coordinating — and the main session observes it all complete before moving on. No orphaned work. No lost context. No wasted compute. No guarantee this actually helps anything, but it's worth trying.

If you want background agents, open a new opencode session. If you want async subagents with proper callback management within a main thread block, use this.

---

## How It Works

```mermaid
sequenceDiagram
    participant Main as Main Session
    participant A as AgentA
    participant B as AgentB (subagent)

    Main->>A: task tool
    Note over A: AgentA starts work

    A->>B: subagent(prompt="...")
    Note over A: Returns immediately (fire-and-forget)
    Note over B: AgentB works in parallel

    A->>A: Continues own work
    A->>A: Finishes, about to complete

    Note over A: Waits for agentB...

    B-->>A: Completes, output piped as message
    Note over A: Unread message detected
    A->>A: Session resumed automatically
    Note over A: Processes agentB's output

    A-->>Main: Finally completes
    Note over Main: Continues with full result
```

## Installation

```json
"plugin": ["@spoons-and-mirrors/pocket-universe@latest"]
```

<details>
<summary>Tools</summary>

### `broadcast` — Inter-agent messaging

```
broadcast(message="...")                     # Status update (visible to all, not queued)
broadcast(send_to="agentB", message="...")   # Direct message (queued, replyable)
broadcast(reply_to=1, message="...")         # Reply to message #1
```

| Parameter  | Required | Description                                   |
| ---------- | -------- | --------------------------------------------- |
| `message`  | Yes      | Your message content                          |
| `send_to`  | No       | Target agent alias                            |
| `reply_to` | No       | Message ID to reply to (auto-wires recipient) |

**Status vs Messages:**

- **Without `send_to`**: Updates your status history (other agents see it in the agent list). Passive visibility only — does NOT send messages or wake agents.
- **With `send_to`**: Sends a direct message that appears in the recipient's inbox and is replyable.

**Status history:** Each agent's status updates are tracked as a history. When you see an agent, you see all their status updates in order, showing what they've been doing.

### `subagent` — Create sibling agents

```
subagent(prompt="Build the login form", description="Login UI")
```

| Parameter     | Required | Description                   |
| ------------- | -------- | ----------------------------- |
| `prompt`      | Yes      | Task for the new agent        |
| `description` | No       | Short description (3-5 words) |

**Key behavior:**

- **Async firing**: `subagent()` returns immediately, caller continues working
- **Output piping**: When subagent completes, its output arrives as a message in the caller session (and wakes it if idle)
- **Main thread block**: The main session waits for ALL subagents to complete before continuing
- **Model inheritance**: Subagents automatically inherit the caller's agent and model (no fallback to defaults)

### `recall` — Query agent history

```
recall()                                        # Get all agents' status histories
recall(agent_name="agentA")                     # Get specific agent's history
recall(agent_name="agentA", show_output=true)   # Include agent's final output
```

| Parameter     | Required | Description                                                   |
| ------------- | -------- | ------------------------------------------------------------- |
| `agent_name`  | No       | Specific agent to recall (omit for all agents)                |
| `show_output` | No       | Include final output (only works with `agent_name` specified) |

**Key behavior:**

- **Persists across cleanups**: History survives pocket universe cleanup, so agents in batch 2 can recall what batch 1 agents did
- **Status history only by default**: Output is only shown when BOTH `agent_name` AND `show_output=true` are specified
- **Active agent handling**: If you request output for an agent that's still active, you'll get `[Agent is still active - no output yet]`

**Example response:**

```json
{
  "agents": [
    {
      "name": "agentA",
      "status_history": ["Working on login form", "Integrating API"],
      "state": "completed",
      "output": "Login form implemented with OAuth support..."
    }
  ]
}
```

**Use cases:**

- New agent needs to know what previous agents accomplished
- Agent wants to check if another agent finished and see their results
- Coordinating work based on what others have done

</details>

<details>
<summary>Session Lifecycle</summary>

```mermaid
flowchart TD
    A[Agent finishes work] --> B{Has pending subagents?}
    B -->|Yes| C[Wait for subagents to complete]
    C --> D[Subagents pipe output as messages]
    D --> E{Has unread messages?}
    B -->|No| E
    E -->|Yes| F[Resume session]
    F --> G[Agent processes messages]
    G --> A
    E -->|No| H[Session completes]
    H --> I[Main continues]
```

The `session.before_complete` hook ensures no work is left behind:

1. Agent finishes its work
2. Hook checks for pending subagents → waits for them
3. Subagents pipe output to caller as messages
4. Hook checks for unread messages → resumes session
5. Agent processes messages, hook fires again
6. Only when nothing pending does the session complete
7. Main session continues with the complete result

</details>

<details>
<summary>Session Resumption</summary>

Idle agents automatically wake up when they receive messages:

```mermaid
sequenceDiagram
    participant A as AgentA
    participant B as AgentB

    A->>A: Completes task, goes idle

    B->>A: broadcast(send_to="agentA", message="Question?")
    Note over A: Message arrives while idle

    A->>A: Resumed automatically
    Note over A: Sees message in inbox

    A->>B: broadcast(reply_to=1, message="Answer!")
```

</details>

<details>
<summary>Receiving Messages</summary>

Messages appear as synthetic `broadcast` tool results:

```json
{
  "tool": "broadcast",
  "state": {
    "input": { "synthetic": true },
    "output": {
      "you_are": "agentB",
      "agents": [
        {
          "name": "agentA",
          "status": ["searching for X", "found X in file.ts"]
        }
      ],
      "messages": [{ "id": 1, "from": "agentA", "content": "Need help?" }]
    }
  }
}
```

- **`synthetic: true`** — Injected by Pocket Universe, not a real tool call
- **`you_are`** — Your agent name (always included so you know your identity)
- **`agents`** — All sibling agents and their status history (array of status updates)
- **`messages`** — Inbox messages, reply using `reply_to`

**Reply audit trail:** When you reply using `reply_to`, the tool output includes the FULL original message you're replying to, providing a complete audit trail.

</details>

<details>
<summary>Pocket Universe Summary</summary>

When all parallel agent work completes, the main session receives a **Pocket Universe Summary** as a persisted user message. This includes:

- All agents that ran
- Their full status history
- Their worktree paths (if enabled)

Example summary:

```
[Pocket Universe Summary]

The following agents completed their work:

## agentA
Worktree: /repo/.worktrees/agentA
Status history:
  → searching for auth implementation
  → found auth in src/auth.ts
  → sending findings to agentB

## agentB
Worktree: /repo/.worktrees/agentB
Status history:
  → implementing login form
  → integrating auth from agentA
  → completed login feature

Note: Agent changes are preserved in their worktrees. Review and merge as needed.
```

This summary is **persisted to the database** so it survives crashes and is part of the conversation history.

**Automatic cleanup:** After the summary is injected, all agent tracking state is cleared. This means the next batch of tasks starts fresh — no stale agents from previous work appear in `getParallelAgents()`.

**Parallel task handling:** If the main session spawns multiple task tools in parallel (e.g., `task(agentA)` and `task(agentB)` simultaneously), the summary is only injected after ALL first-level children complete. This ensures the summary contains work from all agents, not just the first one to finish.

</details>

<details>
<summary>Isolated Worktrees</summary>

Each agent operates in its own **git worktree** — a clean checkout from the last commit (HEAD). This provides isolation so agents can work in parallel without conflicting with each other.

### How It Works

```
repo/
├── .worktrees/
│   ├── agentA/     ← agentA's isolated working directory
│   ├── agentB/     ← agentB's isolated working directory
│   └── agentC/     ← agentC's isolated working directory
└── (main repo)     ← main session's working directory
```

When an agent is created (via `task` or `subagent`):

1. A new worktree is created at `.worktrees/<alias>` (detached from HEAD)
2. The agent sees its worktree path in its system prompt
3. All sibling agents can see each other's worktree paths via `broadcast`

### Agent System Prompt

Each agent receives its worktree path:

```xml
<worktree>
Your isolated working directory: /repo/.worktrees/agentB
ALL file operations (read, write, edit, bash) should use paths within this directory.
Do NOT modify files outside this worktree.
</worktree>
```

### Broadcast Shows Worktrees

When agents see each other via broadcast, worktree paths are included so they know where each agent is working.

### Main Session Worktree Summary

The main session receives a summary showing all active agent worktrees, their tasks, and their paths.

### Worktree Lifecycle

| Event                 | Behavior                                           |
| --------------------- | -------------------------------------------------- |
| Agent created         | Worktree created at `.worktrees/<alias>` from HEAD |
| Agent completes       | **Worktree preserved** with all changes            |
| Stale worktree exists | Automatically cleaned up before creating new one   |

**Important:** Worktrees are **not deleted** when agents complete. The agent's changes are preserved for you to review and merge manually.

### Limitations

Worktree isolation relies on agents following instructions to use their assigned paths. The LLM may occasionally write to the wrong location. For guaranteed isolation, OpenCode core changes would be needed (per-session working directory).

</details>

<details>
<summary>Configuration</summary>

Pocket Universe uses feature flags to control optional functionality. Configuration is loaded from two locations (in priority order):

1. **Project-specific:** `.pocket-universe.jsonc` in your current directory
2. **Global:** `~/.config/opencode/pocket-universe.jsonc` (auto-created if missing)

### Config File Format

```jsonc
{
  "worktree": false,
  "subagent": true,
  "logging": false,
}
```

### Feature Flags

| Flag                               | Default | Description                                                                                           |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `worktree`                         | `false` | Create isolated git worktrees for each agent                                                          |
| `subagent`                         | `true`  | Enable the `subagent` tool for creating sibling agents                                                |
| `logging`                          | `false` | Write debug logs to `~/.config/opencode/plugin/iam/pocket-universe.log`                               |
| `subagent_result_forced_attention` | `true`  | When true, subagent output appears in broadcast inbox; when false, injected as persisted user message |

### Behavior When Disabled

**`worktree: false`**

- No worktrees are created
- Worktree sections are hidden from system prompts and broadcasts
- Agents work in the main repository (potential for conflicts)

**`subagent: false`**

- The `subagent` tool is not registered
- Agents cannot create new sibling agents
- Subagent instructions are hidden from the system prompt

**`logging: false`**

- No log file is created
- Reduces disk I/O

**`subagent_result_forced_attention: true`** (default)

- Subagent output appears in the broadcast inbox (synthetic injection)
- Message is replyable via `reply_to`
- Not persisted to database (memory only)

**`subagent_result_forced_attention: false`**

- Subagent output is injected as a persisted user message
- Forces immediate LLM attention and persists to database
- Resume prompt shows: `[Received subagent results: resuming session...]`
- Not replyable (it's a user message, not a broadcast)

### Example Configurations

**Minimal setup (no worktrees, no logging):**

```jsonc
{
  "worktree": false,
  "subagent": true,
  "logging": false,
  "subagent_result_forced_attention": true,
}
```

**Full isolation with worktrees:**

```jsonc
{
  "worktree": true,
  "subagent": true,
  "logging": true,
  "subagent_result_forced_attention": true,
}
```

**Simple parallel work (no subagent, no worktrees):**

```jsonc
{
  "worktree": false,
  "subagent": false,
  "logging": false,
  "subagent_result_forced_attention": true,
}
```

</details>
