# Failover

`better-starlite3` is the **unified async wrapper** (`open({ driver })`) over
better-sqlite3 / best-sqlite3 / flexdb-node / better-starlite. It does **not**
implement failover itself — failover is provided by the underlying engine:

- `driver: 'better-starlite'` → the **sharefiles CAS lease** replication (leader
  heartbeats a `leader.json`; followers detect death by staleness and re-elect
  via compare-and-set + epoch fence; replicas fail over reads lazily).
- `driver: 'flexdb'` (edgedb.eu / dbpulse-cloud) → the `starlite` binary's
  **Raft** consensus (missed heartbeats past an election timeout → quorum vote).

**The one idea:** death is detected as the *absence of a heartbeat* (a timeout),
never via a notification.

Full canonical description (lease mechanics, epoch fencing, wal-tailer's role, and
why DNS/proxy does **not** elect the leader):
**[`../better-starlite/FAILOVER.md`](../better-starlite/FAILOVER.md)**.
