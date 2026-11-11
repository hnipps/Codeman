# Intent: Agent canvas commands over MCP

**Status:** Complete

## Problem statement

Agents cannot inspect or edit the opt-in canvas through Codeman MCP. Primitive commands lack compound layout and spatial discovery operations.

## Proposed outcome

Expose a compact typed tool surface through the existing HTTP command path, with server-resolved workspace and actor identity, bounded text reads, atomic compound edits and machine-readable capabilities.

## Affected users and systems

Canvas users, agent sessions, MCP clients, shared command validation and HTTP routes.

## Constraints

Canvas remains opt-in. Preserve opaque records and additive storage, locks, revisions, hierarchy safety and deploy-role checks. Browser-owned view state is reserved for PC3/PC9. Keep existing MCP handshake behavior and session tools. Add stored-command tests to the existing deploy gate. Run only targeted tests and the deploy gate per coordinator instructions; wait for other test/build processes before starting checks.

## Open questions

None. Use the five named CRUD/read tools plus query, arrange, transform, lock, history and capabilities (eleven canvas tools).
