TODO

---

## BUG: User message injection crashes - missing `time.created` field

**Error:**

```
TypeError: undefined is not an object (evaluating 'msg.info.time.created')
```

**What happened:**
The `messages.transform` injection is working (log shows "Injecting pending subagent output as user message"), but OpenCode crashes when processing our synthetic user message because it expects `msg.info.time.created` but we only set `createdAt`.

**Fix:**
Check how real user messages are structured and match that format. Likely need:

```typescript
info: {
  // ...
  time: { created: new Date().toISOString() },  // NOT createdAt
}
```

Look at existing message structures in OpenCode or how `createSubagentTaskMessage` formats messages.

---

spawned task appears ABOVE the caller task blocktool box in the main session, instead of below - minor aesthetic issue. note: doesn't always happen oO

---

spawned task appears ABOVE the caller task blocktool box in the main session, instead of below - minor aesthetic issue. note: doesn't always happen oO

---

## User message mode (`subagent_result_forced_attention: false`) timing issue

**Problem:**
When using user message mode (config `false`), the subagent output is only delivered when the caller's `session.before_complete` runs. This means:

- If caller is doing a long multi-step task, it has to FINISH before receiving the subagent result
- Output is stored in `pendingSubagentOutputs`, picked up by `session.before_complete` → sets `resumePrompt`
- This defeats the purpose of "immediate attention" - caller doesn't see it until its current work is done

**Desired behavior:**
Inject the subagent output immediately when subagent completes, even if caller is mid-work. The output should appear in the caller's next LLM fetch, not at session completion.

**Why current approach was chosen:**

- Can't call `session.prompt()` on a session that's running (blocks/deadlocks)
- `session.before_complete` is the only hook that can set `resumePrompt`

**Ideas to explore:**

1. **Synthetic user message injection** - Similar to synthetic tool results, but as a user message. Check if `_client.messages.create` with `synthetic: true` works for user messages and appears in next `messages.transform`.

2. **Piggyback on existing injection** - In `messages.transform`, check `pendingSubagentOutputs` and inject as a user message part before the LLM call.

3. **Use the inbox but mark differently** - Add to inbox with a special flag, then in synthetic injection, render it differently (as user message style content within the tool result).

4. **Check OpenCode API** - Is there a way to inject a user message mid-session that appears on next fetch?

**Current workaround:**
Inbox mode (config `true`) works immediately - active callers get the output in their next synthetic broadcast injection. Use this for now.

---

spawned task appears ABOVE the caller task blocktool box in the main session, instead of below - minor aesthetic issue. note: doesn't always happen oO

---
