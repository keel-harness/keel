# R19 installed composer and focus usability

Date: 2026-08-04

Tracking issue: #108

Exact main commit: `fa4a818a746a72e74a5156832b77c307984362d6`

External repository: `pallets/click` at `edda51f303625daa6084cd53490bbcf6c274bef5`

## Decision

R19 is a validation-only slice. The clean exact installed npm carrier passes ten selected real-PTY
scenarios across 80x24 and 100x30. The composer preserves drafts through provider waits, Warden
tool execution, terminal resize, active-panel focus, live approval focus, and diff focus. Multiline
paste, `Ctrl+J`, history draft/cursor restoration, reverse search, readline editing, bounded paste,
keyboard-only panel closure, and native terminal scrollback all remain usable.

No dropped input, focus ambiguity, stale overlay, or tool-after-interrupt product defect was
reproduced. Therefore R19 changes no product code, test, score, policy, security claim, dependency,
frozen contract, or public CLI behavior. Actual mouse text selection remains **NOT_RUN**; the
essential path is keyboard-complete and the terminal retains native history, but this evidence does
not claim mouse selection behavior.

## Exact carrier preparation

- Clean canonical `main` built all six packages and packaged the npm carrier plus all four Bun
  carriers.
- `build/npx/package.json` records exact commit
  `fa4a818a746a72e74a5156832b77c307984362d6` and `dirty: false`.
- The first `npm pack build/npx` invocation was **not green** because npm interpreted the operand as
  a Git URL. The corrected local-path invocation, `npm pack ./build/npx`, passed.
- The scripts-disabled tarball SHA-256 is
  `7b56aeb67614ec78c8c3ac9ded61c85cce255ac287a4162b67746ec71a1f33ff`.
- The first restricted install hung while DNS was unavailable and was interrupted with exit 130.
  The approved network-enabled retry installed 57 packages with
  `--ignore-scripts --no-audit --no-fund`; the exact launcher reported `keel 0.1.1`.
- The isolated run root was owner-only mode 0700. No provider credential was read, printed, logged,
  or captured.

## Selected installed-carrier matrix

The fixture was loopback-only. Every accepted session launched the exact installed carrier in the
clean external Click checkout, required a spawned production Warden and governed protection,
exercised a real PTY, and reaped its process group. Exit 1 is the expected controller result for the
two denied review sessions and two explicit interrupt sessions; it is not a teardown failure.

| Scenario | Geometry | Exit | Fixture requests | Transcript SHA-256 | Frame SHA-256 |
| --- | --- | ---: | ---: | --- | --- |
| multiline paste, Ctrl+J, history, reverse search, scrollback | 80x24 | 0 | 5 | `9a37dfc1a813f9889f255ad3a8891f3747192c1e2d7f9779fbc462108d5ecf48` | `94691799e698921c664a9ca595140b0a4930a177f66d3752897b096858f0738f` |
| multiline paste, Ctrl+J, history, reverse search, scrollback | 100x30 | 0 | 5 | `ef6c6c8b8cf4c731360aa3f077d274bfbd4dc008a49f9bff4e042b5a520129c3` | `8778454054cb34d1b150b7b94e07e97ef7c19eb0f231cd36c13c677ef909dc74` |
| provider/tool draft preservation and resize | 80x24 -> 100x30 | 0 | 2 | `f768e0b617de15919fd00ce3bb14c7e9aa3eedd32183e698a2d77d1b1d4989ee` | `26fbc683e68b12603f0539bd95ea9e41a2cd0e6e5adc5b1fd691fe43e30358d3` |
| provider/tool draft preservation and resize | 100x30 -> 80x24 | 0 | 2 | `b2710ac2076df6bc3644a2d12dfc8f204b4e4ac4711fcfdbf14cf0b916212dcd` | `f8273fe8496e1723c07e72ec8179da0d180c8b1d1cfff2f96ab4003174a84938` |
| active-panel exclusive focus, interrupt, restore | 80x24 | 1 | 1 | `8105bb1a717d4beb59ee2fb127c59b1bb1d6e4169a79a7c42bd0314882ca6188` | `50abb7719f3ed3d9abb244ded84fb7e2d9d6ee94db44cf183e9f7454a865744f` |
| active-panel exclusive focus, interrupt, restore | 100x30 | 1 | 1 | `88e955bd0b0b35dfc70a7f8f35784f4754eeec3bc097f550fcd6fbcf874cc125` | `e870edd0192f357fe581bd77009fc8dc1d58f7618252d2859971741cf3a0af22` |
| live approval exclusive focus, deny, restore | 80x24 | 1 | 2 | `6b4700531e01727c97f29f9342259d409efd0bf8f7fc5e1c216be760775d91b8` | `f2939430eb310700546fd6a64f2e3edf893eba5156f4616950563d3ba25f1a1a` |
| live approval exclusive focus, deny, restore | 100x30 | 1 | 2 | `23a04e365847ed128d9c93382fc00b128c488f2646185bc2d90323bc4b66c9e6` | `6e90679aedefd6aa45fe1a975a70e91b69db3e62c781e2c28ce0fec7957de81e` |
| diff exclusive focus and keyboard close | 80x24 | 0 | 3 | `c6eeda2f5316337eb5d66748f63f7e0a4fa0f9deefa4565e172fc0c1ab02809e` | `826eb07e6031fe2302bcce2f7b84e6a9396f7f8ed806199c1307321df8e525e6` |
| diff exclusive focus and keyboard close | 100x30 | 0 | 3 | `5ef5bdf7be4c3959072c1b8e4111db6203ade5a79d3be900a6bf221cb92bbec5` | `c037af3dfe4a51548c02781e47ef6fbc9d77b6d61fe3fbe46b230ae5ecb1f777` |

Selected outcome: **10/10 pass**, **26 loopback fixture requests**, zero surviving process groups,
and zero Anthropic requests.

The selected Warden audit set contains four allowed bash `tool.execute` records across the two
active/resize sessions, six allowed diff-path `tool.execute` records across the two diff sessions,
zero tool events across the interrupted panel sessions, and two `review.requested` plus two denied
`review.resolved` records across the live-review sessions. The reviewed commands targeted
`example.com`; both interrupts were necessary and narrowly scoped. Neither action executed.

## Rejected calibration attempts

Rejected attempts are retained outside the committed artifact set and excluded from the 10/10
result. They exposed harness/oracle errors rather than product defects:

1. Required transient `assistant drafting` text even when the valid controller advanced directly
   to tool or review state.
2. Sent the reverse-search query before search focus was installed, so text entered the composer.
3. Required a two-second `running bash` frame from a tool that validly completed sooner.
4. Used a blank-idle helper even though the test intentionally restored a nonempty draft.
5. Sent `Ctrl+A` and a command in one byte burst before the palette transition became active.
6. Required stale `run interrupted` wording instead of the actual
   `interrupted — the turn was stopped` state.
7. Treated legitimate denied/interrupted attention exit 1 as a cleanup failure.
8. Used `Ctrl+U` as final teardown after interruption even when the terminal did not repaint; the
   accepted driver explicitly returns home and then exits.

No assertion was weakened to accept missing governed posture, draft corruption, focus leakage,
unexpected tool execution, a missing denial, or a surviving process group.

## Automated verification

The unchanged focused input/focus regression set passed **11 files, 492/492 tests**:

`corepack pnpm exec vitest run packages/kernel/src/tui/input.test.ts packages/kernel/src/tui/input-history.test.ts packages/kernel/src/tui/input-activity.test.ts packages/kernel/src/tui/ink/input-bar.test.tsx packages/kernel/src/tui/ink/interactive.test.tsx packages/kernel/src/tui/ink/repl-interactive.test.tsx packages/kernel/src/tui/ink/app.test.tsx packages/kernel/src/tui/diff-viewer.test.ts packages/kernel/src/tui/ink/diff-viewer.test.tsx packages/kernel/src/tui/runner-steering.test.ts packages/kernel/src/cli/terminal-lifecycle.test.ts`

No behavior test was added because no defect was reproduced and no runtime behavior changed.

## Visual evidence

- `screenshots/50-r19-draft-resize.png` is a sanitized, visually inspected 1400x840 rendering of
  the active draft during governed tool execution and resize. SHA-256:
  `9233937b868de22931fa5c7b4a879a935d4a7795686d683b355c7aa5b674a0c4`.
- `screenshots/51-r19-review-focus.png` is a sanitized, visually inspected 1400x840 rendering of
  the genuine Warden approval surface and exclusive-focus assertions. SHA-256:
  `1decbd86209ff1a2b34279559c86319a19fe6eab8e15a55f779ab033bb99870b`.

Initial Quick Look renders were square and clipped and were rejected. A Swift/AppKit fallback was
also **not green** because the local compiler and SDK module cache were incompatible. The retained
images use the existing native Quick Look path with square-padded SVG input and a deterministic
1400x840 center crop. Both PNGs were inspected at original resolution. No username, private path,
credential, token, or environment value is visible.

## Evidence boundary

- E2: unchanged input/focus/terminal coverage passes **492/492**.
- E3: exact installed npm carrier, spawned production Warden, clean external Click, loopback
  provider, and ten real-PTY scenarios at 80x24/100x30 including live resize.
- E4: sanitized and visually inspected screenshots 50-51 plus exact transcript/frame hashes.
- E5: **NOT_RUN**. The validated input, focus, resize, interrupt, review, diff, and teardown behavior
  is controller/renderer-owned and the production provider boundary was exercised by a deterministic
  loopback fixture. Zero Anthropic calls; cumulative spend remains USD 2.74434625.
- Mouse selection: **NOT_RUN**. No claim is made beyond keyboard independence and retained native
  terminal history.

## Five-lens synthesis

- **Spec compliance — pass:** the installed carrier matches ADR-0034's queued-steering and draft-
  preservation behavior and ADR-0036's keyboard-complete native-terminal architecture.
- **Security/adversarial — pass:** every session required governed posture; approval keystrokes,
  paste, editor, history, and reverse-search probes stayed inert while review/panel/diff focus was
  exclusive; denied and interrupted actions did not execute.
- **Reliability/edge cases — pass:** two geometries, bidirectional live resize, multiline/grapheme
  draft retention, nonzero attention exits, explicit teardown, and rejected-oracle separation were
  exercised. All selected process groups were reaped.
- **DX/usability — pass:** draft text remains visible and exact during background work, the decision
  surface owns focus clearly, keyboard closure is dependable, and history/search restore the prior
  draft without losing its cursor.
- **Simplicity/maintainability — pass:** validation uses the repository PTY harness and existing
  product paths; no duplicate input stack, terminal abstraction, dependency, or product change was
  added.

No unresolved local R19 must-fix remains. The official six-workflow aggregate remains **4.01/5**
and the legacy pooled diagnostic remains **3.98/5** (247/62); R19 validates existing scores rather
than inflating them. Final same-commit six-workflow E2-E5 proof remains open.
