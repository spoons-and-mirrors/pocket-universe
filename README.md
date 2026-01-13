# IAM (Inter-Agent Messaging)

A plugin for OpenCode that enables parallel agents to communicate with each other.

## Features

- **Single Tool**: `broadcast` for all agent communication
- **Auto-Registration**: First call registers the agent and shows other agents
- **Message Injection**: Messages appear in recipient's context as tool results
- **Parent Notification**: Messages to parent sessions trigger `notify_once`

## Tool Schema

### `broadcast`

```yaml
description: "Communicate with other parallel agents. First call registers you and shows other agents."

parameters:
  recipient:
    type: string
    required: false
    description: "Target agent(s), comma-separated. Omit to send to all."

  message:
    type: string
    required: true
    description: "Your message"

returns:
  - Your assigned alias (e.g., "agentA")
  - Delivery confirmation with recipient list
  - List of other agents (on first call)
```

## Usage Examples

```
# First call - registers and shows other agents
broadcast(message="Starting work on authentication module")

# Send to specific agent
broadcast(recipient="agentB", message="Can you help with the API design?")

# Send to multiple agents
broadcast(recipient="agentA,agentC", message="Review complete, merging now")

# Send to all agents (same as omitting 'recipient')
broadcast(message="Done! Here's what I found...")
```

## How It Works

1. **Registration**: First `broadcast` call registers the session and assigns an alias (agentA, agentB, etc.)

2. **Message Delivery**: Messages are stored in memory and injected into recipient sessions as assistant messages with tool parts

3. **Context Injection**: Recipients see messages in their context as `iam_message` tool results

4. **System Prompt**: All sessions receive instructions on how to use the tool and read incoming messages

## Configuration

The plugin automatically adds `broadcast` to `experimental.subagent_tools` so it's available to task agents.

## Logs

Logs are written to `.logs/iam.log` with categories:

- `[HOOK]` - Plugin lifecycle events
- `[SESSION]` - Agent registration
- `[TOOL]` - Tool execution
- `[MESSAGE]` - Message sending/delivery
- `[INJECT]` - Context injection
