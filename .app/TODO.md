TODO

---

## 2. Parallel agents batch visibility - DEFERRED

**Problem:** Agents from different "batches" (different parent wait blocks) can see each other.

**Current state:** We have tracking infrastructure (`callerPendingSpawns`) but no batch scoping yet.

**Deferred because:** Semi-blocking spawn makes this less critical since agents complete in order.

---

spawned task appears ABOVE the caller task blocktool box in the main session, instead of below - minor aesthetic issue. note: doesn't always happen oO

---

spawned task tool should use the same agent and model than the caller.
