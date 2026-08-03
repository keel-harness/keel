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

Provider calls: 23 successful, 2 rejected at zero reported usage. The USD 2.00 final-regression
reserve remains intact. The R1 replay was deterministic and offline; it made no Anthropic request.
