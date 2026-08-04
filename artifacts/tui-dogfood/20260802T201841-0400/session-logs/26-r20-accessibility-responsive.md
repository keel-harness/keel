# R20 accessibility and responsive terminal matrix

Date: 2026-08-04
External repository: `pallets/click`, frozen worktree `edda51f303625daa6084cd53490bbcf6c274bef5e`
Baseline Keel: `30e68a0a7af699d2bd0376d02a42b965eb135ca0`
Candidate Keel: `1a46d01bb0e253ac5c05c3e7d3fd0182c1eeba39`
Public scope: [issue #123](https://github.com/keel-harness/keel/issues/123)

## Direct observation

The exact installed baseline npm carrier used a production-length model label and workspace name.
At 80x24, opening the complete command palette rendered 25 physical rows: the 83-cell identity
line wrapped `trusted` onto its own row, pushing the composer below the terminal budget. The
existing real-Ink row-budget test used a short synthetic model, so it remained green while the
installed product overflowed.

The baseline tarball SHA-256 is
`3fe92ca70d3fb4df9cee2e8ca00e5ccf8890987c8dd31a969d33d8a333bbfc69`; its rejected palette frame
SHA-256 is `73219208e14e3913b7ec7c6698c8fb8dea57342cef42465c4e3f6a6668c44b6b`.

## TDD and implementation

Red-first coverage added production-length identity data to both the pure row builder and the real
Ink 80x24 palette, plus Unicode/control-byte and no-known-width cases. The first red run reported
**3 failed / 233 passed**: 83 and 95 terminal cells at an 80-cell boundary, and 25 physical palette
rows.

The retained implementation changes only `compactMetaLine`: when a known width above the existing
narrow breakpoint cannot contain the full metadata row, it uses the already-established fact
priority and grapheme-safe truncation. Unknown-width output remains byte-compatible. The first green
implementation exposed a 60-column equivalence regression in the broad suite; the condition was
narrowed so the existing <=60 priority remains unchanged. The final implementation is three changed
lines and adds no dependency, component, state, or new layout system.

## Verification

- Red-first pair: **3 failed / 233 passed**, intended geometry failures only.
- Focused pair after repair: **236/236**.
- Theme, diff, row-budget, real-Ink budget, input, terminal-control, and diff-control surface:
  **7 files / 137 tests**.
- Pure/Ink/equivalence compatibility surface after the 60-column correction: **3 files / 247
  tests**.
- `pnpm lint`, `pnpm typecheck`, and `pnpm format`: pass.
- Complete host suite with bounded parallelism: **365 files / 6,668 tests / 20 intentional opt-in
  skips**, pass.
- Complete coverage gate with the same four-worker bound: **365 files / 6,668 tests / 20 skips**,
  97.87% statements/lines, 93.63% branches, and 99.59% functions, pass.
- `pnpm package`: pass. Exact candidate metadata reports commit `1a46d01`, `dirty: false`.
- Candidate tarball SHA-256:
  `63e50181dc46422203e4034ff6ab1bc8de7e4237a5342511f381c6062bc05306`; fresh install contains 57
  packages and disables lifecycle scripts.

Two default-high-parallelism whole-suite attempts were explicitly non-green under host load. The
first also ran inside the managed sandbox, so six loopback listener tests correctly received
`EPERM`; its three other failures passed in isolation. The unrestricted retry left two timing-only
failures: one Warden hello exceeded 6 seconds and one proxy fail-closed probe took 14.01 seconds
against a 12-second ceiling. Their exact isolated reruns passed in 0.729 seconds and 6.143 seconds.
The complete four-worker test and coverage runs then passed without changing or skipping any test.

## Exact installed terminal matrix

The candidate passed nine zero-provider governed PTY cases: extended color at 80x24 and 120x40,
120x40 resized live to 80x24, basic color at 80x24, `NO_COLOR` at 100x30, `TERM=dumb` at 80x24,
Kitty/Apple Terminal/tmux environment profiles at 100x30, and `vt100` at 80x24. Every case preserved
the palette, protection truth, keyboard guidance, and composer, exited zero, reaped its process
group, and retained no credential or private path. Monochrome cases emitted zero SGR sequences;
color cases emitted SGR sequences. The accepted matrix SHA-256 is
`4074021c49425db9ec6c8bd49d1c9587e80165fc685ec8530bde89e972aab6bf`.

The repaired exact 80x24 palette is **24 physical rows**, widest row 77 cells, with identity
`openai-compatible/r20-no-provider · workspace trusted`. Its frame SHA-256 is
`a0b0c5fb227a40103cbfb89ccd6ba6a659011c7499a58d4db37cc3881ef56a39`.

Native-host checks also passed:

- Kitty 0.47.4: actual 100x30 grid, keyboard-opened palette, native selection highlight, governed
  footer, composer, graceful `/exit`, and no surviving Keel/Warden process.
- Apple Terminal 2.15: actual 100x30 launch, live resize to 80x24, bounded identity, governed footer,
  composer, graceful `/exit`, and no surviving Keel/Warden process.
- Linux terminal emulator: **NOT_RUN**. The Docker CLI is installed but its daemon/socket is absent;
  no Linux VM was available. Linux renderer and PTY behavior remains covered by tests/CI, not
  misreported as a native emulator observation.

## Evidence and screenshots

Screenshots 65-67 are sanitized exact-frame transcriptions; screenshots 68-69 are window-scoped
native Kitty and Apple Terminal captures. All five were visually inspected. Screenshot 67 uses
monochrome content styling to match its source frame's zero-SGR result. The first Apple Terminal
capture was rejected and deleted because its title bar included an account name and launcher path;
the retained capture disables those title components and shows only `Keel R20 validation`.

- `65-r20-palette-before-80x24.png`:
  `08b7725fddadc4182e1f83ec06740d6914041f972019dbb75b7260c8597153c8`
- `66-r20-palette-after-80x24.png`:
  `beacb790a19853624b0f73654e97d43ec7ea73b80379d84cad2d07b64026fb12`
- `67-r20-no-color-palette-100x30.png`:
  `a1a732aa41ffaa9139bcc5510ee806c656d2dcfcc4a0fffe45664a8b66134daa`
- `68-r20-kitty-live-100x30.png`:
  `ff60fce200cb807d9f42dec1de05a6b0dc25da5dcab2a151b48b8a171814a29f`
- `69-r20-terminalapp-live-80x24.png`:
  `e33292ccd8e0ecb638b67e8c4d76a73ef3046581ad11b8554086b8140dcb6a77`

## Rejected setup and oracle attempts

- The first matrix launch inside the managed outer sandbox was rejected because Keel truthfully
  reported sandbox and egress protection off. The governed rerun used the established observer
  boundary.
- A temporary palette oracle expected `input` while the focused palette correctly says `commands`;
  it was narrowed to the surface-specific keyboard label.
- The baseline's 25-row frame was retained as a product defect; no row threshold was relaxed.
- The wide protection oracle initially omitted the valid `policy Guided` spelling and was corrected
  without changing product assertions.
- The `screen-256color` incremental observer ended on a partial control sequence even though its
  completed retained frame contained every ordered predicate. The temporary matrix accepted only
  that final sanitizer frame after independently rechecking the identical predicates; geometry,
  safety, color, exit, and reaping assertions remained intact.
- The first `NO_COLOR` image transcription added semantic colors and was rejected/overwritten.
- The first Apple Terminal screenshot exposed title-bar metadata and was deleted before retention.

## Five-lens QC

- Spec compliance: presentation-only responsive geometry under issue #123; no public CLI or frozen
  protocol/schema behavior changes.
- Security/adversarial: control stripping and grapheme-cell accounting remain in the same path;
  hostile control/Unicode tests pass; Warden authority and protection truth remain unchanged.
- Reliability/edges: 40/60/80/100/120-column coverage, live resize, Unicode, `NO_COLOR`, dumb/basic/
  extended terminal profiles, native Kitty/Terminal, full tests, and coverage pass.
- DX/usability: the complete 80x24 palette, protection line, keyboard hint, and composer are visible;
  model identity and workspace trust outrank the less useful workspace basename when space is tight.
- Simplicity/maintainability: reuses the existing candidate order and truncator in one function; no
  abstraction, dependency, or unrelated cleanup.

There are no local must-fix findings. E1-E4 are green. E5 is **NOT_RUN** because this geometry and
terminal-capability slice is fully controller/renderer-owned and intentionally makes zero provider
requests. R20 adds **0 Warden interrupts** and **USD 0.00 Anthropic spend**. The candidate six-
workflow score remains **4.04/5** pending the final same-commit replay; this cross-cutting matrix
adds confidence but does not manufacture another score increase.

## Publication closeout

Exact reviewed head `2401a65ea0aa46c5b231e6ab5216f4ba32d0abb8` passed PR CI run
`30936094264`. PR #124 merged as `67e317d03067579bf4ea4a3b0a3a0caaf365d26d`; both commits have
tree `2474522380d539320485b8971b62f7e2d8549437`. Exact post-main run `30936677719` passed required
aggregate `92086267416`, Linux/macOS build and coverage, Linux/macOS package and real-sandbox lanes,
audit, security, both native cross-architecture carrier smokes, Node-next, egress-scale, and the
Node 20/22/24 installed-product matrix. Issue #123 is closed.
