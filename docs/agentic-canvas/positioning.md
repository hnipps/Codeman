# Positioning: Agentic Canvas and block/buzz

Nov 15, 2026. A record of a design conversation, not a specification. The
[vision](vision.md) still governs the product. This note records where the
canvas sits beside the closest similar project, and two decisions the owner
made along the way.

## Decisions

1. **This fork diverges from upstream Codeman permanently.** Upstream was a
   good foundation and nothing more. Staying compatible or mergeable with
   upstream is not a goal, and it is never a cost to weigh against a design.
   The stack, data model and protocols can change whenever the canvas needs
   them to.
2. **The canvas evolves as a whole app, not through plugins.** Users and their
   agents change the app's own source, from the UI down to the server, data
   model and deploy pipeline. Users can then get what they need without waiting
   for someone to build a feature for them.

## The comparison

[block/buzz](https://github.com/block/buzz) (Apache 2.0, Rust) is a self-hosted
workspace where people and AI agents share the same channels. It is built on a
Nostr relay, so every message, reaction, workflow step, git patch and approval
is a signed event in one log. Agents are members with their own keypairs. They
are woken by @mentions through `buzz-acp`, which drives agents speaking the
Agent Client Protocol (Goose, Codex and Claude Code through adapters). The
desktop app lives in [block/buzz-app](https://github.com/block/buzz-app).

The two projects head for the same destination: a shared space where humans
and agents work as peers and the space itself can be reshaped. Multiplayer is
this project's longer-term aim too (see the vision's section on roles and
authorship). The difference is how each one lets users reshape it.

### Buzz: plugins inside a fixed app

Buzz's plugin architecture lets people and agents extend the installed app
"without having to contribute upstream". A plugin is a manifest plus one
JavaScript module. It can own a whole page (its full React tree), panels,
sidebar sections, items in the message area, settings cards, shortcuts, and
tools and hooks for agents. An agent edits a plugin folder and calls
`plugin_reload`, and a version that fails to start is rolled back.

The app keeps control of startup, navigation, the overall layout, Settings
and recovery. Plugins cannot change the relay, the data model or the protocol.
Each user installs plugins locally, so customization is personal. Most of the
plugin API is still marked as likely to break.

### Agentic Canvas: change the app itself

| | Buzz plugins | Agentic Canvas |
|---|---|---|
| What can change | Pages, panels and agent tools inside a fixed app | Any source: UI, server, data model, the deploy pipeline itself |
| Who sees the change | Whoever installs the plugin, locally | Everyone on the deployment, once it ships |
| How bad changes are caught | Plugin API limits, plus rollback on reload | Blue-green deploy, health checks, release rollback ([self-building](../self-building.md)) |

In short: Buzz lets you add to the app, and the canvas lets you change the app.

### What Buzz has that the canvas does not, yet

- Collaboration and provenance built in from the start: per-agent identities,
  channel membership, and one searchable, hash-chained audit log over
  conversation and work.
- Agents scoped by identity. In Codeman every agent still runs as the same OS
  account.

### What the canvas has that Buzz does not

- The real agent CLIs, unmodified, in terminals: their own dialogs, commands
  and modes, rather than an ACP adapter's view of them.
- The infinite canvas, prototypes, review flows and work tracking, all
  readable and writable by agents.
- An app that rebuilds and redeploys itself.

## Open problems for multiplayer

The canvas has no answer yet for these, and they have to be solved before more
than one person can change the app:

1. **A change to the app is a change for everyone.** Buzz avoids this because
   plugins are per user. The canvas needs a way to decide which edits ship:
   proposals, review, and roles for who may merge or deploy. Some changes may
   also need to be per user, which would bring back a lighter layer that skips
   the deploy.
2. **One user can break everyone's app.** Health checks catch a crash, not a
   feature someone else relied on quietly disappearing. Rollback needs to work
   on a single change, not only on a whole release.

Because the fork no longer tracks upstream, the app's own history is the only
record of why it is the way it is. Recording the author of every write, human
or agent, as the vision already requires, matters even more for that reason.
