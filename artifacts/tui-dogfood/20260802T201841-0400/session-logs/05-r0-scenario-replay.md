# R0 scenario-manifest replay

Date: 2026-08-03

External workload: public `pallets/click` commits already captured by the six workflows

Terminal: real PTY, 100 columns x 30 rows

Provider/network usage: none; provider credential environment variables explicitly unset

## Scope

R0 is comparison infrastructure, not a TUI behavior change. It freezes all six sanitized workflow
inputs, distinguishes four source-ledger prompts from two canonical replay prompts, and checks
contradictions between normalized controller facts and rendered claims. It does not run a prompt,
choose a policy verdict, score UX, or create a new screenshot framework.

## Clean replay

The built private eval package parsed the committed manifest, deduplicated its checkpoint names,
and compared one intentional nonzero-bash/visible-success contradiction. The real PTY reported:

```text
30 100
R0 REPLAY PASS · 6 workflows · 11 score axes · 19 safe checkpoints · bash-render-mismatch · provider calls 0
```

Every checkpoint is a lowercase basename-only PNG and resolves to an existing sanitized capture.
The manifest contains no credential-variable marker, Anthropic token prefix, or user-home path.

## Evidence boundary

- E2: manifest/schema/comparator tests and full eval regression run.
- E3: credential-unset manual replay in a real 100x30 PTY.
- E4: new capture **NOT_RUN** because R0 changes no runtime or visual product behavior; the replay
  validates the names and existence of the 19 relevant existing E4 checkpoints.
- E5: **NOT_RUN**; zero provider calls and zero token spend.

## Five-lens QC

- **Spec compliance:** implements R0's six-scenario manifest and truth comparator only; it does not
  advance or claim R5 behavior.
- **Security/adversarial:** private eval input is strict, malformed lifecycles and unsafe checkpoint
  names fail closed, committed text is scanned for credential/user-home markers, and no policy
  decision or action argument exists.
- **Reliability/edges:** canonical order, duplicate membership, score drift, nonzero/signal/unknown
  bash, pending/terminal review, mutation availability, verification states, interrupt states, and
  unpaired controller/render inputs are covered deterministically.
- **DX/usability:** every workflow carries an intended outcome, review posture, evidence source,
  cost ceiling, and explicit prompt provenance so a reviewer can reconstruct what is being replayed.
- **Simplicity/maintainability:** one private eval module, one manifest, and focused tests; no runner,
  dependency, runtime hook, shared schema, or screenshot framework was added.

No unresolved must-fix remained after the prompt-provenance honesty regression was resolved.
