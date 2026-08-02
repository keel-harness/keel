# Security model, in plain language

What keel structurally enforces, what is only partially proven, and what is
explicitly out of scope. The authoritative per-claim record, with tests named for
each row, is the [claim ledger](../quality/claim-ledger.md); the governing threat
model is `MASTER_SPEC.md` §3. This page is the readable summary. Where they
disagree, the ledger wins.

keel is pre-alpha. Nothing here is a compliance claim.

## What is enforced, and how

**Tool execution is out-of-process.** The model can only request actions. A
separate warden process evaluates each request against a hash-pinned policy pack
and runs allowed ones inside an OS sandbox: Seatbelt on macOS, bubblewrap on
Linux. The kernel has no code path that executes a governed tool itself, and if
the warden dies, tool execution halts rather than falling back.

**The sandbox denies by default.** The bash profile allows reads and writes in
the workspace plus declared temp dirs. It denies reads of common credential
stores (`~/.ssh`, `~/.aws`, `~/.kube`, and similar), workspace `.env` files, and
keel's own config, policy, and audit directories. Network egress is deny-all
until a human grants a domain.

**The audit record is not the agent's to write.** Every governed action, denials
included, is appended by the warden to a per-session hash chain with
Ed25519-signed checkpoints. An intent record is written and fsynced before the
sandbox runs anything; if the audit write fails, the action does not execute.
Tool sandboxes deny both read and write access to the audit directory.

**Nothing from the repo is parsed before trust.** Until a human trusts the
workspace, keel performs zero project-file reads. A booby-trapped fixture repo
(malicious `AGENTS.md`, injection pages, an escaping symlink) is part of the test
suite and proves the gate on every CI run.

**Secrets hygiene.** Provider keys live in a `0600` file under your user config,
written atomically, never echoed. A best-effort redaction filter removes known
credential formats and high-entropy tokens from session and audit records before
they touch disk.

## Verify it yourself

Claims here map to executable evidence:

```sh
pnpm test:security        # 990 adversarial and denied-path tests passed
pnpm test:sandbox:real    # real Seatbelt/bubblewrap denial probes (opt-in)
keel audit export <id>    # then verify the bundle offline:
keel audit verify <bundle>
```

The security-suite count was measured on 2026-07-31 at commit
[`a22b127`](https://github.com/keel-harness/keel/commit/a22b127fd37858920d006205758e46cd037e8565);
the command and exact reporter detail are recorded in the
[evidence-number ledger](../quality/evidence-numbers.json).

An unavailable sandbox backend makes `test:sandbox:real` fail, not skip. CI runs
a required real-sandbox leg on every code change.

## Honest limits: partially proven

These hold on the proven surfaces but do not yet cover everything. Statuses are
the claim ledger's.

- **Injection resistance is not injection immunity** (Partial). The model can be
  fooled by hostile content. What the warden constrains is what a fooled model
  can *do* through governed tools. The proof today covers governed bash and the
  trusted file tools, not every conceivable channel.
- **Audit tamper-evidence has an anchor caveat** (Partial). Any edit, reorder, or
  deletion inside the chain is detected. Truncating the tail at a record boundary
  is only detectable when you compare against an out-of-band head anchor, and a
  verified bundle proves integrity, not authorship: compare the signer key with
  one you obtained out of band. Audit tamper-evidence also does not guarantee
  semantic classification accuracy: for example, `cat $HOME/.ssh/id_rsa` is
  recorded with an unexpanded literal path today. Its classifier reports unknown,
  policy reviews it, and the sandbox denies the real secret read, but the recorded
  path target is not a semantically exact expansion.
- **Egress granularity is domain-level** (documented gap). Allowing
  `github.com` allows all of `github.com`.
- **Redaction is best-effort** (Proven for its stated scope). Documented blind
  spots include AWS secret access keys, bare JWTs, and short or split secrets.
  Redaction protects records at rest; a secret the model already read is in its
  context regardless.

## Explicitly out of scope today

keel documents these rather than hiding them. Do not rely on keel for any of
them:

- **Same-user malware and at-rest theft.** keel is not an EDR. A process running
  as your user can read the credentials file and the checkpoint signing key.
- **Provider API egress.** The kernel's own HTTPS calls to your model provider do
  not pass through the warden. This is a documented gap, not a guarantee.
- **Kernel-asserted authority.** Human approvals and mode changes are asserted by
  the kernel process, which is trusted in v1. Warden-owned consent is future
  hardening.
- **Covert channels** (timing, DNS volume, steganography) and full DNS-rebinding
  defense at resolved-address time.
- **The interactive-console guest OS**: the host process is governed, the guest
  OS inside it is not.
- **MCP servers** are pinned trust-on-first-use; pinning is not containment of a
  server that is malicious on first contact.
- **Native Windows** enforces nothing OS-level. WSL2 is the supported path.
- **keel installed *inside* the workspace it is pointed at.** Everything above assumes
  keel's own code lives outside your project. `npx keel-harness` and a global install
  do. Installing keel as a local devDependency — or pointing keel at its own source
  tree — puts the warden and its runtime under the workspace root, where a governed
  write can replace the code that enforces all of this. `keel doctor` warns about it
  (`keel install location`); the fix is to install keel outside the workspace.

## Reporting

Found a way through any of this? See [SECURITY.md](../../SECURITY.md): private
vulnerability reporting first, never a public issue.
