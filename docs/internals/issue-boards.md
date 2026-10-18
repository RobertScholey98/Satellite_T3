# Issue boards

Issue boards are a Satellite feature. Each environment connects a GitHub Project or an Azure
DevOps board itself, keeps a stored copy of it, and starts tickets into worktree threads. The
service is [`IssueService.ts`](../../apps/server/src/issues/IssueService.ts); the host adapters
live in the GitHub and Azure DevOps source control packages behind
[`IssueHostAdapter.ts`](../../packages/source-control-core/src/server/IssueHostAdapter.ts).

## One owner per attempt

An attempt belongs to the environment that started it, and only that environment moves its
ticket. It writes straight to the remote board. Another environment connected to the same board
learns about the move by refreshing its stored copy. Nothing is relayed, delivered or dialled
between environments, so Start runs on the environment whose board the user is viewing.

Satellite 1.x carried lifecycle receipts through a browser relay, which only worked while one
client was connected to both computers. Dev builds from 2026-10-15 replaced it with the board's
environment dialling each worktree environment with a peer credential. Both made the board's
environment responsible for work it could not see, and neither helped when the computers could
not reach each other. The remote board is already shared state, so the owner writing to it
directly removes the problem rather than transporting around it. Migration 101 keeps
cross-machine attempts as ended links only, and a startup cleanup removes the dev builds' peer
secrets and sessions.

Do not add a move or start MCP tool. A third mover would weaken the rule below.

## A manual move wins

A person can move a ticket from any computer or from the host's own page, and that move always
wins over an automatic move that arrives later.

- Each attempt records a baseline, the column it last put the ticket in. Before its first move,
  any configured Ready column counts.
- Automatic moves are decided when they run, against a fresh read of the one item, never against
  the stored copy. If the remote column is the baseline the move writes and the baseline follows;
  if it is already the target nothing is written; anywhere else the move is skipped as moved by
  hand. A manual move from this environment that has not reached the remote yet also skips it.
  See [`moveReconciliation.ts`](../../apps/server/src/issues/moveReconciliation.ts).
- Retry on a skipped move applies it as a manual move with the attempt's id, which moves the
  baseline, so automation resumes from there. Putting the ticket back at the baseline also
  resumes it.
- A manual move carries the column the person saw. The service refuses it when the remote item
  differs.

All moves run through one queue under the service lock, so moves on a board never interleave.
Transitions are keyed `auto:<attempt>:<transition index>`, which makes duplicate events, restarts
and sweeps converge on one move.

## Transitions come from upstream's events, plus a sweep

The attempt stage is derived from the thread (worktree ready, first run reached running, the
newest non-stack pull request) by [`attemptStage.ts`](../../apps/server/src/issues/attemptStage.ts).
[`IssueAttemptReactor.ts`](../../apps/server/src/issues/IssueAttemptReactor.ts) reconciles a
thread's attempts on run, pull request link, pull request sync and deletion events. Upstream's
live event stream starts at the latest event, so the reactor also sweeps every running attempt at
startup and every minute; without the sweep a transition that happened while the server was down
would never move its ticket.

Start launches the thread through upstream's thread launch service unmodified, with
`issue-attempt:<request id>` as the command id. No Satellite field enters upstream's thread
contracts or event log; the attempt row holds the thread id instead.
