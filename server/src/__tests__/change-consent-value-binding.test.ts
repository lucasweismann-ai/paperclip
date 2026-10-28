// Regression suite for value binding on the change-consent gate.
//
// The first `describe` block was written BEFORE the fix and asserted the defect:
// an accepted request_confirmation card was matched on `payload.target.key`
// alone, so an approval that displayed one set of values could be redeemed for a
// completely different set. Those assertions are now INVERTED in place — the
// same setup, the same exploit attempt, now refused. The git diff of this file
// is the before/after evidence that the gate now binds an approval to values.
//
// What changed in the gate: a card carries a server-stamped digest over the
// exact end state it authorizes, the caller supplies the digest of the write it
// is about to perform, and a mismatch denies instead of inheriting the approval.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CONSENT_VALUE_DIGEST_VERSION,
  agentProfileChangeTargetKey,
  canonicalizeConsentValues,
  changeConsentGateService,
  consentValueDigest,
} from "../services/change-consent-gate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** The profile fields the consent gate protects, as displayed on a card. */
type ProfilePatch = {
  name?: string;
  role?: string;
  title?: string;
  capabilities?: string;
};

function renderProposedDiff(before: ProfilePatch, after: ProfilePatch) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const lines = keys.flatMap((key) => {
    const from = before[key as keyof ProfilePatch];
    const to = after[key as keyof ProfilePatch];
    if (from === to) return [];
    return [`-${key}: ${from ?? "(unset)"}`, `+${key}: ${to ?? "(unset)"}`];
  });
  return ["```diff", ...lines, "```"].join("\n");
}

describeEmbeddedPostgres("change consent gate: binding approvals to displayed values", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-consent-value-binding-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const proposerId = randomUUID();
    const victimId = randomUUID();
    const sourceRunId = randomUUID();
    const proposalIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "The Workshop",
      issuePrefix: "THE",
      defaultResponsibleUserId: "local-board",
    });
    await db.insert(agents).values({
      id: proposerId,
      companyId,
      name: "Proposer",
      role: "general",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // The agent whose profile the approval is about.
    await db.insert(agents).values({
      id: victimId,
      companyId,
      name: "Builder",
      role: "engineer",
      title: "Build Engineer",
      capabilities: "builds things",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: proposerId,
      status: "succeeded",
    });
    await db.insert(issues).values({
      id: proposalIssueId,
      companyId,
      title: "Review profile change proposal",
      status: "in_review",
      priority: "medium",
      identifier: "ISS-1",
      issueNumber: 1,
      createdByAgentId: proposerId,
    });

    return { companyId, proposerId, victimId, sourceRunId, proposalIssueId };
  }

  /**
   * Raise and accept a request_confirmation card that DISPLAYS a specific diff.
   * This mirrors what a proposing agent writes in heartbeat N.
   */
  async function raiseAcceptedCard(ctx: {
    companyId: string;
    proposerId: string;
    victimId: string;
    sourceRunId: string;
    proposalIssueId: string;
    displayedBefore: ProfilePatch;
    displayedAfter: ProfilePatch;
  }) {
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: ctx.companyId,
      issueId: ctx.proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId: ctx.sourceRunId,
      createdByAgentId: ctx.proposerId,
      payload: {
        version: 1,
        prompt: "Apply this profile change?",
        detailsMarkdown: renderProposedDiff(ctx.displayedBefore, ctx.displayedAfter),
        target: {
          type: "custom",
          key: agentProfileChangeTargetKey(ctx.victimId),
          revisionId: "proposal-v1",
          // The card commits to the values it DISPLAYED. In production this
          // pair is stamped server-side at raise time by
          // issueThreadInteractionService.create, from target.proposedValues.
          proposedValues: ctx.displayedAfter as Record<string, unknown>,
          valueDigest: consentValueDigest(
            agentProfileChangeTargetKey(ctx.victimId),
            ctx.displayedAfter as Record<string, unknown>,
          ),
          digestVersion: CONSENT_VALUE_DIGEST_VERSION,
        },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "local-board",
      resolvedAt: new Date(),
    });
    return interactionId;
  }

  /**
   * The apply step, modelling `assertCanApplyProtectedAgentChange` +
   * `svc.update(id, patchData)` in server/src/routes/agents.ts (~:2780, ~:5401).
   * The gate is now handed a digest of the patch it is about to write, so it can
   * compare the pending write against what the card displayed.
   */
  async function applyProfilePatch(ctx: {
    companyId: string;
    proposerId: string;
    victimId: string;
    actorRunId: string;
    patch: ProfilePatch;
  }) {
    const targetKey = agentProfileChangeTargetKey(ctx.victimId);
    await changeConsentGateService(db).assertConsented({
      companyId: ctx.companyId,
      actorAgentId: ctx.proposerId,
      actorRunId: ctx.actorRunId,
      targetKeys: [targetKey],
      expectedValueDigest: consentValueDigest(targetKey, ctx.patch as Record<string, unknown>),
      requiresHumanResolver: false,
    });
    await db.update(agents).set({ ...ctx.patch, updatedAt: new Date() }).where(eq(agents.id, ctx.victimId));
  }

  async function readProfile(victimId: string) {
    const [row] = await db
      .select({
        name: agents.name,
        role: agents.role,
        title: agents.title,
        capabilities: agents.capabilities,
      })
      .from(agents)
      .where(eq(agents.id, victimId));
    return row;
  }

  // ---------------------------------------------------------------------------
  // THE FIX (acceptance criterion 3). These are the two tests that asserted the
  // defect, inverted in place: identical setup, identical exploit attempt, now
  // refused. Nothing about the attack was made easier to detect — the card is
  // still accepted, still from a previous run, still unconsumed, still showing a
  // diff. Only the value binding stops it.
  // ---------------------------------------------------------------------------
  describe("approvals are bound to the values they displayed", () => {
    it("refuses an approval redeemed for values the human never saw", async () => {
      const ctx = await seedFixture();

      // Heartbeat N: the human is shown, and accepts, a narrow cosmetic change.
      const displayedBefore: ProfilePatch = { title: "Build Engineer" };
      const displayedAfter: ProfilePatch = { title: "Senior Build Engineer" };
      const interactionId = await raiseAcceptedCard({ ...ctx, displayedBefore, displayedAfter });
      const profileBefore = await readProfile(ctx.victimId);

      // Heartbeat N+1: the proposer tries to apply something else entirely
      // under the same target key. The gate now recomputes the digest from the
      // pending write and refuses.
      const neverDisplayed: ProfilePatch = {
        name: "Administrator",
        role: "admin",
        title: "Owner",
        capabilities: "unrestricted",
      };
      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: neverDisplayed,
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "consent_value_digest_mismatch" },
      });

      // The undisplayed values were never written.
      expect(await readProfile(ctx.victimId)).toEqual(profileBefore);

      // And the deny path did NOT write: the card is left accepted and
      // unconsumed, so the audit trail does not claim the human approved
      // anything, and a correct re-apply can still redeem it.
      const [stored] = await db
        .select({ payload: issueThreadInteractions.payload, result: issueThreadInteractions.result })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(stored?.result).toMatchObject({ outcome: "accepted" });
      expect((stored?.result as { consumedAt?: unknown }).consumedAt).toBeUndefined();
      expect((stored?.result as { consumedByRunId?: unknown }).consumedByRunId).toBeUndefined();

      // The card still displays only the `title` change, as the human saw it.
      const details = (stored?.payload as { detailsMarkdown: string }).detailsMarkdown;
      expect(details).toContain("+title: Senior Build Engineer");
      expect(details).not.toContain("capabilities:");

      // The approval remains redeemable for exactly what it displayed.
      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: displayedAfter,
      })).resolves.toBeUndefined();
      expect(await readProfile(ctx.victimId)).toMatchObject({ title: "Senior Build Engineer" });
    });

    it("refuses a card whose displayed diff is unrelated boilerplate", async () => {
      const ctx = await seedFixture();

      // `payloadHasDisplayedDiff` is still only a regex over detailsMarkdown —
      // this card satisfies it. What stops the redemption is that the card is
      // bound to no values at all, so it authorizes nothing.
      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId: ctx.companyId,
        issueId: ctx.proposalIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId: ctx.sourceRunId,
        createdByAgentId: ctx.proposerId,
        payload: {
          version: 1,
          prompt: "Apply this profile change?",
          detailsMarkdown: "- no material change\n- formatting only",
          target: {
            type: "custom",
            key: agentProfileChangeTargetKey(ctx.victimId),
            revisionId: "proposal-v1",
          },
        },
        result: { version: 1, outcome: "accepted" },
        resolvedByUserId: "local-board",
        resolvedAt: new Date(),
      });
      const profileBefore = await readProfile(ctx.victimId);

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: { name: "Administrator", role: "admin" },
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "consent_value_digest_absent" },
      });

      expect(await readProfile(ctx.victimId)).toEqual(profileBefore);
    });

    it("refuses a digest transplanted from another target's card", async () => {
      const ctx = await seedFixture();
      const sameValues: ProfilePatch = { title: "Senior Build Engineer" };
      const victimKey = agentProfileChangeTargetKey(ctx.victimId);
      const proposerKey = agentProfileChangeTargetKey(ctx.proposerId);

      // The target key is inside the digest preimage, so the same values under
      // a different target produce a different digest.
      expect(consentValueDigest(proposerKey, sameValues as Record<string, unknown>))
        .not.toEqual(consentValueDigest(victimKey, sameValues as Record<string, unknown>));

      // A card filed under the VICTIM's target key, but carrying a digest
      // computed for the proposer's target — the transplant a confused or
      // malicious proposer would attempt to make one approval cover two targets.
      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId: ctx.companyId,
        issueId: ctx.proposalIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId: ctx.sourceRunId,
        createdByAgentId: ctx.proposerId,
        payload: {
          version: 1,
          prompt: "Apply this profile change?",
          detailsMarkdown: renderProposedDiff({ title: "Build Engineer" }, sameValues),
          target: {
            type: "custom",
            key: victimKey,
            revisionId: "proposal-v1",
            proposedValues: sameValues,
            valueDigest: consentValueDigest(proposerKey, sameValues as Record<string, unknown>),
            digestVersion: CONSENT_VALUE_DIGEST_VERSION,
          },
        },
        result: { version: 1, outcome: "accepted" },
        resolvedByUserId: "local-board",
        resolvedAt: new Date(),
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: sameValues,
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "consent_value_digest_mismatch" },
      });
    });

    it("refuses a card whose digest version is not recognized", async () => {
      const ctx = await seedFixture();
      const values: ProfilePatch = { title: "Senior Build Engineer" };
      const targetKey = agentProfileChangeTargetKey(ctx.victimId);

      // A future digest algorithm must not be compared with the v1 one.
      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId: ctx.companyId,
        issueId: ctx.proposalIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId: ctx.sourceRunId,
        createdByAgentId: ctx.proposerId,
        payload: {
          version: 1,
          prompt: "Apply this profile change?",
          detailsMarkdown: renderProposedDiff({ title: "Build Engineer" }, values),
          target: {
            type: "custom",
            key: targetKey,
            revisionId: "proposal-v1",
            proposedValues: values,
            valueDigest: consentValueDigest(targetKey, values as Record<string, unknown>),
            digestVersion: 2,
          },
        },
        result: { version: 1, outcome: "accepted" },
        resolvedByUserId: "local-board",
        resolvedAt: new Date(),
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: values,
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "consent_value_digest_absent" },
      });
    });

    it("picks the card bound to this write when several are accepted for one target", async () => {
      const ctx = await seedFixture();

      // Two live approvals under the same target key. The older one is the one
      // that matches the pending write, so denying on the newest would be wrong.
      const wanted: ProfilePatch = { title: "Senior Build Engineer" };
      const matching = await raiseAcceptedCard({
        ...ctx,
        displayedBefore: { title: "Build Engineer" },
        displayedAfter: wanted,
      });
      const other = await raiseAcceptedCard({
        ...ctx,
        displayedBefore: { title: "Build Engineer" },
        displayedAfter: { title: "Principal Engineer" },
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: wanted,
      })).resolves.toBeUndefined();

      const rows = await db
        .select({ id: issueThreadInteractions.id, result: issueThreadInteractions.result })
        .from(issueThreadInteractions);
      const consumedIds = rows
        .filter((row) => (row.result as { consumedAt?: unknown }).consumedAt !== undefined)
        .map((row) => row.id);
      // Exactly the matching card was consumed; the unrelated approval is untouched.
      expect(consumedIds).toEqual([matching]);
      expect(rows.find((row) => row.id === other)?.result).toMatchObject({ outcome: "accepted" });
    });
  });

  // ---------------------------------------------------------------------------
  // The digest itself.
  // ---------------------------------------------------------------------------
  describe("consent value digest", () => {
    const targetKey = "agent:11111111-1111-1111-1111-111111111111:profile";

    it("is independent of key order", () => {
      expect(consentValueDigest(targetKey, { name: "A", role: "b" }))
        .toEqual(consentValueDigest(targetKey, { role: "b", name: "A" }));
    });

    it("distinguishes a null from an absent field", () => {
      // `null` means "clear this field" — a real, displayable value.
      expect(consentValueDigest(targetKey, { title: null }))
        .not.toEqual(consentValueDigest(targetKey, {}));
      expect(canonicalizeConsentValues({ title: null })).toEqual('{"title":null}');
      expect(canonicalizeConsentValues({ title: undefined })).toEqual("{}");
    });

    it("treats a whitespace-only edit as a value change", () => {
      expect(consentValueDigest(targetKey, { title: "Owner" }))
        .not.toEqual(consentValueDigest(targetKey, { title: "Owner " }));
    });

    it("binds the digest to its target key", () => {
      expect(consentValueDigest(targetKey, { title: "Owner" }))
        .not.toEqual(consentValueDigest(`${targetKey}x`, { title: "Owner" }));
    });

    it("refuses values that do not canonicalize predictably", () => {
      // A Date would serialize to `{}` and silently digest as "no values".
      expect(() => consentValueDigest(targetKey, { when: new Date() })).toThrow();
      expect(() => consentValueDigest(targetKey, { size: Number.NaN })).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Properties the gate DOES enforce today. These must keep passing after the
  // fix — the fix adds a check, it does not relax any of these.
  // ---------------------------------------------------------------------------
  describe("existing guarantees that must survive the fix", () => {
    it("still requires a card raised in a previous run", async () => {
      const ctx = await seedFixture();
      await raiseAcceptedCard({
        ...ctx,
        displayedBefore: { title: "Build Engineer" },
        displayedAfter: { title: "Senior Build Engineer" },
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: ctx.sourceRunId,
        patch: { title: "Senior Build Engineer" },
      })).rejects.toMatchObject({ status: 403 });
    });

    it("still refuses a second redemption of the same card", async () => {
      const ctx = await seedFixture();
      await raiseAcceptedCard({
        ...ctx,
        displayedBefore: { title: "Build Engineer" },
        displayedAfter: { title: "Senior Build Engineer" },
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: { title: "Senior Build Engineer" },
      })).resolves.toBeUndefined();

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: { title: "Senior Build Engineer" },
      })).rejects.toMatchObject({ status: 403 });
    });

    it("still refuses a card raised for a different agent's profile", async () => {
      const ctx = await seedFixture();
      await raiseAcceptedCard({
        ...ctx,
        victimId: ctx.proposerId, // card is about a different target
        displayedBefore: { title: "Proposer" },
        displayedAfter: { title: "Proposer II" },
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: { title: "Senior Build Engineer" },
      })).rejects.toMatchObject({ status: 403 });
    });
  });
});
