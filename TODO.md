# IAM Plugin - TODO

## 1. Spawn tool - Semi-blocking - IMPLEMENTED

**Current implementation:**

- agentA calls `spawn(prompt="do X")`
- `spawn()` awaits the spawned session's completion (semi-blocking)
- agentA's tool call stays active until agentB completes
- This ensures main session waits for ALL spawned agents
- When agentB completes:
  1. Output is fetched from spawned session
  2. Session is marked idle in `sessionStates` (enables future resume)
  3. Task part is marked "completed" in parent TUI
  4. Spawn is removed from caller's pending spawns
  5. Output is returned to the caller (agentA sees agentB's output)

**Why semi-blocking:**

- `session.idle` hook does NOT fire for child sessions (only for main/user session)
- `tool.execute.after` fires AFTER the task has returned to parent (too late)
- The only way to make main wait for spawned agents is to keep the caller's tool call active

**Tradeoff:**

- agentA can't continue to other tools while waiting for agentB
- But this ensures main session waits for ALL work to complete

---

## 2. Parallel agents batch visibility - DEFERRED

**Problem:** Agents from different "batches" (different parent wait blocks) can see each other.

**Current state:** We have tracking infrastructure (`callerPendingSpawns`) but no batch scoping yet.

**Deferred because:** Semi-blocking spawn makes this less critical since agents complete in order.

---

## 3. Session resumption - WORKING

**Current implementation:**

- When agent goes idle and receives a broadcast, it is resumed
- Uses `presentedMessages` tracking to avoid double-delivery
- Resume prompt says "New message received. Check your inbox." (no duplicate content)
- Recursive resumption for multiple unread messages

**Verified:**

- [x] No infinite loops in resumption
- [x] Messages not delivered twice (via transform AND resume)
- [x] Idle agents correctly resumed when broadcast arrives

---

## 4. Documentation - NEEDS UPDATE

- [x] prompt.ts SPAWN_DESCRIPTION updated (now says "blocks until spawned agent completes")
- [ ] README.md spawn section needs updating to reflect semi-blocking behavior
- [ ] README.md should document session resumption feature
