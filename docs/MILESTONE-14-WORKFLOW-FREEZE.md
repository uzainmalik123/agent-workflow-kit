# Milestone 14: Workflow Validation and Framework Freeze

## Overview

Milestone 14 represents the validation and freeze of the Agent Workflow Kit framework. This milestone demonstrates that the workflow can successfully execute the complete end-to-end lifecycle while enforcing all approval boundaries, deterministic verification, and publishing guarantees.

## Frozen Workflow Lifecycle

The complete workflow follows this exact sequence with enforced boundaries:

1. **Request** → Initial feature request
2. **Grill** (griller) → Requirements gathering and analysis
3. **Spec Ready** → Specification prepared
4. **Planning** (planner) → Implementation plan creation
5. **Plan Review** (plan_reviewer) → Plan review and validation
6. **Awaiting Plan Approval** → **HUMAN GATE** - Plan approval required
7. **Implementing** (implementer) → Code implementation (only after plan approval)
8. **Code Review** (code_reviewer) → Code quality review
9. **Scope Review** (scope_reviewer) → Scope validation
10. **Static Verification** (verifier) → Static analysis and linting
11. **Test Verification** (verifier) → Test execution
12. **Runtime Verification** (verifier) → Runtime validation
13. **Security Review** (security_reviewer) → Security scanning
14. **Final Gate** (final_gate_reviewer) → Final gate validation with fresh evidence
15. **Final Summary** (summarizer) → Summary generation (only after Final Gate)
16. **Awaiting Push Approval** → **HUMAN GATE** - Push approval required
17. **Committing** → Feature branch creation and commit
18. **Pushing** → Push to remote
19. **Complete** → Workflow complete (only after successful push)

## Key Properties

### Approval Boundaries

- **Plan Approval**: Implementation cannot begin without explicit human approval (`approve_plan`). The workflow remains in `AwaitingPlanApproval` until approval is granted.
- **Push Approval**: Publishing cannot begin without explicit human approval (`approve_push`). The workflow remains in `AwaitingPushApproval` until approval is granted. Approval is bound to specific artifacts (summary, gate evidence, tree fingerprint, revision).

### Deterministic Verification

- **No Model-Only Success**: Verification stages require deterministic evidence from verification providers. Stages do not claim success solely based on agent opinion.
- **Fresh Evidence Required**: FinalGate requires fresh evidence. The framework tracks verification evidence across all three verification stages (static, test, runtime).
- **Evidence Binding**: All evidence is bound to revision, working-tree fingerprint, and workspace identity. Stale evidence is rejected.

### Fixer Loop (Failure Recovery)

When verification fails, the workflow transitions to `Fixing` state and returns to the original verification stage after the fix is applied:

1. Verification stage reports `needs_fix` with findings → transitions to `Fixing` (with `fixReturnState`)
2. Fixing stage executes → transitions back to the original verification stage
3. Verification re-runs with **fresh evidence** (not reusing stale evidence)
4. If fixed, continues forward; if still failing, can enter Fixing again (with attempt limits)

This ensures that stale evidence cannot bypass failures.

### Security Review

- Deterministic security scanning with provider-based evidence
- On security failure, transitions to `Fixing` and returns to `SecurityReview` with fresh security evidence
- Framework-defined security checks are merged with provider checks
- Protected paths and security patterns are enforced

### Publishing Guarantees

- Two-step publishing: commit (to feature branch) then push
- Publishing requires valid push approval bound to current tree state
- Tree changes after FinalSummary invalidate prior push approval
- Failed pushes do not reach `Complete` state
- One commit per feature branch
- Feature branch naming is deterministic and derived from approval data
- No false success is recorded on publishing failure

### Determinism & Integrity

Final evidence contains:
- Revision number
- Working-tree fingerprint  
- Verification evidence (static, test, runtime)
- Security evidence
- Scope evidence
- Final-gate result
- Approval bindings (plan and push)
- Commit SHA after successful publishing

## Framework Freeze

This milestone represents the **current framework freeze**. No new framework capabilities will be added. The following items are explicitly deferred for future consideration:

- SkillSpector integration
- Reticle integration
- Chisle/token optimization
- UI Skills integration
- Browser automation
- Additional coding agents
- Generalized multi-language verification
- Advanced vulnerability scanning
- Automatic PR/merge workflows
- Autonomous requirement changes

**Status:** Core workflow logic is validated by fixtures and fake executors; real end-to-end (real OpenCode, external project, through push) is NOT yet proven.
