# Shared hub store (file backend)

All Grok Bots on this machine can coordinate **without sharing chat context** by reading/writing these files or using the Hub HTTP API / `mcctl`.

```
shared/hub/
  registry.json       # who is who (agent → player → port)
  blackboard.json     # shared key/value goals, claims, base coords
  events.ndjson       # append-only event stream (tail -f)
  mailbox/<agent>.jsonl
  channels/<name>.jsonl
```

## Patterns for 20 bots

### 1. Chief + workers
- `bot1` role=chief writes board keys: `goal`, `rally_point`, `phase`
- Workers poll `mcctl board` + `mcctl inbox` every few seconds

### 2. Claims (avoid two miners same vein)
```bash
GROK_AGENT=miner3 mcctl board-set claim.100_64_20 '{"owner":"miner3","until":1234567890}'
```
If key exists with another owner, pick another target.

### 3. Ops channel
```bash
GROK_AGENT=chief mcctl shout ops "phase=mine_east"
GROK_AGENT=miner1  # read: curl hub /channels/ops or watch events
```

### 4. Direct task mail
```bash
GROK_AGENT=chief mcctl say miner2 "dig oak at 10 64 -3"
GROK_AGENT=miner2 mcctl inbox
```

File fallback (no HTTP): append JSON line to `mailbox/miner2.jsonl`.
