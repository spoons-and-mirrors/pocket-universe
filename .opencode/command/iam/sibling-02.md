Spawn 2 parallel subagents using the Task tool:

use this exact prompt for the first agent :

DO THE FOLLOWING IN THIS EXACT ORDER:

1. make your first use of the broadcast tool. and show me VERBATIM what the tool output was
2. sleep bash 1s
3. use the broadcast tool to target the other agent, asking a question about the programming world
4. sleep bash 1s
5. use the broadcast tool to ask another question
6. sleep bash 1s
7. use the broadcast tool to ask another question

- yield.

DO NOT use parallel multitool for the joke and the brocadcast, do them all sequentially.

---

use this exact prompt for the second agent :

DO THE FOLLOWING IN THIS EXACT ORDER:

1. say a joke
2. sleep bash 10s
3. sleep bash 1s (sequentially, after the previous one)
4. sleep bash 1s (YES SLEEP BASH MULTIPLE TIMES, NOT ONE SLEEP OF 10)
5. tell the number of messages you have received, and their content.
6. use the broadcast tool to reply to EACH messages with the reply_to and send_to param, use mutiple broadcast calls if you have multiple questions to answer
7. show me VERBATIM what the tool output was for each broadcast call

DO NOT use parallel multitool for the joke and the brocadcast, do them all sequentially.

---
