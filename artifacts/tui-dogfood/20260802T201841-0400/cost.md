# Anthropic cost accounting

Budget: USD 20.00 hard stop. Final-regression reserve: USD 2.00. Exploration ceiling:
USD 18.00.

Pinned model: `claude-sonnet-4-6`, standard global API pricing checked 2026-08-02:

- base input: USD 3.00 / MTok;
- output: USD 15.00 / MTok;
- five-minute cache write: USD 3.75 / MTok;
- cache hit/refresh: USD 0.30 / MTok.

Formula: fresh input × 3 + cache writes × 3.75 + cache hits × 0.30 + output × 15,
all divided by 1,000,000. If a usage component is unavailable, count it at the higher
applicable input rate.

| Workflow | Fresh input | Cache write | Cache hit | Output | Estimated USD | Cumulative USD | Remaining USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Orientation | 0 | 0 | 0 | 0 | 0.0000 | 0.0000 | 20.0000 |
| Onboarding call 1 | 57,753 | 19,732 | 116,187 | 4,096 | 0.3436 | 0.3436 | 19.6564 |
| Onboarding follow-up | 3 | 1,655 | 19,044 | 1,020 | 0.0272 | 0.3708 | 19.6292 |
| Feature initial/review | 10 | 23,814 | 109,593 | 1,903 | 0.1508 | 0.5215 | 19.4785 |
| Feature implementation | 14 | 6,622 | 316,662 | 2,927 | 0.1638 | 0.6853 | 19.3147 |
| Feature Git-review stop | 3 | 374 | 29,561 | 53 | 0.0111 | 0.6964 | 19.3036 |
| Feature completion | 11 | 32,889 | 186,768 | 1,463 | 0.2013 | 0.8977 | 19.1023 |
| Interrupt uv probe | 3 | 1,011 | 32,750 | 55 | 0.0145 | 0.9122 | 19.0878 |
| Audit-lock retry | 3 | 29,829 | 2,609 | 67 | 0.1137 | 1.0258 | 18.9742 |
| Source-resolution retry | 4 | 383 | 65,138 | 461 | 0.0279 | 1.0537 | 18.9463 |
| Final feature tests | 5 | 1,055 | 99,705 | 330 | 0.0388 | 1.0926 | 18.9074 |
| Debug diagnosis | 11,974 | 12,104 | 289,266 | 1,676 | 0.1932 | 1.2858 | 18.7142 |
| Debug red/fix | 9 | 4,786 | 311,533 | 1,435 | 0.1330 | 1.4188 | 18.5812 |
| Debug changelog/full test | 7 | 2,849 | 241,654 | 951 | 0.0975 | 1.5162 | 18.4838 |
| Changelog recovery confirmation | 4 | 641 | 99,285 | 178 | 0.0349 | 1.5511 | 18.4489 |
| Debug adversarial revision | 8 | 2,434 | 305,449 | 1,340 | 0.1209 | 1.6720 | 18.3280 |
| Final debugging tests | 5 | 1,030 | 158,888 | 278 | 0.0557 | 1.7277 | 18.2723 |
| Refactor initial + boundary steer | 93,484 | 42,736 | 91,178 | 2,032 | 0.4985 | 2.2262 | 17.7738 |
| Refactor reviewed composite | 4 | 965 | 85,758 | 1,020 | 0.0447 | 2.2709 | 17.7291 |
| Refactor selector correction | 4 | 654 | 87,978 | 271 | 0.0329 | 2.3038 | 17.6962 |
| Refactor explicit interrupt | 38,896 | 1,420 | 134,276 | 1,602 | 0.1863 | 2.4902 | 17.5098 |
| Refactor implementation/tests | 10 | 4,565 | 297,763 | 1,205 | 0.1246 | 2.6147 | 17.3853 |
| Compacted final summary | 3 | 373 | 4,972 | 674 | 0.0130 | 2.6277 | 17.3723 |
| Refactor test consolidation | 13 | 5,390 | 91,016 | 2,372 | 0.0831 | 2.7109 | 17.2891 |
| R1 offline product replay | 0 | 0 | 0 | 0 | 0.0000 | 2.7109 | 17.2891 |
| R2 offline product replay | 0 | 0 | 0 | 0 | 0.0000 | 2.7109 | 17.2891 |
| R3 offline product replay | 0 | 0 | 0 | 0 | 0.0000 | 2.7109 | 17.2891 |
| R4 offline product replay | 0 | 0 | 0 | 0 | 0.0000 | 2.7109 | 17.2891 |
| R0 manifest/comparator replay | 0 | 0 | 0 | 0 | 0.0000 | 2.7109 | 17.2891 |
| R5a denial-guidance replay | 0 | 0 | 0 | 0 | 0.0000 | 2.7109 | 17.2891 |
| R5b containment replay | 0 | 0 | 0 | 0 | 0.0000 | 2.7109 | 17.2891 |
| R6 concurrent-resume preflight | 0 | 0 | 0 | 0 | 0.0000 | 2.7109 | 17.2891 |
| R7 local-provider runway replay | 0 | 0 | 0 | 0 | 0.0000 | 2.7109 | 17.2891 |
| R7 Anthropic credential rejections (2) | 0 | 0 | 0 | 0 | 0.0000 | 2.7109 | 17.2891 |
| R7 Anthropic live stop | 3 | 3,343 | 0 | 89 | 0.0139 | 2.7248 | 17.2752 |
| R7 Anthropic live continuation | 3 | 489 | 3,343 | 6 | 0.0029 | 2.7277 | 17.2723 |
| R8 Anthropic active-task replay | 4 | 3,735 | 3,260 | 110 | 0.0166 | 2.7443 | 17.2557 |
| R9 local resume-history replay | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R10 local urgent-steering replays | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R11 local bounded-recovery replays | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R11 post-main PTY observer repair | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R14 local interrupted-mutation replays | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R12 local evidence-density replays | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R13 local credential-recovery replays | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R15 local diff-review replays | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R16 local session-grant replays | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R17 local latency measurements | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R18 local exact-outcome replays | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R19 local input/focus replays | 0 | 0 | 0 | 0 | 0.0000 | 2.7443 | 17.2557 |
| R21 exact-main live onboarding | 41,766 | 15,439 | 42,012 | 3,455 | 0.2476 | 2.9920 | 17.0080 |
| R21 prompt candidate 1 | 37,906 | 15,042 | 44,710 | 3,083 | 0.2298 | 3.2218 | 16.7782 |
| R21 prompt candidate 2 | 35,610 | 12,939 | 55,421 | 2,687 | 0.2123 | 3.4340 | 16.5660 |
| R22 local operator-diagnostic matrix | 0 | 0 | 0 | 0 | 0.0000 | 3.4340 | 16.5660 |
| #113 exact-carrier live onboarding | 214,531 | 112,387 | 450,457 | 6,058 | 1.2911 | 4.7251 | 15.2749 |
| R20 accessibility/responsive matrix | 0 | 0 | 0 | 0 | 0.0000 | 4.7251 | 15.2749 |
| Final replay exact-main onboarding | 145,772 | 83,572 | 131,800 | 4,441 | 0.8569 | 5.5820 | 14.4180 |
| #133 live candidate 1 (rejected) | 222,838 | 85,442 | 63,153 | 4,287 | 1.0722 | 6.6541 | 13.3459 |
| #133 live candidate 2 (rejected) | 60,938 | 42,267 | 224,613 | 5,993 | 0.4986 | 7.1527 | 12.8473 |
| #133 live candidate 3 (accepted locally) | 80,129 | 106,534 | 92,106 | 3,526 | 0.7204 | 7.8731 | 12.1269 |
| Exact merged onboarding (semantic reject) | 66,446 | 39,521 | 57,381 | 4,208 | 0.4279 | 8.3010 | 11.6990 |
| #136 ordinary prompt 1 (rejected) | 69,211 | 43,473 | 80,980 | 4,293 | 0.4593 | 8.7604 | 11.2396 |
| #136 ordinary prompt 2 (rejected) | 62,943 | 45,126 | 88,977 | 4,206 | 0.4478 | 9.2082 | 10.7918 |
| #136 ordinary prompt 3 (rejected) | 102,371 | 57,151 | 128,311 | 3,907 | 0.6185 | 9.8267 | 10.1733 |
| #136 rewrite boundary live 1 (accepted) | 46,995 | 29,356 | 55,437 | 4,609 | 0.3368 | 10.1636 | 9.8364 |
| #136 rewrite boundary live 2 (accepted) | 165,754 | 67,193 | 53,073 | 3,829 | 0.8226 | 10.9861 | 9.0139 |

Anthropic provider calls: 225 successful, 4 rejected at zero reported usage. R7's two local-fixture
requests are not Anthropic calls and carry no Anthropic cost. The USD 2.00 final-regression
reserve remains intact. The R1 through R6 and R0 replays were deterministic and offline; they made
no Anthropic request. R3's displayed 175 and R4's displayed 136 replay tokens are synthetic
recording usage, not provider usage or spend. R5b's displayed 59 tokens are likewise synthetic.
R7's displayed 48k and 5.6k are controlled local-fixture usage, not Anthropic usage. Its live E5
stop reported 3,346 input tokens (3 fresh / 3,343 cache write) and 89 output tokens; the continuation
reported 3,835 input (3 fresh / 489 cache write / 3,343 cache hit) and 6 output. The exact unrounded
increment was USD 0.0168159. Both earlier R7 credential rejections reported zero usage, and the
credential value was never read or exposed.
R8's four local-fixture requests carry no Anthropic cost. Its one live run made two Anthropic calls;
the aggregate `run_status` reported 6,999 input tokens (4 fresh / 3,735 cache write / 3,260 cache
hit) and 110 output tokens. The unrounded increment was USD 0.01664625. Cumulative spend is USD
2.74434625; the credential value was not inspected, printed, logged, or captured.
R9's six local-fixture requests carry no Anthropic cost. The provider-independent behavior was
validated before and after at 80x24 and 100x30; E5 is intentionally **NOT_RUN**. Cumulative spend
remains USD 2.74434625 and the final USD 2.00 reserve remains intact.
R10's six local-fixture requests across normal 80x24/100x30 and budget/resume paths carry no
Anthropic cost. E5 is intentionally **NOT_RUN** because urgent state and terminal deferral are
controller-owned and the production provider boundary was exercised deterministically. Cumulative
spend remains USD 2.74434625 and the final USD 2.00 reserve remains intact.
R11's eight local-fixture requests cover baseline and candidate runs at 80x24 and 100x30: one
baseline request and three candidate requests at each size. They carry no Anthropic cost. E5 is
intentionally **NOT_RUN** because eligibility, call bounding, Warden dispatch, finalization, and
presentation are controller-owned and the production provider boundary was exercised
deterministically. Cumulative spend remains USD 2.74434625; USD 17.25565375 remains and the final
USD 2.00 reserve is intact.
The R11 post-main PTY diagnosis and issue #84 repair used only the already built local npm carrier,
secret-free local Warden processes, and deterministic byte fixtures. It made zero provider calls,
so cumulative spend and the final reserve are unchanged.
R14 used twenty loopback-only fixture requests: twelve across the installed carrier's three urgent
controls and four at each fixed 80x24/100x30 replay. No Anthropic endpoint or credential was used;
cumulative spend remains USD 2.74434625, USD 17.25565375 remains, and the USD 2 reserve is intact.
R12 used twenty-six loopback-only fixture requests: thirteen at each fixed 80x24/100x30 installed-
carrier replay. No Anthropic endpoint or credential was used; cumulative spend remains USD
2.74434625, USD 17.25565375 remains, and the USD 2 reserve is intact.
R13 exercised the local `keel auth set` controller through four exact installed-carrier PTYs: a
baseline and candidate at each of 80x24 and 100x30. It made no model or Anthropic request. A
non-secret fixture value was absent from every transcript and screenshot; no provider credential
was inspected. Cumulative spend remains USD 2.74434625, USD 17.25565375 remains, and the USD 2
reserve is intact.
R15 used eighteen loopback-only fixture requests across four successful installed-carrier evidence
runs and invalid wrap-sensitive oracle attempts. Each request stayed on 127.0.0.1 and no Anthropic
endpoint or credential was used. The four accepted 80x24/100x30 baseline/candidate runs account for
eight of those requests. E5 is intentionally **NOT_RUN** because the changed behavior is
deterministic controller presentation. Cumulative spend remains USD 2.74434625, USD 17.25565375
remains, and the USD 2 reserve is intact.
R16 used fourteen loopback-only fixture requests across four accepted exact installed-carrier runs.
The baseline and one invalid geometry-oracle attempt were also local and reported no Anthropic
usage. No Anthropic endpoint or credential was used. E5 is intentionally **NOT_RUN** because the
changed behavior is deterministic controller-to-Ink presentation. Cumulative spend remains USD
2.74434625, USD 17.25565375 remains, and the final USD 2 reserve is intact.
R17 used twenty governed launch/input samples and five accepted full phase samples against the
exact installed npm carrier. The phase fixture made ten loopback requests with controlled delays;
rejected calibration attempts were also local. No Anthropic endpoint or credential was used. E5 is
**NOT_RUN** because startup, input, fixture delay, Warden presentation, and tool liveness are
deterministic controller/renderer measurements. Cumulative spend remains USD 2.74434625, USD
17.25565375 remains, and the final USD 2 reserve is intact.
R18 used four accepted exact installed-carrier runs and loopback-only fixture traffic for the
80x24/100x30 baseline/candidate comparison. No Anthropic endpoint or credential was used. E5 is
**NOT_RUN** because the change is deterministic controller presentation and the production provider
boundary was exercised locally. Cumulative spend remains USD 2.74434625, USD 17.25565375 remains,
and the final USD 2 reserve is intact.
R19 used twenty-six loopback-only fixture requests across ten selected exact installed-carrier PTY
sessions. Rejected calibration attempts were also local. No Anthropic endpoint or credential was
used or inspected. E5 and actual mouse selection are **NOT_RUN**. Cumulative spend remains USD
2.74434625, USD 17.25565375 remains, and the final USD 2 reserve is intact.
R21's exact-main live run reported 99,217 input tokens: 41,766 fresh, 15,439 cache write, 42,012
cache read, and 3,455 output, costing USD 0.24762285. Prompt candidate 1 reported 37,906 fresh,
15,042 cache write, 44,710 cache read, and 3,083 output, costing USD 0.22978350. Prompt candidate 2
reported 35,610 fresh, 12,939 cache write, 55,421 cache read, and 2,687 output, costing USD
0.21228255. The three completed sessions made 19, 19, and 20 provider turns respectively (58
successful calls); the two candidates were rejected on user-outcome quality, not transport failure.
R21's live increment is exactly USD 0.68968890. Deterministic
positive/negative/resume fixtures made no Anthropic request. Cumulative spend is USD 3.43403515,
USD 16.56596485 remains, and the final USD 2 reserve is intact. The task-scoped credential copy was
never read, printed, logged, committed, or captured.
R22 used only missing-credential preflight, local doctor, installed-carrier startup, loopback
provider fixtures, and a spawned local Warden. The seven-path matrix, two-geometries replay,
candidate comparison, build/package validation, screenshots, and publication made zero Anthropic
calls. Cumulative spend remains USD 3.43403515, USD 16.56596485 remains, and the final USD 2 reserve
is intact. The ambient provider credential was never read, copied into a child, printed, logged,
committed, or captured.
Issue #113 used deterministic replay, loopback fixtures, and local Warden controls before one exact-
carrier `anthropic/claude-sonnet-4-6` onboarding run. The live session made 18 provider requests and
reported 777,375 total input tokens: 214,531 fresh, 112,387 cache write, and 450,457 cache read,
plus 6,058 output. The exact increment is USD 1.29105135. Cumulative spend is **USD 4.72508650**;
USD 15.27491350 remains and the final USD 2 reserve is intact. The credential value was never read,
copied, printed, logged, committed, or captured. All rejected fixture/oracle/install attempts were
local and add no Anthropic usage.
The R0 manifest caps a future six-workflow replay at
USD 12.00, below the currently spendable USD 13.27491350 after preserving the final USD 2.00
reserve.

R20 used only deterministic renderer tests, local Warden processes, the exact installed npm carrier,
and native local terminal emulators. Its nine-case matrix and native Kitty/Apple Terminal checks
submitted no task to a provider and made zero Anthropic calls. Cumulative spend remains **USD
4.72508650**; USD 15.27491350 remains and the final USD 2 reserve is intact. No ambient credential
value was read, copied, printed, logged, committed, or captured.

R23 used only local builds, a scripts-disabled exact npm carrier, deterministic loopback provider
fixtures, the production local Warden, PTYs, and host process observations. Accepted and rejected
calibrations made **zero Anthropic requests**. Incremental input/output tokens and cost are all zero.
Cumulative spend remains **USD 4.72508650**; USD 15.27491350 remains and the final USD 2 reserve is
intact. No credential value was read, copied, printed, logged, committed, or captured.

Issue #127 used only local tests/builds, exact scripts-disabled npm carriers, local Git, fresh
owner-private Keel homes, real PTYs, the production local Warden, the clean external Click checkout,
and loopback-only endpoints. All accepted distributions, rejected candidates, ablations, and the
reverted metadata experiment made **zero Anthropic requests**. Incremental input/output tokens and
cost are zero. Cumulative spend remains **USD 4.72508650**; USD 15.27491350 remains and the final USD
2 reserve is intact. The ambient credential was never read, copied, printed, logged, committed, or
captured.

Issue #130 used captured terminal bytes, local parser/unit tests, full local coverage, exact locally
built scripts-disabled npm carriers, real PTYs, and the production local Warden startup path. It
submitted no provider task and made **zero Anthropic requests**. Incremental input/output tokens and
cost are zero. Cumulative spend remains **USD 4.72508650**; USD 15.27491350 remains and the final
USD 2 reserve is intact. No credential value was read, copied, printed, logged, committed, or
captured.

PR #131 publication, issue closure, exact-tree comparison, exact post-main CI, and this evidence-
only closeout made **zero Anthropic requests** and add zero cost. Cumulative spend remains **USD
4.72508650**; USD 15.27491350 remains and the final USD 2 reserve is intact.

The first strict same-commit exact-main onboarding run made 12 provider requests and reported
361,144 input tokens: 145,772 fresh, 83,572 cache write, and 131,800 cache read, plus 4,441 output.
Its exact increment is USD 0.85686600. The 976-word original's single rewrite contained 253 words
against the 250-word hard maximum, so the honest `fallback-oversized` remained primary. Three
runner-preflight failures made zero provider calls and add no cost.

Issue #133 candidate 1 made 12 requests and cost USD 1.07217240; candidate 2 made 21 requests and
cost USD 0.49859415. Both were mechanically compliant but rejected during human final-answer QC for
unsupported runtime prose. Candidate 3 made nine requests and reported 278,769 input tokens: 80,129
fresh, 106,534 cache write, and 92,106 cache read, plus 3,526 output. Its exact increment is USD
0.72041130. The 223-word factual rewrite was accepted locally. All four runs used fresh private
homes, clean frozen Click worktrees, bounded per-run cost rails, and zero Warden review interrupts.
No credential value was read, printed, logged, committed, or captured.

Cumulative dogfood spend is now **USD 7.87313035**. USD 12.12686965 remains under the hard cap;
USD 10.12686965 remains available before preserving the final USD 2.00 reserve.

PR #134 publication, issue closure, exact-tree comparison, exact post-main CI, and this evidence-
only closeout made **zero Anthropic requests** and add zero cost. Cumulative spend remains **USD
7.87313035**; USD 12.12686965 remains under the hard cap and the final USD 2.00 reserve is intact.

The exact merged `9a9e40a` onboarding run made ten requests and reported 163,348 input tokens:
66,446 fresh, 39,521 cache write, and 57,381 cache read, plus 4,208 output. Its exact increment is
USD 0.42787605. It mechanically passed, but human semantic QC rejected its false unproved runtime
mechanism; no score credit is assigned.

Issue #136 ordinary-system-prompt candidates made 12, 12, and 13 requests. Their exact costs are
USD 0.45934575, USD 0.44783460, and USD 0.61852755. All settled `accepted-rewrite` with zero reviews
but failed human semantic QC, so they remain rejected evidence.

After the owner-approved rewrite-boundary extension, two independent fresh-home runs made 12 and
nine requests. Live 1 reported 46,995 fresh, 29,356 cache-write, 55,437 cache-read, and 4,609 output
tokens for USD 0.33683610. Live 2 reported 165,754 fresh, 67,193 cache-write, 53,073 cache-read, and
3,829 output tokens for USD 0.82259265. Both passed human semantic QC, requested zero reviews, and
left the frozen Click worktrees clean.

Cumulative dogfood spend is now **USD 10.98614305**. USD 9.01385695 remains under the hard cap;
USD 7.01385695 remains usable before preserving the final USD 2.00 reserve. The $10 threshold
review found continued value in closing this high-impact trust defect. Broad exploration remains
stopped; the remaining budget is prioritized for exact merged regression and final evidence. No
credential value was read, copied, printed, logged, committed, or captured.
