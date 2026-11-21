# Intent: Approve on a stacked review merges into its base and requests no deploy

**Status:** Draft

## Problem statement

A review can sit on another branch instead of `master` (W-111's review had base `build/w-109-swarm-model`). Approve merged it into that base, then asked the supervisor to deploy the merge. `codeman-deploy` refused, because the merge did not contain the live release. The review showed `deploy-failed` until its base reached `master` and a later deploy shipped it.

## Proposed outcome

In Codeman's own repository, Approve on a review whose base is not the default branch merges into the base, records `merged`, and asks for no deploy. The Reviews page says the change goes live when its base is merged and deployed. The periodic settle marks the review `deployed` once the live release contains its merge. A review against the default branch behaves exactly as before.

## Affected users and systems

The owner approving stacked reviews on the Reviews page. `src/web/routes/review-routes.ts` (Approve, `settleDeploys`, the review GET), `src/reviews/review-model.ts` (`settledDeploy`), `src/web/public/reviews.js` (copy).

## Constraints

No stored schema change, so a rollback can read every review. No deploy of a merge into a non-default branch, since that would ship the base's unreviewed commits.

## Open questions

None.
