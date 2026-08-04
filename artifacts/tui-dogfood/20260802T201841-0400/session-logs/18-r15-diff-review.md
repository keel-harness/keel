# R15 availability-aware diff-review evidence

## Scope and authority boundary

R15 closes the process-local presentation gap in `/diff review`. The existing viewer already
provided bounded file, hunk, change, row, page, and fold navigation for available ADR-0078
comparisons. The missing state was a successful typed `edit` or `write` whose authoritative
mutation presentation had no review rows: the observation was omitted and the command reported
only `No settled diffs available to review.`

The retained slice consumes only existing process-local `ViewModel` facts. An explicit producer
settlement outranks contradictory activity diff bytes. Unavailable reasons come from the closed
producer reason vocabulary; paths come only from an available producer presentation. Request
arguments, activity summaries, output, and assistant prose cannot manufacture an unavailable path,
comparison, verification, or recovery fact.

No RPC, audit, session, event, mutation-presentation, `UIPort`, policy, grant, sandbox, egress,
provider, dependency, persistence, preimage, rollback, or automatic-recovery contract changes.
ADR-0078 remains process-local and one-shot. ADR-0079's fixed non-destructive recovery sentence is
shared by the completion receipt and focused diff surface.

## Red-first and local verification

- The first selected run passed **46 / 55** and failed the expected **9** new behavior tests.
- The final focused selection passes **57 / 57**. It includes all-unavailable, mixed, summary-only,
  pending/missing presentation, authoritative-settlement precedence, forged request/prose, latest-
  turn binding, earlier selection, caps, hostile text, NO_COLOR/dumb terminal, 40x18/80x24/100x30,
  focus, Esc, approval/active-turn priority, and duplicate provider-ID cases.
- Adjacent coverage passes **382 / 382** across twelve TUI files.
- A full TUI run forced into thread workers was **not green** at **1,367 / 1,368** because the real
  Warden fixture calls `process.chdir`, which Node workers forbid. The same failure reproduced on
  clean exact `main`; no product byte or test was changed to hide it. The repository-compatible
  fork-pool run passes **1,368 / 1,368** across 48 files.
- The first full coverage run executed **6,557 / 20 existing opt-in skips** with no test failure but
  failed attribution thresholds: worktree `node_modules` symlinks resolved cross-package imports to
  canonical `main`. After an exact frozen worktree-local install with `--ignore-scripts`, the
  unrestricted coverage rerun passes **6,557 / 20** at **97.98% statements/lines, 93.70% branches,
  and 99.58% functions**, with every package/per-file threshold green. The lockfile is unchanged.
- Full typecheck, lint, format, build, all four package carriers, and `git diff --check` pass.

The later installed-carrier preparation first failed before packing because npm selected a
pre-existing root-owned global cache. No global ownership or configuration was changed; an isolated
task cache packed both carriers. A restricted install then stalled on unavailable registry access,
was interrupted, and left the install root empty. The approved networked install populated the
baseline; the candidate reused the isolated cache. Both exact local tarballs install with scripts
disabled and report `keel-harness@0.1.1`.

## E3 installed-carrier comparison

The exact baseline carrier is built from clean `main` `9755816d5a8b9f4b9a797ef880430df1b06e134b`.
The candidate carrier is built from the R15 worktree after all local gates. Tarball SHA-256:

- baseline: `e87205ccaba47726b2dcbfccbccd9232a22f6859965b63c8b20cc9256783d29b`;
- candidate: `c71a66c4314584483197544ccb1470939ddabccc9ae54b85d16169cd6fdf9140`.

At both 80x24 and 100x30, each successful evidence run:

- launches the installed npm carrier in a real PTY with a spawned production Warden;
- uses a loopback-only OpenAI-compatible fixture and makes exactly two fixture requests;
- performs one legitimate typed `write` over a four-byte binary preimage;
- installs the expected text bytes with SHA-256
  `4163d961c8f9078fa8b43d7c505a63ad52e0a445220ad36bfc1e43028c881c8f`;
- records exactly one tool result and a clean `model-stop` terminal status;
- opens `/diff review`, exits cleanly, and makes zero paid-provider requests.

Baseline displays only `No settled diffs available to review.` Candidate opens a focused view that
names producer-safe `artifact.bin`, states `comparison summary only · line content unavailable`,
states `verification not run`, supplies ADR-0079 recovery guidance, and advertises `esc close`.
Esc returns focus to the dormant composer at both widths.

Successful exact-frame SHA-256:

| Variant | Geometry | Frame | Transcript |
| --- | --- | --- | --- |
| baseline | 80x24 | `9bcf14a45d27a7c2d1b710f4a8a7e11f1a5f4694d79d03b6705750eadbb60079` | `ccc766baa0eebdb2dd75a5a714826a8b3eaaf39a18389e43dc1920f898907f62` |
| baseline | 100x30 | `6b793be3d3c867345fe2525144588d8459b7784747c6a85fd821cc38e720f4ff` | `99280ee8dd2ed46c605631aed5383fabc6a2affe445f525cacc569958e7fd53a` |
| candidate | 80x24 | `802336d63c89c28907c08f1ff2a7cdf894d51a7a44813bdabd80ea06ac1a42c2` | `413a112a152a3cc59295375fa520c1c587e9b64460e1706815641afb9272776f` |
| candidate | 100x30 | `5396b71892ce26e300f9a781ff4bfe32b45e0ffb8b409f5c79807f66ba92d9b1` | `feecf61f3c9ba6c41727a6500ab3a95899a16443dee5ba4c24db041361b460ae` |

Two initial candidate oracles were invalid because they searched raw substrings across Ink-wrapped
rows and did not account for the visible rail prefix. The product frame already contained the full
expected view. The corrected oracle waits on stable semantic anchors, removes only line-prefix
rails for phrase comparison, and preserves exact raw-frame hashes. Across successful and invalid
oracle attempts, eighteen local fixture requests were made and zero Anthropic requests.

## E4 and safety

Screenshots `41-r15-diff-review-before.png` and `42-r15-diff-review-after.png` are sanitized
1400x840 exact-text transcriptions of the 100x30 frames. They were visually inspected after
rasterization. SHA-256:

- before: `941d259467d387cf4d64755877e6057c0264f6d059a12078541819de953ab2db`;
- after: `2814b23ea8fb720fbb62c01f47bbb14c60a9e34ee0ce4fca5ff647548026308f`.

Automated scans found no provider credential, credential-shaped token, username, private home
path, or private temporary path in the retained frames, transcripts, results, or screenshots. E5 is
**NOT_RUN** because this is deterministic controller presentation and the installed product/provider
boundary is exercised by the local fixture. Cumulative Anthropic spend remains USD 2.74434625;
USD 17.25565375 remains and the final USD 2 reserve is intact.

## Five-lens QC

- **Spec/ADR:** uses only ADR-0078 process-local producer facts; preserves `not-atomic` and
  concurrent-mutation caveats; shares ADR-0079 fixed recovery; adds no durable or frozen carrier.
- **Security/adversarial:** explicit non-available producer settlement defeats contradictory stale
  diff bytes; request paths/output/prose cannot become evidence; text is control-stripped and
  bounded; the surface has no execution or approval authority.
- **Reliability/edges:** exact caps remain 32 files and 24 review rows; unavailable observations are
  separately capped at three with hidden counts. Narrow/wide, NO_COLOR/dumb, hostile text, duplicate
  IDs, focus priority, Esc, mixed/all-unavailable, and latest/earlier-turn cases pass.
- **DX/usability:** the exact installed comparison replaces a generic dead end with the affected
  file, limitation, verification truth, safe next action, and obvious close control in one focused
  view at both required terminal sizes.
- **Simplicity/maintainability:** reuses `/diff review`, the existing pure planner/reducer/private
  Ink sidecar, existing producer vocabulary, and one shared recovery constant. No panel suite,
  dependency, persistence system, or parallel evidence model is introduced.

The adversarial pass found and repaired one must-fix before final green: an explicit unavailable
producer settlement originally lost to contradictory activity diff bytes and could expose a request-
derived path. A retained red regression now proves producer settlement wins. No unresolved local
must-fix remains. Publication, exact reviewed-head CI, merge-tree comparison, post-main CI, issue
closure, and branch/worktree cleanup remain pending.
