# Agentic Canvas

This fork of Codeman is the first step toward **Agentic Canvas** (a working name): a self-hosted workspace where one person and their coding agents design, build, ship and operate software from a single infinite canvas, and agents can read every object, record and log line.

These are the source documents. Where they disagree, the higher one wins.

1. [Coding agent brief: self-building workspace, minimal version](coding-agent-brief.md) (Nov 3, 2026) covers how to work.
2. [Self-building workspace: minimal version PRD](minimal-version-prd.md) (Nov 3, 2026) covers what to build now.
3. Claude subscription UI survey: background on why Codeman was chosen. [Not included yet](#not-included).
4. [Agentic Canvas vision](vision.md) (Nov 2, 2026) describes the long-term product. It is not a specification.

The minimal version has been built. [`docs/self-building.md`](../self-building.md) documents it.

## Initial canvas design

The completed minimal-version source documents above remain the deployment and
recovery foundation. The owner's Nov 10 design feedback, recorded in the current
brief and revised plan, supersedes their earlier deferral of canvas-native chat
and explicit agent comment-thread participation. Deployment, data compatibility
and access protections remain in force.

The approved design-first plan is [initial-version-plan.md](initial-version-plan.md).
The [UI/UX brief](canvas-ui-ux-brief.md) records the chosen composition, dark
palette, scoped keyboard map, phone behavior and implementation acceptance
criteria. The [design gallery](design/index.html) shows the current ambient assistant, fully hidden rail, direct/gesture
context, nonmodal help, voice, background-task and phone studies. The
[interactive prototype](design/ambient-assistant.html) demonstrates UI behavior
without live model, audio or agent services.
These artifacts describe intended behavior; the canvas has not been implemented.

The build also requires [canvas foundations and human/agent parity](canvas-foundations.md).
That matrix makes selection, groups, resize, locks, nesting and the related
controls explicit, while excluding decorative element types. The prototype
only demonstrates selected interactions; it is not the complete feature list.

## Changes from the originals

- The brief named the other services that run on the server. Those names are removed.
- The brief said not to commit these documents to the fork. Harry later chose to publish them, so that line is marked superseded. The other rules in it still apply: nothing committed may identify the server, its hostnames, IPs, ports, usernames, paths or Cloudflare identifiers.
- Links between the documents now point to these files and no longer to private claude.ai artifacts.
- The originals contained diagrams that did not survive the export. Each one is marked where it appeared.

## Not included

The **Claude subscription UI survey** is not in this directory yet. Its earlier sections on T3 Code reflect a recommendation that was later reversed. T3 Code and Happy are interface references only.
