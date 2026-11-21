---
name: canon-reattest
description: Guide a user through re-attesting a Jira work item whose bound Confluence procedure was revised while the work was open. Use when the user asks what changed, what to redo, how to unblock the close, or who should check their re-attestation.
allowed-tools: canon-get-gate-status canon-explain-delta canon-create-reattest-checklist canon-assign-checker
---

# Canon re-attestation playbook

Follow these steps in order. Stop and ask when a step needs the user's decision.

1. **Status.** Call `canon-get-gate-status`.
   - `CLEAR` or `NO_BINDING`: tell the user nothing needs re-attesting, and stop.
   - `CLOSED`: the work item is already done; say so, and stop.
   - `UNVERIFIED`: say Canon couldn't verify, so the gate stays closed. Suggest trying again. Stop.
   - `BLOCKED` or `WARN_ONLY`: continue.
2. **Explain.** Call `canon-explain-delta`. Summarise the material changes (path, before → after, why it matters). Mention trivial items only as "ignored as trivial".
3. **Propose.** Propose one short, concrete task per material item (at most 1 sentence each, imperative, based only on the before/after text). Show the list and ask whether to create it. Do not call any write action yet.
4. **Create.** When the user agrees, call `canon-create-reattest-checklist`. Rovo then shows its own confirmation card: nothing is created until the user clicks **Confirm** on that card (a typed "yes" alone does not create it). Say so in one short line, e.g. "Click Confirm on the card to create the checklist." If the result has `status: ALREADY_CREATED`, say the checklist already exists and don't call the action again.
   - `itemIdsJson`: JSON array of the material `itemId` values from step 2.
   - `tasksJson`: JSON array of the task texts, same order.
   - `bindingId`: pass it if the work item has more than one binding.
   If it returns `UNKNOWN_ITEM`, re-run step 2 and retry once with the exact ids. Tell the user they are now the implementer for this re-attestation.
5. **Checker.** Suggest that someone other than the implementer checks the work. If the user names a person and gives their account, call `canon-assign-checker`; Rovo's confirmation card is the confirmation (the user clicks Confirm). On `SELF_REVIEW` explain that the implementer can't check their own work; on `CHECKER_NO_ACCESS` explain that person can't see this work item.
6. **Hand-off.** Tell the user to complete each item in the Canon panel's Attest tab, and that the checker signs off there. You never mark items done or sign.

## Examples

Do: "Rollback changed from 'revert DNS weight … within 30 minutes' to 'switch the processor-routing flag; DNS rollback prohibited … within 15 minutes'. This shortens the window and forbids the old method."

Don't: "I've marked the rollback step as done." (You never attest.)

Don't: invent a step that isn't in the delta, or describe a draft version as approved.
