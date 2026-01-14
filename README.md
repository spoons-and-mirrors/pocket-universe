# IAM (Inter-Agent Messaging)

### Enable parallel agents communication for opencode

![header](./header2.webp)

## How It Works

```mermaid
sequenceDiagram
    participant Parent as Parent Session
    participant A as AgentA
    participant B as AgentB

    Parent->>A: spawn task
    Parent->>B: spawn task

    Note over A,B: Attention mechanism activation

    A->>B: broadcast(send_to="agentB", message="Question?")
    A->>B: broadcast(send_to="agentB", message="Other question?")

    Note over B: Get messages in synthetic tool result

    B->>A: broadcast(reply_to=1, message="Answer!")
    Note over B: Tool result shows source message
    Note over B: Clear message 1 from synthetic

    Note over A: Receives reply
```

## Installation

Add to your OpenCode config:

```
"plugin": ["@spoons-and-mirrors/iam@latest"]
```

## The `broadcast` Tool

```
broadcast(message="...")                     # Send to all agents
broadcast(send_to="agentB", message="...")   # Send to specific agent
broadcast(reply_to=1, message="...")         # Reply to message #1 (auto-wires recipient)
```

### Parameters

| Parameter  | Required | Description                                                     |
| ---------- | -------- | --------------------------------------------------------------- |
| `message`  | Yes      | Your message content                                            |
| `send_to`  | No       | Target agent (single agent only)                                |
| `reply_to` | No       | Message ID to reply to - auto-wires recipient to message sender |

## The `spawn` Tool

Subagents can spawn new sibling agents to work on tasks in parallel. The spawned agent joins the IAM network and can communicate via `broadcast`.

```
spawn(prompt="Build the login form", description="Login UI")
```

### Parameters

| Parameter     | Required | Description                                |
| ------------- | -------- | ------------------------------------------ |
| `prompt`      | Yes      | The task for the new agent to perform      |
| `description` | No       | Short description (3-5 words) for the task |

### How It Works

1. Subagent A calls `spawn(prompt="...", description="...")`
2. A new sibling session is created (child of the same parent as A)
3. The spawned agent is pre-registered with IAM and can use `broadcast`
4. The spawn appears as a "running" task in the parent's TUI
5. `spawn()` **blocks** until the spawned agent completes
6. The spawned agent's output is returned to the caller
7. The spawn is marked "completed" in the parent's TUI

```mermaid
sequenceDiagram
    participant Parent as Parent Session
    participant A as AgentA
    participant C as AgentC (spawned)

    Parent->>A: spawn task via task tool
    Note over A: AgentA needs help

    A->>C: spawn(prompt="Help with X")
    Note over Parent: Task shows as "running"
    Note over C: AgentC works on task

    C-->>A: Agent output returned
    Note over Parent: Task shows as "completed"
    Note over A: Continues with result
```

**Note:** `spawn` can only be called from subagent sessions (sessions with a parentID). Main sessions should use the built-in `task` tool directly.

## Session Resumption

When an agent goes idle (finishes processing) and later receives a broadcast message, IAM automatically **resumes** the idle session so it can process the new message. This enables asynchronous communication patterns where agents don't need to be actively waiting for messages.

```mermaid
sequenceDiagram
    participant A as AgentA
    participant B as AgentB

    A->>A: Completes task, goes idle
    Note over A: Status: idle

    B->>A: broadcast(send_to="agentA", message="Question?")
    Note over A: IAM detects idle + new message
    A->>A: Session resumed automatically
    Note over A: Status: active

    A->>B: broadcast(reply_to=1, message="Answer!")
```

This happens transparently - agents don't need to do anything special to receive messages while idle.

## Receiving Messages

Messages are injected as a synthetic `broadcast` tool result. Here's the complete structure:

```json
{
  "tool": "broadcast",
  "state": {
    "status": "completed",
    "input": { "synthetic": true },
    "output": {
      "hint": "ACTION REQUIRED: Announce yourself...",
      "agents": [
        { "name": "agentA", "status": "Working on frontend components" }
      ],
      "messages": [
        {
          "id": 1,
          "from": "agentA",
          "content": "What's the status on the API?"
        },
        {
          "id": 2,
          "from": "agentA",
          "content": "Also, can you check the tests?"
        }
      ]
    },
    "title": "1 agent(s), 2 message(s)"
  }
}
```

- **`input.synthetic`**: Indicates this was injected by IAM, not a real agent call
- **`output.hint`**: Shown only if agent hasn't announced yet (disappears after first broadcast)
- **`output.agents`**: Other agents and their status (not replyable)
- **`output.messages`**: Messages you can reply to using `reply_to`

Messages persist in the inbox until the agent marks them as handled using `reply_to`.

**Discovery:** Agents discover each other through synthetic injection. The first `broadcast` call sets the agent's status, which other agents see in the `agents` array.

## Attention Layer

On every LLM fetch, pending inbox messages are injected as a synthetic `broadcast` tool result at the end of the message chain. The synthetic call has `input: { synthetic: true }` to indicate it was injected by IAM, not a real agent call.

After injection, the message chain looks like:

1. system prompt
2. user message
3. assistant response
4. tool calls...
5. user message
6. **`[broadcast]` 1 agent(s), 2 message(s)** ← injected at end

## Example Workflow

```
# Parent spawns two agents to work on different parts of a feature

AgentA (working on frontend):
  -> broadcast(message="Starting frontend work")
     # Tool result shows: "Available agents: agentB"
  -> ... does work ...
  -> broadcast(send_to="agentB", message="Need the API schema")

AgentB (working on backend):
  -> broadcast(message="Starting backend work")
     # Tool result shows: "Available agents: agentA"
  -> ... sees AgentA's question in inbox ...
  -> broadcast(reply_to=1, message="Here's the schema: {...}")
     # Tool result shows: Marked as handled: #1 from agentA
     # Recipient auto-wired to agentA

AgentA:
  -> ... sees AgentB's response in inbox ...
  -> broadcast(reply_to=1, message="Got it, thanks!")
     # Recipient auto-wired to agentB
```
