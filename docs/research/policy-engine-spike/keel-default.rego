package keel.default

# A representative keel default policy pack over the PROPOSED PolicyInput (Appendix D §D.1 with the
# multi-axis sideEffect, ADR-0024 revised). It exists to MEASURE the policy engine, not to be the final
# pack — it deliberately exercises the built-ins a real keel pack needs so the WASM built-in gap is
# observable: sprintf (guidance strings), startswith + glob.match (path containment), count (precedence),
# `in` / set iteration. glob.match is the canary the research flagged as only partially WASM-supported.

import rego.v1

# ---- POL-001: deny fs_read of a secret-sensitivity target ----
deny contains msg if {
	"fs_read" in input.sideEffect.dynamic.effectKinds
	some t in input.sideEffect.dynamic.targets
	t.sensitivity == "secret"
	msg := sprintf("POL-001: blocked read of secret resource %s", [t.value])
}

# ---- POL-002: deny fs_write to a path outside the workspace and not a declared tmp root ----
deny contains msg if {
	"fs_write" in input.sideEffect.dynamic.effectKinds
	some t in input.sideEffect.dynamic.targets
	t.kind == "path"
	t.normalized != input.workspace.path
	not startswith(t.normalized, sprintf("%s/", [input.workspace.path]))
	not glob.match("/tmp/**", ["/"], t.normalized)
	msg := sprintf("POL-002: write outside workspace: %s", [t.normalized])
}

# ---- POL-005: review irreversible effects (e.g. git push --force) ----
review contains msg if {
	"irreversible" in input.sideEffect.dynamic.modifiers
	msg := "POL-005: irreversible action requires review"
}

# ---- POL-006: review network write to an external service ----
review contains msg if {
	"network_write" in input.sideEffect.dynamic.effectKinds
	"external_service" in input.sideEffect.dynamic.scopes
	msg := "POL-006: external network write requires review"
}

# ---- fail-closed on obfuscated / unknown classifier confidence ----
review contains msg if {
	input.sideEffect.dynamic.classifier.confidence in {"obfuscated", "unknown"}
	msg := sprintf("classifier confidence %s -> review (fail-closed)", [input.sideEffect.dynamic.classifier.confidence])
}

# ---- POL-008: warn on package installs (supply-chain is policy-derived) ----
warn contains msg if {
	some t in input.sideEffect.dynamic.targets
	t.kind == "package"
	msg := sprintf("POL-008: package install %s (supply-chain) — review lockfile", [t.value])
}

# ---- verdict precedence: deny > review > warn > allow ----
default verdict := "allow"

verdict := "deny" if count(deny) > 0

verdict := "review" if {
	count(deny) == 0
	count(review) > 0
}

verdict := "warn" if {
	count(deny) == 0
	count(review) == 0
	count(warn) > 0
}

# ---- explain entrypoint (backs `keel policy why`) ----
explain := {
	"verdict": verdict,
	"deny": deny,
	"review": review,
	"warn": warn,
}
