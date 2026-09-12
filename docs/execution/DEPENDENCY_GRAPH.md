# Office Dependency Graph

This graph is the execution control plane for the Tech Lead. Edges are explicit contract dependencies. Work items without a path edge may be implemented concurrently.

## Graph

```text
OFF-001
  |
  +--> OFF-002
          |
          +--> OFF-003
          |      |\
          |      | +--> OFF-004 --> OFF-005
          |      | +--> OFF-006
          |      |
          +------+-------------------------------+
                                             |
                         +-------------------+-------------------+
                         |                   |                   |
                      OFF-007             OFF-010             OFF-011
                         |                   |                   |
                  +------+-----+             |             +-----+-----+
                  |            |             |             |           |
               OFF-008      OFF-009          |          OFF-012     OFF-024*
                  |            |              |             |
                  +------+-----+--------------+-------------+
                         |
                      OFF-013
                     /   |    \
                    /    |     \
              OFF-014 OFF-015  OFF-016
                 |       |       |
                 +---+---+-------+
                     |
                  OFF-017
                     |
                  OFF-018
                     |
              +------+------+
              |             |
           OFF-033       OFF-034

OFF-020 depends on OFF-002/005/006/007/010/011
   |
   +--> OFF-021
   +--> OFF-022
   +--> OFF-023
   +--> OFF-024
   +--> OFF-025 --> OFF-026 --> OFF-027
   |
   +--> OFF-028 --> OFF-029
                     |
             +-------+--------+
             |                |
          OFF-031          OFF-032

OFF-030 depends on core domain + workflow/agent/control-tower protocols + OFF-028

OFF-035 depends on OFF-020/025/027/015

OFF-036 depends on persistence/events/auth/action/app/offline

OFF-037 depends on representative adapters + web + revenue/procurement engines

OFF-038 -> OFF-039 -> OFF-040
```

`OFF-024*` is shown near financial work only to clarify the adapter edge; it still depends on OFF-020 and OFF-011.

## Parallelization matrix

### Wave 0
Only one worker:

- OFF-001

### Wave 1
After OFF-001:

- Worker 1: OFF-002
- Worker 2: contract fixture/tooling documentation that does not alter OFF-002 outputs
- Worker 3: CI/static governance scaffolding that does not import production modules

### Wave 2
After OFF-003/004/006 contracts permit:

- Worker 1: OFF-004 Database foundation
- Worker 2: OFF-006 Authorization and policy kernel
- Worker 3: OFF-007 Enterprise/project identity only when OFF-004 + OFF-006 are ready

Do not schedule OFF-007 before both dependencies are complete.

### Wave 3
Once OFF-007 plus event foundation are ready, the following are intentionally low-coupling and can occupy three workers:

- OFF-008 Documents/evidence
- OFF-009 Work/field
- OFF-010 Schedule

Then OFF-011 Cost and OFF-012 Contracts can run concurrently when their common prerequisites are satisfied.

### Wave 4
After OFF-008/009/010/011/012:

- OFF-013 Relationship engine
- documentation/contract-fixture hardening lane
- adapter SDK preparation only where it does not alter canonical contracts

### Wave 5
After OFF-013:

- OFF-014 Margin/impact
- OFF-015 Enterprise memory
- OFF-016 Workflow

### Wave 6
After OFF-016 + required foundations:

- OFF-017 Action gateway
- OFF-019 Exception/control tower
- OFF-020 Adapter SDK

Do not combine provider implementations in the same worker assignment.

### Wave 7
Three independent adapter/app ecosystem tracks:

- OFF-021/022/023 provider adapter contracts, one worker per adapter family
- OFF-025 App SDK can run once its contract predecessors are complete

### Wave 8
App/runtime and client synchronization:

- OFF-026 App runtime
- OFF-027 Marketplace lifecycle
- OFF-028 Realtime subscriptions

### Wave 9
Client/platform tracks:

- OFF-029 Offline sync
- OFF-030 Web application
- OFF-031 Field client once OFF-029 is ready

### Wave 10
Economic and cross-platform hardening:

- OFF-032 Desktop protocol/reference shell
- OFF-033 Revenue recovery
- OFF-034 Procurement optimization

### Wave 11
Enterprise hardening:

- OFF-035 Replacement analysis
- OFF-036 Security/audit
- OFF-037 End-to-end reference scenario

### Wave 12
Release gates:

- OFF-038
- OFF-039
- OFF-040

These are deliberately sequential.

## Conflict minimization rules

1. Only one worker owns a canonical contract file at a time.
2. Workers modify their declared bounded-context directory plus tests and focused docs.
3. Cross-context changes require a separate contract item or Tech Lead decision.
4. A worker may not opportunistically refactor another context.
5. Merge order follows the dependency graph, not PR arrival order.
6. Parallel workers must keep commits narrow and cherry-pickable.
