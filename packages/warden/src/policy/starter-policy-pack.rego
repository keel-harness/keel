package keel.phase2a

import rego.v1

# Phase-2A starter policy pack. This is the first calibrated default pack for
# the live warden policy gate, not the audit chain or evidence-export layer.

deny contains hit if {
	secret_read
	hit := {
		"ruleId": "POL-001",
		"guidance": "POL-001 deny: blocked read of secret resource; use a non-secret workspace path or ask the human to provide the value.",
	}
}

deny contains hit if {
	outside_workspace_write
	hit := {
		"ruleId": "POL-002",
		"guidance": "POL-002 deny: write outside workspace; use a path under the workspace or declared temp root.",
	}
}

deny contains hit if {
	destructive_outside_workspace
	hit := {
		"ruleId": "POL-003",
		"guidance": "POL-003 deny: destructive command targets outside workspace; use a workspace path or ask the human to perform it.",
	}
}

deny contains hit if {
	system_destructive_command
	hit := {
		"ruleId": "POL-003",
		"guidance": "POL-003 deny: destructive system command is blocked; use a workspace-scoped operation or ask the human.",
	}
}

deny contains hit if {
	count(workspace_recursive_force_delete) > 0
	hit := {
		"ruleId": "POL-004",
		"guidance": "POL-004 deny: recursive workspace deletion is not rewritten; delete exact non-recursive targets or use a separately reviewed workflow.",
	}
}

deny contains hit if {
	privilege_escalation
	hit := {
		"ruleId": "POL-009",
		"guidance": "POL-009 deny: privilege escalation is blocked; use a non-privileged command or ask the human.",
	}
}

deny contains hit if {
	keel_owned_path
	hit := {
		"ruleId": "POL-010",
		"guidance": "POL-010 deny: touching keel-owned audit, policy, or config paths is blocked; use project files instead.",
	}
}

review contains hit if {
	unknown_or_obfuscated
	not sandbox_contained_arbitrary_code
	hit := {
		"ruleId": "POL-003",
		"guidance": "POL-003 review: unclassified or obfuscated shell shape requires human review; use a simpler command or ask for approval.",
	}
}

review contains hit if {
	workspace_delete_requires_review
	hit := {
		"ruleId": "POL-004",
		"guidance": "POL-004 review: workspace deletion requires exact human approval; use a non-recursive workspace rm command or ask for approval.",
	}
}

review contains hit if {
	force_or_delete_push
	hit := {
		"ruleId": "POL-005",
		"guidance": "POL-005 review: git force/delete push requires human review; rerun without force/delete or ask for approval.",
	}
}

review contains hit if {
	network_write
	hit := {
		"ruleId": "POL-006",
		"guidance": "POL-006 review: external network write requires human review; use a read-only request or ask for scoped approval.",
	}
}

review contains hit if {
	git_remote_mutation
	hit := {
		"ruleId": "POL-007",
		"guidance": "POL-007 review: git remote mutation or explicit remote push requires human review; keep the existing remote or ask for approval.",
	}
}

warn contains hit if {
	package_install_scripts
	hit := {
		"ruleId": "POL-008",
		"guidance": "POL-008 warn: package install may run supply-chain scripts; prefer --ignore-scripts and inspect lockfile changes.",
	}
}

# POL-004 no longer rewrites shell text. Keep the frozen decision shape explicit.
modify := set()

secret_read if {
	some segment in input.sideEffect.dynamic.composition.segments
	"fs_read" in segment.effectKinds
	some target in segment.targets
	target.sensitivity == "secret"
}

outside_workspace_write if {
	some segment in input.sideEffect.dynamic.composition.segments
	"fs_write" in segment.effectKinds
	not "destructive" in segment.modifiers
	not "temp" in segment.scopes
	some target in segment.targets
	target.kind == "path"
	target.withinWorkspace == false
	not declared_temp_write(target.normalized)
	not keel_path(target.normalized)
}

outside_workspace_write if {
	some segment in input.sideEffect.dynamic.composition.segments
	"fs_write" in segment.effectKinds
	not "destructive" in segment.modifiers
	"temp" in segment.scopes
	some target in segment.targets
	target.kind == "path"
	target.withinWorkspace == false
	target_aware_temp_fact
	not declared_temp_write(target.normalized)
	not keel_path(target.normalized)
}

target_aware_temp_fact if {
	input.sideEffect.extensions["keel.temp"] != null
}

declared_temp_write(path) if {
	some resolved in input.sideEffect.extensions["keel.temp"].resolvedWriteTargets
	resolved == path
	some declared in input.sideEffect.extensions["keel.temp"].declaredWriteTargets
	declared == path
}

destructive_outside_workspace if {
	some segment in input.sideEffect.dynamic.composition.segments
	"destructive" in segment.modifiers
	not "temp" in segment.scopes
	some target in segment.targets
	target.kind == "path"
	target.withinWorkspace == false
}

system_destructive_command if {
	input.normalized.argv[0] == "dd"
	some segment in input.sideEffect.dynamic.composition.segments
	"destructive" in segment.modifiers
	"system" in segment.scopes
}

system_destructive_command if {
	startswith(input.normalized.argv[0], "mkfs")
	some segment in input.sideEffect.dynamic.composition.segments
	"destructive" in segment.modifiers
	"system" in segment.scopes
}

system_destructive_command if {
	some segment in input.sideEffect.dynamic.composition.segments
	"destructive" in segment.modifiers
	"system" in segment.scopes
	some target in segment.targets
	target.kind == "command"
	target.value == "dd"
}

system_destructive_command if {
	some segment in input.sideEffect.dynamic.composition.segments
	"destructive" in segment.modifiers
	"system" in segment.scopes
	some target in segment.targets
	target.kind == "command"
	startswith(target.value, "mkfs")
}

workspace_recursive_force_delete contains target if {
	some segment in input.sideEffect.dynamic.composition.segments
	"destructive" in segment.modifiers
	"irreversible" in segment.modifiers
	some target_entry in segment.targets
	target_entry.kind == "path"
	target_entry.withinWorkspace == true
	target := target_entry.value
}

workspace_delete_requires_review if {
	input.normalized.argv[0] == "rm"
	not rm_recursive_force
	not rm_interactive_recursive
	some segment in input.sideEffect.dynamic.composition.segments
	"destructive" in segment.modifiers
	some target in segment.targets
	target.kind == "path"
	target.withinWorkspace == true
}

rm_recursive_force if {
	rm_recursive
	rm_force
}

rm_interactive_recursive if {
	rm_recursive
	rm_interactive
	not rm_force
}

rm_recursive if {
	some i in rm_option_indices
	arg := input.normalized.argv[i]
	arg == "--recursive"
}

rm_recursive if {
	some i in rm_option_indices
	arg := input.normalized.argv[i]
	startswith(arg, "-")
	not startswith(arg, "--")
	contains(arg, "r")
}

rm_recursive if {
	some i in rm_option_indices
	arg := input.normalized.argv[i]
	startswith(arg, "-")
	not startswith(arg, "--")
	contains(arg, "R")
}

rm_force if {
	some i in rm_option_indices
	arg := input.normalized.argv[i]
	arg == "--force"
}

rm_force if {
	some i in rm_option_indices
	arg := input.normalized.argv[i]
	startswith(arg, "-")
	not startswith(arg, "--")
	contains(arg, "f")
}

rm_interactive if {
	some i in rm_option_indices
	arg := input.normalized.argv[i]
	arg == "--interactive"
}

rm_interactive if {
	some i in rm_option_indices
	arg := input.normalized.argv[i]
	startswith(arg, "-")
	not startswith(arg, "--")
	contains(arg, "i")
}

rm_option_indices contains i if {
	some i
	i > 0
	input.normalized.argv[i]
	not rm_options_ended_before(i)
}

rm_options_ended_before(i) if {
	some j
	j < i
	input.normalized.argv[j] == "--"
}

force_or_delete_push if {
	input.normalized.argv[0] == "git"
	input.normalized.argv[1] == "push"
	some arg in input.normalized.argv
	arg == "--delete"
}

force_or_delete_push if {
	input.normalized.argv[0] == "git"
	input.normalized.argv[1] == "push"
	some arg in input.normalized.argv
	arg == "--force"
}

force_or_delete_push if {
	input.normalized.argv[0] == "git"
	input.normalized.argv[1] == "push"
	some arg in input.normalized.argv
	startswith(arg, "--force-")
}

force_or_delete_push if {
	some segment in input.sideEffect.dynamic.composition.segments
	"irreversible" in segment.modifiers
	some target in segment.targets
	target.kind == "command"
	target.value == "git push"
}

network_write if {
	some segment in input.sideEffect.dynamic.composition.segments
	"network_write" in segment.effectKinds
	"external_service" in segment.scopes
	not git_remote_mutation
	not force_or_delete_push
}

git_remote_mutation if {
	input.normalized.argv[0] == "git"
	input.normalized.argv[1] == "remote"
	input.normalized.argv[2] == "add"
}

git_remote_mutation if {
	input.normalized.argv[0] == "git"
	input.normalized.argv[1] == "remote"
	input.normalized.argv[2] == "set-url"
}

git_remote_mutation if {
	some segment in input.sideEffect.dynamic.composition.segments
	some target in segment.targets
	target.kind == "command"
	target.value == "git remote add"
}

git_remote_mutation if {
	some segment in input.sideEffect.dynamic.composition.segments
	some target in segment.targets
	target.kind == "command"
	target.value == "git remote set-url"
}

git_remote_mutation if {
	input.egress.gitRemote != null
	input.normalized.argv[0] == "git"
	input.normalized.argv[1] == "push"
	not force_or_delete_push
}

package_install_scripts if {
	some target in input.sideEffect.dynamic.targets
	target.kind == "package"
	not has_arg("--ignore-scripts")
	not has_arg("--ignore-scripts=true")
}

package_install_scripts if {
	input.normalized.argv[0] in {"pip", "pip3"}
	input.normalized.argv[1] == "install"
	some arg in input.normalized.argv
	startswith(arg, "http://")
}

package_install_scripts if {
	input.normalized.argv[0] in {"pip", "pip3"}
	input.normalized.argv[1] == "install"
	some arg in input.normalized.argv
	startswith(arg, "https://")
}

privilege_escalation if {
	input.normalized.argv[0] in {"sudo", "su", "doas", "pkexec"}
}

privilege_escalation if {
	some segment in input.sideEffect.dynamic.composition.segments
	"system" in segment.scopes
	some target in segment.targets
	target.kind == "command"
	target.value in {"sudo", "su", "doas", "pkexec"}
}

keel_owned_path if {
	some target in input.sideEffect.dynamic.targets
	target.kind == "path"
	keel_path(target.normalized)
}

unknown_or_obfuscated if {
	input.sideEffect.dynamic.classifier.confidence in {"unknown", "ambiguous", "obfuscated"}
}

unknown_or_obfuscated if {
	some modifier in input.sideEffect.dynamic.modifiers
	modifier == "unknown"
}

sandbox_contained_arbitrary_code if {
	input.sideEffect.extensions["keel.sandbox"].containedArbitraryCode == true
	input.sideEffect.extensions["keel.sandbox"].enforcementTier != "none"
	some reason in input.sideEffect.dynamic.classifier.reasons
	reason == "sandbox_contained_arbitrary_code"
}

has_arg(needle) if {
	some arg in input.normalized.argv
	arg == needle
}

keel_path(path) if {
	contains(path, "/.config/keel/")
}

keel_path(path) if {
	startswith(path, "/keel-home/")
}

keel_path(path) if {
	contains(path, "/keel/audit/")
}

keel_path(path) if {
	contains(path, "/keel/policy/")
}

keel_path(path) if {
	contains(path, "/keel/config/")
}

decision := {
	"deny": deny,
	"review": review,
	"modify": modify,
	"warn": warn,
}
