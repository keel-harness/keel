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

Anthropic provider calls: 27 successful, 4 rejected at zero reported usage. R7's two local-fixture
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
The R0 manifest caps a future six-workflow replay at
USD 11.00, below the currently spendable USD 15.2557 after preserving the final USD 2.00 reserve.
