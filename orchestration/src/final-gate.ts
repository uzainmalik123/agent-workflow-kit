import { WorkflowState, type FixReturnState } from "@agent-workflow-kit/core";
import { staleVerificationEvidence } from "./fix-policy.js";
import { staleSecurityReview, type SecurityReviewEvidence } from "./security.js";
import {
  VERIFICATION_STAGE_BY_WORK_STAGE,
  VERIFICATION_WORK_STAGES,
  type VerificationEvidenceBundle,
  type VerificationStage,
} from "./verification.js";
import { WORK_STAGES, type WorkStage } from "./stages.js";

/**
 * The final gate.
 *
 * `final_summary` is the only artifact a reader ever sees, and it is written by a model from whatever
 * the stages before it left behind. This module is the check that has to come before it: a
 * deterministic pass over the framework's own records that either proves the feature is ready to be
 * summarized or names the earlier stage whose evidence is not good enough.
 *
 * Three properties make it a gate rather than another review, and they are why it is a small pure
 * function instead of a fourth provider:
 *
 * - **It decides from measurements, never from prose.** Everything below is read from the artifacts
 *   the framework itself wrote: the recorded verification bundles, the recorded security record, the
 *   recorded fix history, the verdict the plan-approval freeze already produced, and a workspace
 *   inspection taken while the gate runs. A stage's own section is a claim, and a claim is used here
 *   for exactly one thing — it can withhold a pass, never grant one.
 * - **It decides from what is recorded, never by re-measuring.** It runs no command, starts no
 *   process, and asks no provider. A gate that re-ran the tests it is judging would be a fourth
 *   verification stage with none of the freshness guarantees the first three have, so stale evidence
 *   makes the gate refuse rather than the gate go and refresh itself.
 * - **It decides the same way twice.** Given the same records it returns the same result: no clock,
 *   no randomness, no I/O, no ordering that depends on anything but the input. That is what makes the
 *   failure testable at all.
 *
 * The one thing it cannot do on its own is attribute a check to an acceptance criterion, because
 * nothing in the evidence records names a criterion. So the criterion results it reports are the
 * framework's evidence-set verdict applied to every criterion the approved specification declares,
 * and a criterion no stage reported on is not thereby verified by the gate — it is verified exactly as
 * far as the recorded bundles are, which is the only claim the framework can make. The limits are
 * stated here rather than left to be discovered: a criterion is never certified by a model's say-so,
 * and the gate never invents a per-criterion mapping it cannot re-derive.
 */

/* -------------------------------------------------------------------------------------------- */
/* The vocabulary                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * The three answers, and no others.
 *
 * `failed` means something is known to be wrong or is known to be missing, and the workflow is not
 * ready. `inconclusive` means something could not be determined — a bundle older than the fix it was
 * meant to re-test, a security check nobody could decide, a stage that measured nothing — and that is
 * kept distinct precisely so it cannot be reported as the other two. `passed` is the only one that
 * advances the workflow.
 */
export const FINAL_GATE_STATUSES = ["passed", "failed", "inconclusive"] as const;

export type FinalGateStatus = (typeof FINAL_GATE_STATUSES)[number];

/**
 * The per-stage and per-criterion verification verdict.
 *
 * A stage has no evidence at all and a stage whose evidence is too old to describe this tree are
 * different findings with different remedies, so they are different words rather than one `not_passed`.
 * `inconclusive` is a recorded `deferred` bundle: the project declared that check impossible, which
 * the verification stage itself treats as unmeasured rather than as a failure, and which the gate
 * likewise will not read as a pass.
 */
export const FINAL_GATE_VERIFICATION_STATUSES = [
  "passed",
  "failed",
  "inconclusive",
  "missing",
  "stale",
] as const;

export type FinalGateVerificationStatus = (typeof FINAL_GATE_VERIFICATION_STATUSES)[number];

/**
 * The framework's own scope check, taken while the gate runs.
 *
 * `not_applicable` is separated from `unmeasured` because the two mean opposite things. A project with
 * no isolated-workspace adapter runs its stages in the human's own checkout, where the framework writes
 * nothing of its own and has no change set to judge — there is nothing that could be outside the
 * approved scope. That is a supported configuration and not a finding, so it does not block. A
 * workspace that is configured but could not be inspected is a different thing: there was a change set
 * to judge and nobody judged it, which is the case R4 is about.
 */
export const FINAL_GATE_SCOPE_STATUSES = [
  "clean",
  "not_applicable",
  "violated",
  "unmeasured",
  "stale",
] as const;

export type FinalGateScopeStatus = (typeof FINAL_GATE_SCOPE_STATUSES)[number];

/** What the gate could establish about the change set before it judged it. */
export const FINAL_GATE_SCOPE_BASES = ["measured", "not_measured", "unmeasurable"] as const;

export type FinalGateScopeBasis = (typeof FINAL_GATE_SCOPE_BASES)[number];

/** `pass`, `fail`, and `inconclusive` are the security record's own words; the last two are the gate's. */
export const FINAL_GATE_SECURITY_STATUSES = [
  "pass",
  "fail",
  "inconclusive",
  "missing",
  "stale",
] as const;

export type FinalGateSecurityStatus = (typeof FINAL_GATE_SECURITY_STATUSES)[number];

/** Whether the approved artifacts still hash to what the human approved. */
export const FINAL_GATE_APPROVAL_STATUSES = ["intact", "invalidated", "missing"] as const;

export type FinalGateApprovalStatus = (typeof FINAL_GATE_APPROVAL_STATUSES)[number];

/**
 * What the recorded fix history says about the loop that ran before the gate.
 *
 * `reverified` means every stage a fix touched has evidence collected after that fix. It is a
 * summary of facts the per-stage checks already report, kept as its own field because "the fixer ran
 * and something re-tested the repair" is the question a reader of a failed feature asks first.
 */
export const FINAL_GATE_FIXER_STATUSES = ["none", "reverified", "unreverified", "exhausted"] as const;

export type FinalGateFixerStatus = (typeof FINAL_GATE_FIXER_STATUSES)[number];

/**
 * Every reason the gate can refuse, as a closed set of codes.
 *
 * A closed set is the point: the codes are what a caller branches on, so an open vocabulary would put
 * a human reading prose where a program needs a fact. Each code names a distinct finding rather than
 * a stage's opinion, and each carries the earlier stage it belongs to.
 */
export const FINAL_GATE_BLOCKERS = [
  "approval_invalidated",
  "approval_missing",
  "criterion_reported_failed",
  "fix_attempts_exhausted",
  "security_evidence_missing",
  "security_evidence_stale",
  "security_inconclusive",
  "security_not_passed",
  "scope_not_measured",
  "scope_outside_approved_scope",
  "scope_stale",
  "verification_configuration_changed",
  "verification_evidence_missing",
  "verification_evidence_stale",
  "verification_failed",
  "verification_inconclusive",
  "workflow_state_inconsistent",
  "working_tree_changed",
] as const;

export type FinalGateBlockerCode = (typeof FINAL_GATE_BLOCKERS)[number];

/**
 * Where a failure belongs.
 *
 * A `WorkStage` is an earlier stage whose work would produce the evidence the gate is missing.
 * `escalate` is the answer when no stage would: nothing was measured, or the workflow itself is in a
 * state this gate cannot judge. The route is a report rather than a transition — the state machine
 * has no way back from `final_gate`, and inventing one would be a different milestone from this one.
 */
export type FinalGateRoute = WorkStage | "escalate";

export const FINAL_GATE_ESCALATION = "escalate" as const;

/** One bounded reference to what the gate decided from. Never content, never an excerpt. */
export interface FinalGateEvidenceReference {
  readonly kind: "approval" | "fixes" | "scope" | "security" | "specification" | "verification";
  readonly reference: string;
  readonly description: string;
}

export interface FinalGateBlocker {
  readonly code: FinalGateBlockerCode;
  readonly route: FinalGateRoute;
  /** One sentence naming the finding. A gate result a human has to decode is a worse gate. */
  readonly message: string;
}

/** One verification stage's own verdict, with the measurement the verdict came from. */
export interface FinalGateStageResult {
  readonly stage: WorkStage;
  readonly verification: VerificationStage;
  readonly status: FinalGateVerificationStatus;
  readonly revision: number | null;
  readonly fingerprint: string | null;
  readonly reference: string;
}

/** One approved acceptance criterion and the final result the gate could establish for it. */
export interface FinalGateCriterionResult {
  readonly requirementId: string;
  readonly acceptanceCriterionId: string;
  readonly status: FinalGateVerificationStatus;
  /** The stage whose recorded section reported this criterion, when one did. */
  readonly reportedBy: WorkStage | null;
}

/**
 * The gate's answer, and the whole of it.
 *
 * Deliberately small: a status, the revision and fingerprint it was decided against, the criteria it
 * checked, one status per measured surface, the blockers, and where to go next. The evidence lives in
 * the artifacts it references; nothing here is a report, and nothing here is a model's account.
 */
export interface FinalGateResult {
  readonly schemaVersion: 1;
  readonly featureId: string;
  readonly status: FinalGateStatus;
  readonly state: WorkflowState;
  readonly revision: number;
  /** The working-tree fingerprint the gate measured. Empty when nothing could be measured. */
  readonly fingerprint: string;
  readonly requirementIds: readonly string[];
  readonly acceptanceCriterionIds: readonly string[];
  /** The criteria the approved specification declares, capped at {@link MAX_FINAL_GATE_CRITERIA}. */
  readonly criteria: readonly FinalGateCriterionResult[];
  readonly criterionCount: number;
  readonly criteriaTruncated: boolean;
  readonly verification: FinalGateVerificationStatus;
  readonly verificationStages: readonly FinalGateStageResult[];
  readonly security: FinalGateSecurityStatus;
  readonly scope: FinalGateScopeStatus;
  readonly approval: FinalGateApprovalStatus;
  readonly fixer: FinalGateFixerStatus;
  readonly blockers: readonly FinalGateBlocker[];
  readonly route: FinalGateRoute;
  readonly evidence: readonly FinalGateEvidenceReference[];
}

/* -------------------------------------------------------------------------------------------- */
/* The input                                                                                      */
/* -------------------------------------------------------------------------------------------- */

export interface FinalGateCriterionInput {
  readonly requirementId: string;
  readonly acceptanceCriterionId: string;
}

/** One recorded fix attempt, reduced to what freshness and exhaustion are decided from. */
export interface FinalGateFixInput {
  readonly originStage: FixReturnState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly recordedAt: string;
  readonly revisionBefore: number;
}

/**
 * What a verification stage recorded about a criterion.
 *
 * Read from the stage's own section, which is a model's account, and used in exactly one situation: a
 * claim of `failed` withholds the criterion from the gate. Nothing else about a claim does anything.
 * A `passed` claim cannot grant the gate anything, because a model's report that a criterion passed is
 * not evidence; and a claim of `inconclusive` is deliberately not a blocker either, because the
 * verifier role is instructed to report `inconclusive` for any criterion the recorded evidence does
 * not cover — so treating it as one would make a correctly-behaved verifier capable of making a
 * feature uncertifiable forever, which is a gate nobody satisfies rather than a gate.
 *
 * What is left is the one direction that cannot do harm: a stage that reports a criterion as failed
 * while the framework's deterministic checks for that stage passed is a contradiction the gate cannot
 * resolve, and it refuses rather than picking a side.
 */
export interface FinalGateCriterionClaim {
  readonly requirementId: string;
  readonly acceptanceCriterionId: string | null;
  readonly status: "passed" | "failed" | "inconclusive";
}

export interface FinalGateVerificationInput {
  readonly stage: WorkStage;
  readonly verification: VerificationStage;
  readonly bundle: VerificationEvidenceBundle | null;
  /** The newest recorded fix for this stage, which its evidence has to postdate. */
  readonly fix: FinalGateFixInput | null;
  /**
   * Whether the verification configuration the newest bundle recorded differs from the one the last
   * fix was measured with. The command set changing after a repair means the evidence describes
   * different checks than the ones the repair was judged against.
   */
  readonly configurationChanged: boolean;
  readonly claims: readonly FinalGateCriterionClaim[];
}

export interface FinalGateSecurityInput {
  readonly evidence: SecurityReviewEvidence | null;
  readonly fix: FinalGateFixInput | null;
}

/**
 * The framework's scope measurement for this run.
 *
 * Taken fresh rather than read from the record, because no artifact holds it: the `scope_review` stage
 * writes a model's document, and the framework's own scope evidence is a per-run value on the stage
 * result. Re-deriving it from the tree the gate is looking at is what makes "the tree moved since" a
 * finding rather than a coincidence — which is the whole content of the check.
 */
export interface FinalGateScopeInput {
  readonly basis: FinalGateScopeBasis;
  /** False when the measured change set touches a path the approved plan does not describe. */
  readonly insideApprovedScope: boolean;
  /** False when HEAD moved inside the workspace or something was staged. */
  readonly integrityOk: boolean;
  readonly fingerprint: string | null;
  readonly unauthorizedPaths: readonly string[];
  readonly reason: string;
}

export interface FinalGateApprovalInput {
  readonly status: FinalGateApprovalStatus;
  readonly reason: string;
}

export interface FinalGateFixerInput {
  readonly attempts: number;
  readonly latest: FinalGateFixInput | null;
}

export interface FinalGateInput {
  readonly featureId: string;
  readonly state: WorkflowState;
  readonly revision: number;
  readonly fingerprint: string;
  readonly criteria: readonly FinalGateCriterionInput[];
  readonly verification: readonly FinalGateVerificationInput[];
  readonly security: FinalGateSecurityInput;
  readonly scope: FinalGateScopeInput;
  readonly approval: FinalGateApprovalInput;
  readonly fix: FinalGateFixerInput;
}

/** A criterion list is a bounded part of a result, not the report the result is. */
export const MAX_FINAL_GATE_CRITERIA = 50;

/* -------------------------------------------------------------------------------------------- */
/* Reading the input                                                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * The acceptance criteria an approved specification declares.
 *
 * The framework reads the specification when it is structured and takes nothing on trust when it is
 * not. A specification written as prose names its criteria in sentences rather than in ids, and a
 * gate that refused every project whose griller wrote Markdown would be a gate nobody satisfies — so
 * an unstructured specification contributes no criteria here, and the gate then decides on the
 * evidence set alone rather than pretending to have read a list it could not.
 *
 * What this never does is widen the set: ids are taken verbatim from the approved artifact, which the
 * approval checkpoint has already frozen by digest.
 */
export function criteriaFromSpec(spec: unknown): readonly FinalGateCriterionInput[] {
  if (!isRecord(spec)) {
    return [];
  }

  const requirements = spec["requirements"];

  if (!Array.isArray(requirements)) {
    return [];
  }

  const criteria: FinalGateCriterionInput[] = [];

  for (const requirement of requirements) {
    if (!isRecord(requirement)) {
      continue;
    }

    const requirementId = textField(requirement["id"]);

    if (requirementId === null || !Array.isArray(requirement["acceptanceCriteria"])) {
      continue;
    }

    for (const criterion of requirement["acceptanceCriteria"]) {
      if (!isRecord(criterion)) {
        continue;
      }

      const acceptanceCriterionId = textField(criterion["id"]);

      if (acceptanceCriterionId === null) {
        continue;
      }

      criteria.push({ requirementId, acceptanceCriterionId });
    }
  }

  return criteria;
}

/**
 * The criterion results a stage's own recorded section claims.
 *
 * Only the newest section per stage is read, for the same reason the fix policy reads only the newest
 * attempt: an earlier attempt's account of a criterion describes code that has since been repaired,
 * and quoting it next to the newest evidence is how a repaired criterion reads as broken.
 *
 * Entries that are not shaped like a result are skipped rather than refused. This is a claim, not
 * evidence: the section is model-written and unvalidated, and a section this parser cannot read is a
 * section that withholds nothing.
 */
export function criterionClaimsFrom(artifact: unknown, stage: WorkStage): readonly FinalGateCriterionClaim[] {
  if (!isRecord(artifact)) {
    return [];
  }

  const section = artifact[stage];

  if (!isRecord(section) || !Array.isArray(section["results"])) {
    return [];
  }

  const claims: FinalGateCriterionClaim[] = [];

  for (const entry of section["results"]) {
    if (!isRecord(entry)) {
      continue;
    }

    const status = entry["status"];

    if (status !== "passed" && status !== "failed" && status !== "inconclusive") {
      continue;
    }

    const requirementId = textField(entry["requirementId"]);

    if (requirementId === null) {
      continue;
    }

    claims.push({
      requirementId,
      acceptanceCriterionId: textField(entry["acceptanceCriterionId"]),
      status,
    });
  }

  return claims;
}

/* -------------------------------------------------------------------------------------------- */
/* The evaluation                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * How the per-stage verdicts combine into the one the gate reports.
 *
 * `failed` and `missing` outrank `stale`, because a stage with no evidence at all is a larger gap
 * than a stage whose evidence is merely old, and both outrank `inconclusive`. The order exists to
 * make the aggregate deterministic rather than to make it clever: the same set of stages in the same
 * states always names the same worst one.
 */
const VERIFICATION_PRECEDENCE: readonly FinalGateVerificationStatus[] = [
  "failed",
  "missing",
  "stale",
  "inconclusive",
  "passed",
];

function worstVerification(
  left: FinalGateVerificationStatus,
  right: FinalGateVerificationStatus,
): FinalGateVerificationStatus {
  return VERIFICATION_PRECEDENCE.indexOf(left) <= VERIFICATION_PRECEDENCE.indexOf(right) ? left : right;
}

/**
 * The newest measurement of the implementation, which every other measurement has to agree with.
 *
 * Newest is the greatest revision the bundles carry, with the workflow's own stage order breaking a
 * tie: a session that ran its stages in the workflow's order measures them in that order too, and a
 * provider with a coarse clock can legitimately stamp two stages with the same timestamp. Two stages
 * that disagree about the tree they saw is the fact this finds, and it is the fact requirement "the
 * working tree changed after verification" is really about — the implementation fingerprint covers
 * file content, which the change-set fingerprint a security record carries does not.
 */
function newestFingerprint(
  stages: readonly FinalGateVerificationInput[],
): string | null {
  let newest: { readonly revision: number; readonly fingerprint: string; readonly stage: WorkStage } | null =
    null;

  for (const stage of stages) {
    const bundle = stage.bundle;

    if (bundle === null) {
      continue;
    }

    if (
      newest === null ||
      bundle.revision > newest.revision ||
      (bundle.revision === newest.revision && stageOrder(stage.stage) > stageOrder(newest.stage))
    ) {
      newest = {
        revision: bundle.revision,
        fingerprint: bundle.implementationFingerprint,
        stage: stage.stage,
      };
    }
  }

  return newest === null ? null : newest.fingerprint;
}

function stageOrder(stage: WorkStage): number {
  const index = WORK_STAGES.indexOf(stage);

  return index < 0 ? WORK_STAGES.length : index;
}

function orderedVerificationStages(
  stages: readonly FinalGateVerificationInput[],
): readonly FinalGateVerificationInput[] {
  const byStage = new Map<WorkStage, FinalGateVerificationInput>();

  for (const stage of stages) {
    byStage.set(stage.stage, stage);
  }

  const ordered: FinalGateVerificationInput[] = [];

  for (const stage of VERIFICATION_WORK_STAGES) {
    const verification = VERIFICATION_STAGE_BY_WORK_STAGE[stage];

    if (verification === undefined) {
      continue;
    }

    ordered.push(
      byStage.get(stage) ?? {
        stage,
        verification,
        bundle: null,
        fix: null,
        configurationChanged: false,
        claims: [],
      },
    );
  }

  for (const stage of stages) {
    if (!VERIFICATION_WORK_STAGES.includes(stage.stage)) {
      ordered.push(stage);
    }
  }

  return [...ordered].sort((left, right) => stageOrder(left.stage) - stageOrder(right.stage));
}

function stageEvidence(
  input: FinalGateVerificationInput,
  status: FinalGateVerificationStatus,
): FinalGateStageResult {
  const bundle = input.bundle;

  return {
    stage: input.stage,
    verification: input.verification,
    status,
    revision: bundle === null ? null : bundle.revision,
    fingerprint: bundle === null ? null : bundle.implementationFingerprint,
    reference: `verification-evidence#${input.stage}`,
  };
}

/**
 * Decides one verification stage from its recorded bundle.
 *
 * Freshness is checked before the verdict, because a stale `passed` describes code that no longer
 * exists and a fresh `failed` describes code that does: the order is what stops the gate from
 * reporting a repair as verified by the evidence the repair invalidated. Three separate things make
 * evidence stale and they are not interchangeable — evidence from before the last fix, evidence
 * collected for a different tree than the newest measurement, and evidence whose command set is no
 * longer the one the fix was judged against.
 */
function evaluateVerificationStage(
  input: FinalGateVerificationInput,
  fingerprint: string | null,
): { readonly status: FinalGateVerificationStatus; readonly blockers: FinalGateBlocker[] } {
  const bundle = input.bundle;
  const blockers: FinalGateBlocker[] = [];

  if (bundle === null) {
    return {
      status: "missing",
      blockers: [
        {
          code: "verification_evidence_missing",
          route: input.stage,
          message: `No ${input.verification} evidence is recorded for this feature, so no acceptance criterion has a final ${input.verification} result. The framework does not collect it here: the ${input.stage} stage is where that evidence is produced, and a gate that ran it itself would have none of the freshness guarantees the stage has.`,
        },
      ],
    };
  }

  if (input.fix !== null && staleVerificationEvidence(bundle, input.fix) !== null) {
    return {
      status: "stale",
      blockers: [
        {
          code: "verification_evidence_stale",
          route: input.stage,
          message: `The ${input.verification} evidence was collected before the fix recorded at ${input.fix.recordedAt} was applied, so it describes the tree that fix was supposed to repair and cannot say whether the repair worked. Re-run ${input.stage}.`,
        },
      ],
    };
  }

  if (fingerprint !== null && bundle.implementationFingerprint !== fingerprint) {
    return {
      status: "stale",
      blockers: [
        {
          code: "verification_evidence_stale",
          route: input.stage,
          message: `The ${input.verification} evidence was collected against implementation fingerprint ${bundle.implementationFingerprint}, while the newest evidence was collected against ${fingerprint}. The tree changed between the two stages, so this evidence describes code that no longer exists. Re-run ${input.stage}.`,
        },
      ],
    };
  }

  if (input.configurationChanged) {
    return {
      status: "stale",
      blockers: [
        {
          code: "verification_configuration_changed",
          route: input.stage,
          message: `The ${input.verification} checks recorded after the last fix are not the checks that fix was measured against, so a passing run proves a different thing than the repair was asked to satisfy. Re-run ${input.stage}.`,
        },
      ],
    };
  }

  if (bundle.outcome === "failed" || bundle.outcome === "blocked") {
    return {
      status: "failed",
      blockers: [
        {
          code: "verification_failed",
          route: input.stage,
          message: `The newest ${input.verification} evidence is "${bundle.outcome}" for revision ${String(bundle.revision)}. Deterministic checks decided this stage, and the gate does not overturn them.`,
        },
      ],
    };
  }

  if (bundle.outcome === "deferred") {
    return {
      status: "inconclusive",
      blockers: [
        {
          code: "verification_inconclusive",
          route: input.stage,
          message: `The newest ${input.verification} evidence is "deferred": no ${input.verification} check ran, so nothing was measured and no acceptance criterion has a passing ${input.verification} result. Declare the ${input.verification} command in agent-workflow.config.json, or accept that this feature cannot be certified.`,
        },
      ],
    };
  }

  return { status: "passed", blockers };
}

/**
 * Decides the security surface from the newest recorded review.
 *
 * Absent evidence is a failure rather than a pass, because the security stage refuses to advance
 * without a deterministic record and a workflow that reached this gate therefore had one: a feature
 * with no recorded review reached this gate by some route other than the one the workflow defines.
 *
 * A run that measured no fingerprint at all cannot contradict the one the record carries, so the
 * comparison is skipped rather than counted as a disagreement: the gate reports that it could not
 * measure the tree through `scope`, and does not additionally claim the tree moved.
 */
function evaluateSecurity(input: FinalGateSecurityInput, fingerprint: string): FinalGateSecurityStatus {
  const evidence = input.evidence;

  if (evidence === null) {
    return "missing";
  }

  if (input.fix !== null && staleSecurityReview(evidence, input.fix) !== null) {
    return "stale";
  }

  if (fingerprint.length > 0 && evidence.workspaceFingerprint !== fingerprint) {
    return "stale";
  }

  return evidence.status;
}

/**
 * Decides the scope surface.
 *
 * Measured first, then stale, then violated, because a scope verdict on a tree nobody can identify is
 * not a scope verdict. The three are also the three ways the framework's existing scope machinery can
 * leave a feature undecided: nothing was measured, the tree the last measurement described has since
 * moved, or the change set touches a path no approved plan describes.
 */
function evaluateScope(input: FinalGateScopeInput, fingerprint: string): FinalGateScopeStatus {
  if (input.basis === "not_measured") {
    return "not_applicable";
  }

  if (input.basis === "unmeasurable") {
    return "unmeasured";
  }

  if (input.fingerprint !== null && input.fingerprint !== fingerprint) {
    return "stale";
  }

  if (!input.insideApprovedScope || !input.integrityOk) {
    return "violated";
  }

  return "clean";
}

/**
 * The gate.
 *
 * Everything it decides comes from `input`, and every branch below is a comparison between two values
 * the framework recorded. There is no default branch that assumes success: a status the input did not
 * establish stays at the value that refuses, so an input assembled from a record this version of the
 * framework does not understand fails the gate rather than passing it.
 */
export function evaluateFinalGate(input: FinalGateInput): FinalGateResult {
  const blockers: FinalGateBlocker[] = [];
  const add = (blocker: FinalGateBlocker): void => {
    blockers.push(blocker);
  };

  if (input.state !== WorkflowState.FinalGate) {
    add({
      code: "workflow_state_inconsistent",
      route: FINAL_GATE_ESCALATION,
      message: `The final gate was asked to decide a feature in state "${input.state}". It decides only in "${WorkflowState.FinalGate}", and a gate that answered for any other state would be deciding a question nobody asked.`,
    });
  }

  if (input.approval.status === "missing") {
    add({
      code: "approval_missing",
      route: "plan_review",
      message: `The session has no plan approval, so there is no approved specification, plan, or scope for this gate to certify. ${input.approval.reason}`,
    });
  } else if (input.approval.status === "invalidated") {
    add({
      code: "approval_invalidated",
      route: "plan_review",
      message: `An approved artifact no longer hashes to what the human approved, so the criteria being certified are not the approved ones. ${input.approval.reason}`,
    });
  }

  /**
   * The three verification stages in workflow order, with any stage the input did not describe filled
   * in as evidence-free rather than dropped.
   *
   * A caller that omits a stage has not established that the stage passed, and silently dropping the
   * omission would let a partial record certify a feature: the same reason a missing bundle is a
   * blocker. Workflow order rather than input order also fixes the sequence of everything below, so
   * two callers that assemble the same evidence in different orders get the same result.
   */
  const ordered = orderedVerificationStages(input.verification);

  const fingerprint = newestFingerprint(ordered);

  const stages: FinalGateStageResult[] = [];
  let verification: FinalGateVerificationStatus = "passed";

  for (const stage of ordered) {
    const evaluated = evaluateVerificationStage(stage, fingerprint);

    verification = worstVerification(verification, evaluated.status);
    stages.push(stageEvidence(stage, evaluated.status));

    for (const blocker of evaluated.blockers) {
      add(blocker);
    }
  }

  for (const stage of ordered) {
    const withheld = withholdsClaims(stage);

    if (withheld === null) {
      continue;
    }

    add(withheld);
  }

  const security = evaluateSecurity(input.security, input.fingerprint);
  const scope = evaluateScope(input.scope, input.fingerprint);

  if (
    input.fingerprint.length > 0 &&
    input.security.evidence !== null &&
    input.security.evidence.workspaceFingerprint !== input.fingerprint
  ) {
    add({
      code: "working_tree_changed",
      route: "security_review",
      message: `The security record was written against working-tree fingerprint ${input.security.evidence.workspaceFingerprint} and this run measures ${input.fingerprint}, so the tree changed after the last deterministic check. Nothing recorded here describes the code that would be summarized. Re-run every verification stage.`,
    });
  }

  if (security === "missing") {
    add({
      code: "security_evidence_missing",
      route: "security_review",
      message:
        "No deterministic security record is stored for this feature. The security stage refuses to advance without one, so a feature that reached this gate without a record was advanced by something other than the workflow. Absence of a finding is not a finding of absence.",
    });
  } else if (security === "stale") {
    add({
      code: "security_evidence_stale",
      route: "security_review",
      message: `The recorded security review does not describe the tree as it is now. ${
        input.security.evidence?.workspaceFingerprint ?? "No fingerprint was recorded"
      } was reviewed, and the working tree is fingerprinted ${input.fingerprint}. Re-run security_review.`,
    });
  } else if (security === "fail") {
    add({
      code: "security_not_passed",
      route: "security_review",
      message: "The newest deterministic security record is a failure, so a check found something in the change set. The gate does not summarize past a known finding.",
    });
  } else if (security === "inconclusive") {
    add({
      code: "security_inconclusive",
      route: "security_review",
      message:
        "The newest deterministic security record could not be decided, so a check nobody ran is the only thing known about part of this change set. Re-run security_review once the check can be decided.",
    });
  }

  if (scope === "unmeasured") {
    add({
      code: "scope_not_measured",
      route: FINAL_GATE_ESCALATION,
      message: `The framework could not measure the change set, so no scope decision was made. ${input.scope.reason}`,
    });
  } else if (scope === "stale") {
    add({
      code: "scope_stale",
      route: "scope_review",
      message: `The recorded scope describes a working tree fingerprinted ${input.scope.fingerprint ?? "unknown"}, and this run measured ${input.fingerprint}. Re-run scope_review.`,
    });
  } else if (scope === "violated") {
    add({
      code: "scope_outside_approved_scope",
      route: "scope_review",
      message: `The change set touches path(s) the approved plan does not describe: ${input.scope.unauthorizedPaths.join(", ")}. ${input.scope.reason}`,
    });
  }

  const criteria = criterionResults(input.criteria, ordered, verification);

  const fixer = fixerStatus(input, stages);

  if (fixer === "exhausted") {
    add({
      code: "fix_attempts_exhausted",
      route: FINAL_GATE_ESCALATION,
      message: `The fix loop for ${input.fix.latest?.originStage ?? "an earlier stage"} spent all ${String(input.fix.latest?.maxAttempts ?? 0)} attempts it was allowed, so the workflow reached the gate only because the record of that refusal was not honoured. A feature with an exhausted repair loop needs a human.`,
    });
  }

  const sorted = [...blockers].sort(compareBlockers);
  const status = gateStatus(sorted, verification, security, scope);
  const route = routeOf(sorted);

  return {
    schemaVersion: 1,
    featureId: input.featureId,
    status,
    state: input.state,
    revision: input.revision,
    fingerprint: input.fingerprint,
    requirementIds: unique(criteria.map((criterion) => criterion.requirementId)),
    acceptanceCriterionIds: unique(criteria.map((criterion) => criterion.acceptanceCriterionId)),
    criteria: criteria.slice(0, MAX_FINAL_GATE_CRITERIA),
    criterionCount: criteria.length,
    criteriaTruncated: criteria.length > MAX_FINAL_GATE_CRITERIA,
    verification,
    verificationStages: stages,
    security,
    scope,
    approval: input.approval.status,
    fixer,
    blockers: sorted,
    route,
    evidence: evidenceReferences(input, stages),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Helpers                                                                                        */
/* -------------------------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * The blocker a stage's own recorded section earns, or null.
 *
 * Only the withholding direction exists here, and only for `failed`. See
 * {@link FinalGateCriterionClaim} for why the other two statuses are inert: a `passed` claim is not
 * evidence, and an `inconclusive` claim is the verdict the verifier role asks for whenever the
 * recorded evidence does not cover a criterion, so it is an ordinary outcome rather than a finding.
 */
function withholdsClaims(stage: FinalGateVerificationInput): FinalGateBlocker | null {
  const failed = stage.claims.filter((claim) => claim.status === "failed");

  if (failed.length === 0) {
    return null;
  }

  return {
    code: "criterion_reported_failed",
    route: stage.stage,
    message: `${stage.verification} recorded ${String(failed.length)} acceptance criterion result(s) as failed (${describeClaims(failed)}), while the deterministic evidence recorded for that stage passed. The two disagree and the gate has no way to say which is right, so it certifies neither. Re-run ${stage.stage}, or settle the disagreement in the spec.`,
  };
}

function describeClaims(claims: readonly FinalGateCriterionClaim[]): string {
  return claims
    .map((claim) => `${claim.requirementId}${claim.acceptanceCriterionId === null ? "" : ` / ${claim.acceptanceCriterionId}`}`)
    .join(", ");
}

/**
 * The final result per criterion.
 *
 * Every criterion takes the evidence-set verdict, because the framework's evidence records name
 * stages and checks rather than criteria, and inventing a mapping it cannot re-derive would be a
 * mapping a reader could not check. The one exception is a criterion a stage's section reported as
 * failed: that is the only per-criterion signal the recorded evidence contains, and it withholds the
 * criterion without contradicting the stage-level verdict.
 */
function criterionResults(
  criteria: readonly FinalGateCriterionInput[],
  stages: readonly FinalGateVerificationInput[],
  verification: FinalGateVerificationStatus,
): readonly FinalGateCriterionResult[] {
  const results: FinalGateCriterionResult[] = [];
  const seen = new Set<string>();

  for (const criterion of criteria) {
    const key = `${criterion.requirementId}\u0000${criterion.acceptanceCriterionId}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const reported = stages.find((stage) =>
      stage.claims.some(
        (claim) =>
          claim.requirementId === criterion.requirementId &&
          claim.acceptanceCriterionId === criterion.acceptanceCriterionId,
      ),
    );

    const reportedFailure =
      reported?.claims.find(
        (claim) =>
          claim.requirementId === criterion.requirementId &&
          claim.acceptanceCriterionId === criterion.acceptanceCriterionId &&
          claim.status === "failed",
      ) ?? null;

    results.push({
      requirementId: criterion.requirementId,
      acceptanceCriterionId: criterion.acceptanceCriterionId,
      status: reportedFailure === null ? verification : "failed",
      reportedBy: reported?.stage ?? null,
    });
  }

  return results.sort((left, right) => {
    const byRequirement = left.requirementId.localeCompare(right.requirementId);

    return byRequirement === 0
      ? left.acceptanceCriterionId.localeCompare(right.acceptanceCriterionId)
      : byRequirement;
  });
}

/**
 * What the fix history says about re-testing.
 *
 * `reverified` requires every stage a fix touched to hold evidence that postdates that fix. That is
 * the same fact the per-stage freshness checks report, and it is summarised here because it is the
 * first question a reader of a stuck feature asks: did anything re-run after the repair?
 */
function fixerStatus(
  input: FinalGateInput,
  stages: readonly FinalGateStageResult[],
): FinalGateFixerStatus {
  const latest = input.fix.latest;

  if (latest === null) {
    return "none";
  }

  if (latest.attempt >= latest.maxAttempts) {
    return "exhausted";
  }

  const repaired = input.verification.filter((stage) => stage.fix !== null);

  if (repaired.length === 0) {
    return "reverified";
  }

  const statuses = new Map(stages.map((stage) => [stage.stage, stage.status]));

  return repaired.every((stage) => statuses.get(stage.stage) === "passed")
    ? "reverified"
    : "unreverified";
}

/**
 * Whether a blocker is a known-wrong finding or an absence of proof.
 *
 * `failed` and `inconclusive` are kept apart because the two need different remedies and a caller
 * deserves to tell them: a failure routes to the stage that measured it, and an inconclusive holds
 * the feature for a human rather than sending it round a loop that has nothing to repair.
 */
const HARD_BLOCKERS: ReadonlySet<FinalGateBlockerCode> = new Set<FinalGateBlockerCode>([
  "approval_invalidated",
  "approval_missing",
  "fix_attempts_exhausted",
  "scope_not_measured",
  "scope_outside_approved_scope",
  "security_evidence_missing",
  "security_not_passed",
  "verification_evidence_missing",
  "verification_failed",
  "workflow_state_inconsistent",
  "working_tree_changed",
]);

function gateStatus(
  blockers: readonly FinalGateBlocker[],
  verification: FinalGateVerificationStatus,
  security: FinalGateSecurityStatus,
  scope: FinalGateScopeStatus,
): FinalGateStatus {
  if (blockers.some((blocker) => HARD_BLOCKERS.has(blocker.code))) {
    return "failed";
  }

  if (
    blockers.length > 0 ||
    verification !== "passed" ||
    security !== "pass" ||
    (scope !== "clean" && scope !== "not_applicable")
  ) {
    return "inconclusive";
  }

  return "passed";
}

/**
 * The earliest stage whose work would produce the evidence that is missing.
 *
 * Earliest in workflow order, because that is the only ordering that produces a repair rather than a
 * dead end: a feature whose static and runtime evidence are both stale has to re-run static first
 * whatever the blocker list happens to be sorted into. `escalate` sorts last, since no stage produces
 * a measurement nothing measured.
 */
function compareBlockers(left: FinalGateBlocker, right: FinalGateBlocker): number {
  const byRoute = routeRank(left.route) - routeRank(right.route);

  if (byRoute !== 0) {
    return byRoute;
  }

  const byCode = left.code.localeCompare(right.code);

  return byCode === 0 ? left.message.localeCompare(right.message) : byCode;
}

function routeRank(route: FinalGateRoute): number {
  return route === FINAL_GATE_ESCALATION ? WORK_STAGES.length : WORK_STAGES.indexOf(route);
}

function routeOf(blockers: readonly FinalGateBlocker[]): FinalGateRoute {
  const first = blockers[0];

  return first === undefined ? "final_gate" : first.route;
}

/**
 * One bounded line per surface the gate decided from.
 *
 * References rather than records: the bundles, the security record, the scope measurement, and the
 * approval are all already persisted, and a result that restates them would be a second copy to drift
 * out of step with the first.
 */
function evidenceReferences(
  input: FinalGateInput,
  stages: readonly FinalGateStageResult[],
): readonly FinalGateEvidenceReference[] {
  return [
    { kind: "approval", reference: "approval#plan", description: `Plan approval ${input.approval.status}.` },
    {
      kind: "specification",
      reference: "specification#requirements",
      description: `${String(input.criteria.length)} acceptance criterion/criteria read from the approved spec.`,
    },
    ...stages.map((stage) => ({
      kind: "verification" as const,
      reference: stage.reference,
      description: `${stage.verification}: ${stage.status}${stage.fingerprint === null ? "" : ` at ${stage.fingerprint}`}.`,
    })),
    {
      kind: "security",
      reference: "security-evidence#security_review",
      description: `Security review: ${describeSecurity(input.security)} at ${input.security.evidence?.workspaceFingerprint ?? "no fingerprint"}.`,
    },
    {
      kind: "scope",
      reference: `scope-evidence#${describeScope(input.scope)}`,
      description:
        input.scope.basis === "measured"
          ? `${String(input.scope.unauthorizedPaths.length)} unauthorized path(s) in the measured change set.`
          : input.scope.basis === "unmeasurable"
            ? "The change set could not be measured."
            : "No isolated workspace is configured, so the framework wrote no change set of its own to measure.",
    },
    {
      kind: "fixes",
      reference: "fix-history",
      description: `${String(input.fix.attempts)} recorded fix attempt(s).`,
    },
  ];
}

function describeSecurity(input: FinalGateSecurityInput): string {
  if (input.evidence === null) {
    return "no record";
  }

  return input.evidence.status;
}

function describeScope(input: FinalGateScopeInput): string {
  return input.basis === "measured" ? "final_gate" : input.basis;
}