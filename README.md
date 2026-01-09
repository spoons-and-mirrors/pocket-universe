# IAM Plugin for OpenCode

Lets parallel subagents talk to each other. No configuration needed — just install and it works.

## What It Does

When you spawn multiple agents with the `task` tool, they can:
- **Announce** what they're working on
- **Discover** other agents and see what they're doing
- **Message** each other to coordinate work
- Get **notified** when new messages arrive

## How It Works

Agents get friendly names (agentA, agentB, ...) and automatically discover each other. When an agent has unread messages, they get an urgent notification.

The system lives in memory — fast, no file clutter, resets on restart.

## Debug Logs

For troubleshooting, check `.logs/iam.log` (clears on restart). Shows all tool calls, messages, and notifications.
