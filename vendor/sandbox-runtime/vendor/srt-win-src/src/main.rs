//! `srt-win` — CLI for the sandbox-runtime Windows network fence.
//!
//! Subcommands:
//!   install | uninstall                — convenience: group + WFP in one
//!                                         elevated call (one UAC prompt)
//!   group  create | status | delete    — manage the discriminator local group
//!   wfp    install | status | uninstall — manage the persistent WFP filters
//!   exec   -- <target> [args...]       — spawn under the deny-only-group
//!                                         token + job + hardening stack
//!   acl    stamp | restore | recover   — file-level denyRead/denyWrite via
//!                                         broker-only DACL stamp + state DB
//!
//! `status` subcommands write one line of JSON to stdout and exit 0.
//! Mutating subcommands require elevation and write human-readable
//! progress to stderr. `exec` propagates the child's exit code.

use clap::{Args, Parser, Subcommand};

/// Default group name. Lives here (not in the `#[cfg(windows)]`
/// library crate) so the clap-derive CLI structs compile on
/// non-Windows hosts where the library is empty.
const DEFAULT_GROUP_NAME: &str = "sandbox-runtime-net";

#[derive(Parser)]
#[command(name = "srt-win", version, about)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Group create + WFP install in one elevated step.
    ///
    /// Self-elevates via UAC if not already running as admin
    /// (one prompt; the elevated child does the work and the
    /// parent relays its exit code). With the machine-wide
    /// filter design, a token where the group is **absent**
    /// (i.e. this session, before logout) matches filter-0
    /// (PERMIT non-members) — so installing the WFP filters
    /// here does NOT break the user's network. Logout is still
    /// required before `srt-win exec` works (the broker
    /// pre-flight needs the group **enabled** to build a
    /// deny-only child token), but the install itself is one
    /// safe step → one UAC prompt.
    ///
    /// Equivalent to `group create --name <N> --user-sid <U>`
    /// followed by `wfp install --name <N> …`. With `--group-sid`,
    /// the group is assumed to already exist (e.g. provisioned by
    /// domain GPO) and only the filters are installed.
    ///
    /// Exit codes:
    ///   0  — installed (or already installed with the same
    ///        port-range; no changes)
    ///   10 — UAC prompt cancelled by the user
    ///   11 — group create / lookup failed
    ///   12 — WFP filter install failed
    ///   13 — already installed under this sublayer with a
    ///        DIFFERENT port-range; pass `--force` to replace
    ///   1  — other error (parse, elevation check, etc.)
    Install {
        #[command(flatten)]
        group: GroupRef,
        /// User SID to add to the group (default: current user).
        /// Ignored with `--group-sid`.
        #[arg(long)]
        user_sid: Option<String>,
        /// Sublayer GUID (default: compile-time constant).
        #[arg(long)]
        sublayer_guid: Option<String>,
        /// Loopback port range (`LOW-HIGH`, default 60080-60089).
        #[arg(long, value_name = "LOW-HIGH")]
        proxy_port_range: Option<String>,
        /// Replace an existing install whose port-range differs
        /// (otherwise exits 13).
        #[arg(long)]
        force: bool,
    },
    /// Remove the srt-win WFP filters under the sublayer.
    ///
    /// Self-elevates via UAC if not already admin. Does NOT
    /// delete the discriminator group — use `srt-win group
    /// delete --name <N>` for that explicitly.
    Uninstall {
        #[arg(long)]
        sublayer_guid: Option<String>,
    },
    /// Manage the local discriminator group.
    Group {
        #[command(subcommand)]
        sub: GroupCmd,
    },
    /// Manage the persistent WFP filters.
    Wfp {
        #[command(subcommand)]
        sub: WfpCmd,
    },
    /// Stamp/restore broker-only DACLs on file paths so the
    /// sandboxed child cannot read (or write) them. State is
    /// persisted in `%LOCALAPPDATA%\sandbox-runtime\state.db` so
    /// concurrent brokers refcount and a crash mid-session is
    /// recoverable by the next `acl` op.
    Acl {
        #[command(subcommand)]
        sub: AclCmd,
    },
    /// Spawn a process under the deny-only-group sandbox.
    ///
    /// Builds a restricted token (group + Admins flipped deny-only,
    /// LUA, Medium IL, all privs stripped except SeChangeNotify),
    /// self-protects the broker, assigns the child to a
    /// kill-on-close job with full UI lockdown, places it on a
    /// non-interactive desktop, applies process-mitigation
    /// policies + an explicit handle whitelist, and waits for it
    /// to exit. Propagates the child's exit code.
    ///
    /// The child inherits this process's environment verbatim — proxy
    /// configuration is single-sourced by the caller, which sets the
    /// proxy vars (TS `generateProxyEnvVars`) in the environment it
    /// spawns `srt-win exec` with. There are intentionally no
    /// `--http-proxy` / `--socks-proxy` flags and no proxy fallback.
    Exec {
        #[command(flatten)]
        group: GroupRef,
        /// Sublayer GUID under which the WFP filters were
        /// installed. Default is the compile-time constant (same
        /// as `srt-win install`). exec refuses to launch when no
        /// srt-win filter set is installed under this sublayer —
        /// the network fence is the load-bearing isolation
        /// boundary; without it the child has full egress.
        #[arg(long)]
        sublayer_guid: Option<String>,
        /// Skip the "is the group enabled in the broker's token"
        /// pre-flight. **Fail-open** — the WFP fence depends on
        /// that membership; with this set the child may run with
        /// weaker isolation if the install was incomplete.
        /// Surfaced as a flag (not an env var) so the bypass is
        /// intentional and not accidentally inherited. Use ONLY
        /// in ephemeral CI runners that create the group in-job
        /// and cannot logout/login mid-run.
        #[arg(long)]
        skip_group_check: bool,
        /// Skip the WFP filter-presence pre-flight. **Fail-open**
        /// — without filters the child has unrestricted network
        /// egress. Same intentional-bypass semantics as
        /// `--skip-group-check`. Use ONLY when the network fence
        /// is provided by another mechanism (or is not required
        /// for the test).
        #[arg(long)]
        skip_wfp_check: bool,
        /// PID of the long-lived host whose `acl stamp` holds this
        /// child should be fenced under. When set, exec opens a
        /// no-`FILE_SHARE_DELETE` handle on every file that holder
        /// has stamped and keeps it open until the child exits — the
        /// OS then refuses delete/rename of those files, which the
        /// file's DACL alone cannot prevent (delete is authorized by
        /// the parent directory). When omitted, exec runs with no
        /// state-DB dependency (current standalone behaviour).
        #[arg(long)]
        holder_pid: Option<u32>,
        /// Target executable followed by its arguments. Use `--`
        /// to terminate srt-win's own option parsing.
        #[arg(
            trailing_var_arg = true,
            allow_hyphen_values = true,
            required = true,
            num_args = 1..,
        )]
        target: Vec<String>,
    },
}

/// Group resolution: either by name (looked up via
/// `LookupAccountNameW`) or directly by SID. If both are given the
/// SID wins; `group create`/`delete` always need a name.
#[derive(Args, Clone)]
struct GroupRef {
    /// Group name (local or `DOMAIN\name`). Default
    /// `sandbox-runtime-net`.
    #[arg(long, default_value = DEFAULT_GROUP_NAME)]
    name: String,
    /// Group SID (`S-1-…`). Overrides `--name` for SID resolution.
    /// Use when the group is provisioned by external tooling and name
    /// lookup may be unreliable.
    #[arg(long)]
    group_sid: Option<String>,
}

#[derive(Subcommand)]
enum GroupCmd {
    /// Create the local group and add the current (or `--user-sid`)
    /// user to it. Idempotent. Self-elevates via UAC if not already
    /// admin.
    Create {
        #[command(flatten)]
        group: GroupRef,
        /// User SID to add (default: current user).
        #[arg(long)]
        user_sid: Option<String>,
    },
    /// Print group state as JSON: `{state, sid?, warning?}`.
    Status {
        #[command(flatten)]
        group: GroupRef,
    },
    /// Delete the local group. Idempotent. Self-elevates via UAC if
    /// not already admin.
    Delete {
        #[command(flatten)]
        group: GroupRef,
    },
}

#[derive(Subcommand)]
enum AclCmd {
    /// Read `{denyRead:[…], denyWrite:[…]}` from stdin, stamp each
    /// path's DACL broker-only, and record this process as a
    /// holder. Idempotent across calls and brokers (refcounted).
    /// Directories and globs are rejected.
    Stamp {
        #[command(flatten)]
        group: GroupRef,
        /// PID of the LONG-LIVED process that owns these stamps —
        /// normally the Node host (sandbox-runtime), which calls
        /// `acl stamp` at initialize() and `acl restore` at reset()
        /// from a SEPARATE short-lived `srt-win` process. The stamp
        /// persists until this PID exits or restores. Required:
        /// the `srt-win acl` process exits immediately, so keying
        /// on its own PID would orphan the stamp instantly.
        #[arg(long)]
        holder_pid: u32,
    },
    /// Drop the holder's claim on every path it stamped; restore the
    /// original DACL on any path whose refcount falls to zero.
    Restore {
        #[command(flatten)]
        group: GroupRef,
        /// Holder PID whose stamps to release (see `acl stamp`).
        /// Must match the value passed at stamp time.
        #[arg(long)]
        holder_pid: u32,
        /// Emit a single JSON array of per-path
        /// `{path, status, expectedFileId?, movedTo?, leftStamped?}`
        /// objects on stdout (exit 0 always); the host raises any
        /// error AFTER reading the array. Without this flag, the
        /// existing human-readable summary goes to stderr.
        #[arg(long)]
        json: bool,
    },
    /// Run crash-recovery only: prune dead holders, restore any
    /// orphaned stamps. `--force` restores even when the file's
    /// current DACL no longer matches what we stamped (overwrites
    /// third-party edits — use with care).
    Recover {
        #[command(flatten)]
        group: GroupRef,
        #[arg(long)]
        force: bool,
        /// Emit a single JSON array of per-path outcomes on stdout
        /// (see `acl restore --json`).
        #[arg(long)]
        json: bool,
    },
}

/// One per-path entry of the structured `acl restore --json` /
/// `acl recover --json` result. The host reads the full array,
/// then raises if any entry is not `restored` — restore
/// processes ALL paths first; errors are surfaced afterward,
/// never mid-batch.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
struct RestoreEntry {
    path: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_file_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    moved_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    left_stamped: Option<bool>,
}

/// A parent directory's restore outcome in the structured
/// `--json` result. `status: "leftStamped"` means the directory's
/// allow-list could NOT be removed (`restore_sd` failed) and the
/// `parent_stamps` row was kept for the next pass to retry.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
struct ParentEntry {
    path: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Top-level shape of `acl restore --json` / `acl recover --json`.
#[derive(serde::Serialize)]
#[cfg_attr(not(windows), allow(dead_code))]
struct RestoreResult {
    paths: Vec<RestoreEntry>,
    parents: Vec<ParentEntry>,
}

#[cfg(windows)]
fn parent_entries_from(
    entries: &[(String, srt_win::state_db::ParentRestoreOutcome)],
) -> Vec<ParentEntry> {
    use srt_win::state_db::ParentRestoreOutcome;
    entries
        .iter()
        .map(|(p, out)| ParentEntry {
            path: p.clone(),
            status: out.as_str(),
            error: if let ParentRestoreOutcome::Failed(e) = out {
                Some(e.clone())
            } else {
                None
            },
        })
        .collect()
}

#[cfg(windows)]
fn restore_entry(
    snap: &srt_win::state_db::Snapshot,
    out: &srt_win::state_db::RestoreOutcome,
) -> RestoreEntry {
    use srt_win::state_db::RestoreOutcome;
    let (status, moved_to, left_stamped) = match out {
        RestoreOutcome::Restored | RestoreOutcome::AlreadyOriginal => {
            ("restored", None, None)
        }
        RestoreOutcome::Relocated { moved_to } => {
            ("relocated", Some(moved_to.clone()), Some(true))
        }
        RestoreOutcome::Missing => ("missing", None, Some(true)),
        RestoreOutcome::LeftChanged => ("leftChanged", None, Some(true)),
        RestoreOutcome::LeftUnreadable => {
            ("leftUnreadable", None, Some(true))
        }
        RestoreOutcome::Tampered => {
            ("originalSdTampered", None, Some(true))
        }
        RestoreOutcome::OriginalLost => {
            ("originalSdLost", None, Some(true))
        }
        RestoreOutcome::StampedUnrecognized => {
            ("stampedUnrecognized", None, Some(true))
        }
    };
    RestoreEntry {
        path: snap.canonical_path.clone(),
        status,
        expected_file_id: if status == "restored" {
            None
        } else {
            Some(snap.file_id.to_hex())
        },
        moved_to,
        left_stamped,
    }
}

/// Per-batch accounting derived from `StampWitness`es.
#[derive(Default)]
#[cfg_attr(not(windows), allow(dead_code))]
struct StampTally {
    fresh: u32,
    restamped: u32,
    already: u32,
    fence: u32,
    lost: u32,
    failed: u32,
}

#[cfg(windows)]
impl StampTally {
    fn record(&mut self, w: &srt_win::state_db::StampWitness) {
        use srt_win::state_db::StampAction;
        match w.action {
            StampAction::Fresh => self.fresh += 1,
            StampAction::ReStamped => self.restamped += 1,
            StampAction::AlreadyStamped => self.already += 1,
        }
        if w.needs_handle_fence {
            self.fence += 1;
        }
        if w.original_lost {
            self.lost += 1;
        }
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
struct AclStampInput {
    #[serde(default)]
    deny_read: Vec<String>,
    #[serde(default)]
    deny_write: Vec<String>,
}

#[derive(Subcommand)]
enum WfpCmd {
    /// Install (or refresh) the machine-wide persistent WFP filters
    /// keyed on the group SID. Idempotent. Self-elevates via UAC if
    /// not already admin.
    Install {
        #[command(flatten)]
        group: GroupRef,
        /// Sublayer GUID. Default is the compile-time constant; pass
        /// when integrating with externally-managed WFP state.
        #[arg(long)]
        sublayer_guid: Option<String>,
        /// Loopback port range the sandboxed child may reach
        /// (`LOW-HIGH`, inclusive; default 60080-60089). The host
        /// http/socks proxies bind inside this range on Windows.
        #[arg(long, value_name = "LOW-HIGH")]
        proxy_port_range: Option<String>,
    },
    /// Print WFP fence state as JSON: `{state, filters,
    /// port_range?}`. Filters are identified by their
    /// `providerData` tag, so only `--sublayer-guid` is relevant.
    Status {
        #[arg(long)]
        sublayer_guid: Option<String>,
    },
    /// Remove every srt-win-tagged WFP filter under the sublayer.
    /// Self-elevates via UAC if not already admin.
    Uninstall {
        #[arg(long)]
        sublayer_guid: Option<String>,
    },
}

#[cfg(windows)]
fn main() {
    if let Err(e) = run() {
        eprintln!("srt-win: error: {e:#}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn run() -> anyhow::Result<()> {
    use anyhow::{anyhow, Context};
    use serde_json::json;
    use srt_win::{sid, wfp};

    let cli = Cli::parse();

    // Validate a caller-supplied SID string up front so a typo
    // surfaces as "invalid --<flag>" rather than an SDDL parse
    // error three calls deep. Returns the CANONICAL `S-1-…` form
    // (round-tripped through ConvertSidToStringSidW) so SDDL
    // shorthands like `BA` or lower-case `s-1-…` collapse to a
    // single comparable representation; downstream
    // `eq_ignore_ascii_case("S-1-5-32-544")` dedup checks rely on
    // that.
    let canonicalize_sid =
        |flag: &str, s: &str| -> anyhow::Result<String> {
            let p = sid::LocalPsid::from_string(s)
                .with_context(|| format!("invalid --{flag} '{s}'"))?;
            sid::psid_to_string(p.as_psid())
                .with_context(|| format!("canonicalize --{flag} '{s}'"))
        };
    let resolve_group_sid = |g: &GroupRef| -> anyhow::Result<String> {
        if let Some(s) = &g.group_sid {
            return canonicalize_sid("group-sid", s);
        }
        sid::lookup_account_sid(&g.name)
            .with_context(|| format!("resolve group '{}'", g.name))
    };
    let resolve_sublayer = |s: &Option<String>| -> anyhow::Result<windows::core::GUID> {
        match s {
            Some(g) => wfp::parse_guid(g),
            None => Ok(wfp::DEFAULT_SUBLAYER_GUID),
        }
    };

    match cli.cmd {
        // ─── install / uninstall (convenience) ─────────────────────
        Cmd::Install {
            group,
            user_sid,
            sublayer_guid,
            proxy_port_range,
            force,
        } => {
            if let Some(code) = maybe_self_elevate()? {
                std::process::exit(code);
            }
            let sl = resolve_sublayer(&sublayer_guid)?;
            let range = match &proxy_port_range {
                Some(s) => wfp::parse_port_range(s)
                    .with_context(|| format!("invalid --proxy-port-range '{s}'"))?,
                None => wfp::DEFAULT_PROXY_PORT_RANGE,
            };
            // Idempotency / conflict pre-check. If filters are
            // already installed under this sublayer with the SAME
            // port-range, this is a no-op (exit 0). With a
            // DIFFERENT range and no --force, refuse (exit 13) so
            // an unintended config drift surfaces instead of
            // silently overwriting. A pre-existing install whose
            // tags lack a port_range (legacy) is treated as
            // "different" and requires --force.
            if !force
                && let Ok(st) = wfp::filter_status(&sl)
                && st.state == "installed"
            {
                let want = [range.0, range.1];
                if st.port_range == Some(want) {
                    eprintln!(
                        "srt-win: already installed (sublayer={sl:?}, \
                         port_range={}-{}, filters={}); no changes",
                        range.0, range.1, st.filters,
                    );
                    return Ok(());
                }
                let have = st
                    .port_range
                    .map(|[l, h]| format!("{l}-{h}"))
                    .unwrap_or_else(|| "<unknown>".into());
                eprintln!(
                    "srt-win: error: already installed under sublayer \
                     {sl:?} with port_range={have}; pass --force to \
                     replace, or run `srt-win uninstall` first."
                );
                std::process::exit(13);
            }
            // With --group-sid the group is externally managed;
            // just canonicalize. With --name (or the default),
            // create the local group, add the user, then resolve
            // the SID. Failures here exit 11.
            let group_step = || -> anyhow::Result<(String, String)> {
                if let Some(s) = &group.group_sid {
                    let g = canonicalize_sid("group-sid", s)?;
                    Ok((g.clone(), g))
                } else {
                    let user = match &user_sid {
                        Some(s) => canonicalize_sid("user-sid", s)?,
                        None => sid::current_user_sid()
                            .context("resolve current user")?,
                    };
                    wfp::ensure_group(&group.name, &user)?;
                    let g = sid::lookup_account_sid(&group.name)?;
                    Ok((group.name.clone(), g))
                }
            };
            let (label, gsid) = match group_step() {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("srt-win: error: group step: {e:#}");
                    std::process::exit(11);
                }
            };
            if let Err(e) = wfp::install_filters(&sl, &gsid, range) {
                eprintln!("srt-win: error: WFP install: {e:#}");
                std::process::exit(12);
            }
            eprintln!(
                "srt-win: installed (group={label} sid={gsid}, sublayer={sl:?}, \
                 proxy_port_range={}-{}, filters=8)",
                range.0, range.1,
            );
            eprintln!(
                "srt-win: NOTE — log out and back in before running \
                 `srt-win exec` (the group SID enters TokenGroups at \
                 logon; your network is unaffected meanwhile)."
            );
        }
        Cmd::Uninstall { sublayer_guid } => {
            if let Some(code) = maybe_self_elevate()? {
                std::process::exit(code);
            }
            let sl = resolve_sublayer(&sublayer_guid)?;
            let n = wfp::uninstall_filters(&sl)?;
            eprintln!(
                "srt-win: uninstalled ({n} filter(s) removed). \
                 Group is left intact — run `srt-win group delete` \
                 to remove it."
            );
        }

        // ─── group ─────────────────────────────────────────────────
        Cmd::Group { sub: GroupCmd::Create { group, user_sid } } => {
            if let Some(code) = maybe_self_elevate()? {
                std::process::exit(code);
            }
            if group.group_sid.is_some() {
                return Err(anyhow!(
                    "`group create` needs --name; --group-sid is for \
                     referencing an existing group"
                ));
            }
            let user = match &user_sid {
                Some(s) => canonicalize_sid("user-sid", s)?,
                None => sid::current_user_sid()
                    .context("resolve current user")?,
            };
            wfp::ensure_group(&group.name, &user)?;
            let gsid = sid::lookup_account_sid(&group.name)?;
            eprintln!(
                "srt-win: group '{}' present (sid={gsid}); user {user} added",
                group.name
            );
            eprintln!(
                "srt-win: NOTE — the group SID enters TokenGroups at logon. \
                 Log out and back in before running `srt-win exec`."
            );
        }
        Cmd::Group { sub: GroupCmd::Status { group } } => {
            // Resolve SID first; if that fails the group is absent.
            let gsid = match &group.group_sid {
                Some(s) => {
                    // --group-sid bypasses the name lookup, so do a
                    // reverse lookup to distinguish "exists but not on
                    // this token yet" from "no such account at all".
                    // Tolerate transient lookup failure (domain
                    // unreachable) by falling through to the token
                    // check.
                    match sid::sid_account_exists(s) {
                        Ok(sid::SidExistence::Unmapped) => {
                            println!("{}", json!({"state": "absent"}));
                            return Ok(());
                        }
                        Ok(_) => {}
                        Err(e) => {
                            // Malformed SID string.
                            println!(
                                "{}",
                                json!({"state": "absent", "error": e.to_string()})
                            );
                            return Ok(());
                        }
                    }
                    s.clone()
                }
                None => match sid::lookup_account_sid(&group.name) {
                    Ok(s) => s,
                    Err(_) => {
                        println!("{}", json!({"state": "absent"}));
                        return Ok(());
                    }
                },
            };
            let out = match sid::group_state_for_self(&gsid)? {
                sid::GroupState::Enabled => {
                    json!({"state": "ready", "sid": gsid})
                }
                sid::GroupState::Absent => {
                    json!({"state": "created-not-on-token", "sid": gsid})
                }
                sid::GroupState::DenyOnly => json!({
                    "state": "created-not-on-token",
                    "sid": gsid,
                    "warning": "group is deny-only in this token — running \
                                inside a sandbox child?"
                }),
                sid::GroupState::Present => json!({
                    "state": "created-not-on-token",
                    "sid": gsid,
                    "warning": "group present but neither enabled nor \
                                deny-only (unexpected)"
                }),
            };
            println!("{out}");
        }
        Cmd::Group { sub: GroupCmd::Delete { group } } => {
            if let Some(code) = maybe_self_elevate()? {
                std::process::exit(code);
            }
            if group.group_sid.is_some() {
                return Err(anyhow!(
                    "`group delete` needs --name; cannot delete by SID"
                ));
            }
            wfp::delete_group(&group.name)?;
            eprintln!("srt-win: group '{}' deleted (if it existed)", group.name);
        }

        // ─── wfp ───────────────────────────────────────────────────
        Cmd::Wfp {
            sub:
                WfpCmd::Install {
                    group,
                    sublayer_guid,
                    proxy_port_range,
                },
        } => {
            if let Some(code) = maybe_self_elevate()? {
                std::process::exit(code);
            }
            let gsid = resolve_group_sid(&group)?;
            let sl = resolve_sublayer(&sublayer_guid)?;
            let range = match &proxy_port_range {
                Some(s) => wfp::parse_port_range(s)
                    .with_context(|| format!("invalid --proxy-port-range '{s}'"))?,
                None => wfp::DEFAULT_PROXY_PORT_RANGE,
            };
            wfp::install_filters(&sl, &gsid, range)?;
            eprintln!(
                "srt-win: WFP filters installed (group_sid={gsid}, \
                 sublayer={sl:?}, proxy_port_range={}-{})",
                range.0, range.1,
            );
        }
        Cmd::Wfp { sub: WfpCmd::Status { sublayer_guid } } => {
            let sl = resolve_sublayer(&sublayer_guid)?;
            let st = wfp::filter_status(&sl)?;
            println!("{}", serde_json::to_string(&st)?);
        }
        Cmd::Wfp { sub: WfpCmd::Uninstall { sublayer_guid } } => {
            if let Some(code) = maybe_self_elevate()? {
                std::process::exit(code);
            }
            let sl = resolve_sublayer(&sublayer_guid)?;
            let n = wfp::uninstall_filters(&sl)?;
            eprintln!("srt-win: removed {n} WFP filter(s)");
        }

        // ─── acl ───────────────────────────────────────────────────
        Cmd::Acl {
            sub: AclCmd::Stamp { group, holder_pid },
        } => {
            use srt_win::{acl, sid, state_db};
            let gsid = resolve_group_sid(&group)?;
            let user_sid = sid::current_user_sid()?;
            let holder = state_db::HolderPid(holder_pid);
            let mut buf = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)
                .context("read stdin")?;
            let input: AclStampInput = serde_json::from_str(&buf)
                .context("parse stdin JSON {denyRead:[…], denyWrite:[…]}")?;
            // Canonicalize and reject dirs/globs BEFORE taking the
            // mutex so a bad input doesn't hold the lock. Globs and
            // directories are HARD errors (config bug — abort the
            // whole batch). Any other canonicalize failure
            // (nonexistent path, transient open error,
            // unpaired-surrogate canonical) is collected per-path
            // and the batch continues — but exit is non-zero so the
            // host never treats a partial stamp as success.
            let mut targets: Vec<(String, acl::AclMask)> = Vec::new();
            let mut bad_inputs: Vec<(String, String)> = Vec::new();
            for (list, mask) in [
                (&input.deny_read, acl::AclMask::ReadDeny),
                (&input.deny_write, acl::AclMask::WriteDeny),
            ] {
                for p in list {
                    match acl::canonicalize_path(p) {
                        Ok((canon, false)) => targets.push((canon, mask)),
                        Ok((canon, true)) => {
                            return Err(anyhow!(
                                "Windows fs deny requires explicit file \
                                 paths; got directory '{p}' (canonical \
                                 '{canon}')."
                            ));
                        }
                        Err(acl::CanonError::Glob) => {
                            return Err(anyhow!(
                                "Windows fs deny requires explicit file \
                                 paths; got glob '{p}'."
                            ));
                        }
                        Err(acl::CanonError::Other(e)) => {
                            bad_inputs.push((p.clone(), format!("{e:#}")));
                        }
                    }
                }
            }
            for (p, e) in &bad_inputs {
                eprintln!("srt-win: skipped: '{p}': {e}");
            }
            let dacls = acl::PrebuiltDacls::build(&gsid, &user_sid)?;
            let (tally, report) = state_db::with_init_lock(
                &gsid, holder, Some(&dacls), false,
                |db| {
                    db.register_broker()?;
                    let mut t = StampTally::default();
                    for (canon, mask) in &targets {
                        // No per-arm policy: every path goes through
                        // the same disk-first chokepoint. The sealed
                        // StampWitness makes a "trust the row, skip
                        // the disk check" branch unspellable here.
                        match db.ensure_stamped(canon, *mask, &dacls) {
                            Ok(w) => t.record(&w),
                            Err(e) => {
                                eprintln!(
                                    "srt-win: '{canon}': {e:#}"
                                );
                                t.failed += 1;
                            }
                        }
                    }
                    Ok(t)
                },
            )?;
            eprintln!(
                "srt-win: acl stamp — {} path(s) ({} newly stamped, \
                 {} escalated, {} already held, {} parent-stamp \
                 fallback{}{}{}); recovery pruned {} dead broker(s), \
                 restored {} orphan(s)",
                targets.len(),
                tally.fresh,
                tally.restamped,
                tally.already,
                tally.fence,
                if tally.lost > 0 {
                    format!(", {} original_sd_lost", tally.lost)
                } else { String::new() },
                if tally.failed > 0 {
                    format!(", {} FAILED", tally.failed)
                } else { String::new() },
                if !bad_inputs.is_empty() {
                    format!(", {} skipped", bad_inputs.len())
                } else { String::new() },
                report.dead_brokers,
                report.restored,
            );
            if tally.failed > 0 {
                return Err(anyhow!(
                    "{} path(s) could not be stamped (see above); \
                     refusing to report success",
                    tally.failed
                ));
            }
            if !bad_inputs.is_empty() {
                // Exit 2 = partial: the resolvable inputs WERE
                // stamped (so the sandbox is safe to run for
                // those), but at least one input was skipped. The
                // host must surface this rather than treat it as
                // success.
                eprintln!(
                    "srt-win: {} input path(s) skipped (see above); \
                     exiting 2 (partial)",
                    bad_inputs.len()
                );
                std::process::exit(2);
            }
        }
        Cmd::Acl {
            sub: AclCmd::Restore { group, holder_pid, json },
        } => {
            use srt_win::{acl, sid, state_db};
            let gsid = resolve_group_sid(&group)?;
            let user_sid = sid::current_user_sid()?;
            let holder = state_db::HolderPid(holder_pid);
            let dacls = acl::PrebuiltDacls::build(&gsid, &user_sid)?;
            let (entries, report) = state_db::with_init_lock(
                &gsid, holder, Some(&dacls), false,
                |db| {
                    let holds = db.my_holds()?;
                    let mut entries: Vec<RestoreEntry> = Vec::new();
                    let mut parent_outs: Vec<(
                        String,
                        state_db::ParentRestoreOutcome,
                    )> = Vec::new();
                    for canon in &holds {
                        let now_zero = db.remove_holder(canon)?;
                        if !now_zero {
                            // Another holder still has it — released
                            // our claim, file stays stamped. Not
                            // reported (the LAST holder to release
                            // does).
                            continue;
                        }
                        let Some(snap) = db.get_snapshot(canon)?
                        else {
                            eprintln!(
                                "srt-win: WARNING: '{canon}' had a holder \
                                 row but no snapshot — skipping"
                            );
                            continue;
                        };
                        // Same case analysis as crash-recovery so
                        // the two cannot diverge. A mismatch on one
                        // path does NOT abort the batch — every
                        // other path is still processed.
                        let out = db.try_restore(
                            &snap, &dacls, false, &mut parent_outs,
                        )?;
                        entries.push(restore_entry(&snap, &out));
                    }
                    db.unregister_broker()?;
                    Ok((entries, parent_outs))
                },
            )?;
            let (entries, parent_outs) = entries;
            let restored =
                entries.iter().filter(|e| e.status == "restored").count();
            let left = entries.len() - restored;
            // Parent left-stamped count is the union of
            // crash-recovery's pass and THIS restore's parent
            // outcomes (previously only the former was reported,
            // so a non-JSON caller saw `0 parent dir(s) left
            // stamped` while a parent was still on disk).
            let parents_left = report.parents_left as usize
                + parent_outs
                    .iter()
                    .filter(|(_, o)| {
                        !matches!(
                            o,
                            state_db::ParentRestoreOutcome::Restored
                                | state_db::ParentRestoreOutcome::AlreadyOriginal
                                | state_db::ParentRestoreOutcome::StillHeld
                        )
                    })
                    .count();
            eprintln!(
                "srt-win: acl restore — {} restored, {} left \
                 (relocated/missing/changed/tampered){}",
                restored,
                left,
                if parents_left > 0 {
                    format!("; {} parent dir(s) left stamped", parents_left)
                } else {
                    String::new()
                },
            );
            if json {
                // Parents reported by crash-recovery + by this
                // restore arm, merged.
                let mut all_parents = report.parent_entries.clone();
                all_parents.extend(parent_outs);
                let result = RestoreResult {
                    paths: entries,
                    parents: parent_entries_from(&all_parents),
                };
                serde_json::to_writer(std::io::stdout(), &result)
                    .context("write --json restore result")?;
                println!();
            }
        }
        Cmd::Acl { sub: AclCmd::Recover { group, force, json } } => {
            use srt_win::{acl, sid, state_db};
            let gsid = resolve_group_sid(&group)?;
            let user_sid = sid::current_user_sid()?;
            let dacls = acl::PrebuiltDacls::build(&gsid, &user_sid)?;
            // recover only runs crash-recovery (holder-agnostic); the
            // holder PID is irrelevant, pass our own.
            let ((), report) = state_db::with_init_lock(
                &gsid,
                state_db::HolderPid(std::process::id()),
                Some(&dacls),
                force,
                |_db| Ok(()),
            )?;
            eprintln!(
                "srt-win: acl recover — pruned {} dead broker(s), \
                 restored {} orphan(s), {} relocated, {} missing, \
                 left {} (changed since stamp{})",
                report.dead_brokers,
                report.restored,
                report.relocated,
                report.missing,
                report.left_changed,
                if force { "; --force applied" } else { "" },
            );
            if json {
                let result = RestoreResult {
                    paths: report
                        .entries
                        .iter()
                        .map(|(s, o)| restore_entry(s, o))
                        .collect(),
                    parents: parent_entries_from(&report.parent_entries),
                };
                serde_json::to_writer(std::io::stdout(), &result)
                    .context("write --json recover result")?;
                println!();
            }
        }

        // ─── exec ──────────────────────────────────────────────────
        Cmd::Exec {
            group,
            sublayer_guid,
            skip_group_check,
            skip_wfp_check,
            holder_pid,
            target,
        } => {
            use srt_win::{fence, launch, state_db};
            let gsid = resolve_group_sid(&group)?;
            // WFP pre-flight (mirrors the group-state pre-flight in
            // launch::run). The TS host already gates on
            // `getWindowsWfpStatus().state == 'installed'`, but
            // `srt-win exec` invoked directly would otherwise
            // fail-open with no network fence at all. Done here
            // (not in launch.rs) so resolve_sublayer's GUID-parse
            // error reporting is shared with `wfp status|install`.
            let sl = resolve_sublayer(&sublayer_guid)?;
            match wfp::filter_status(&sl) {
                Ok(s) if s.state == "installed" => {}
                Ok(s) if skip_wfp_check => {
                    eprintln!(
                        "srt-win: WARNING: --skip-wfp-check is set and \
                         WFP filters under sublayer {sl:?} are \
                         {} ({} filter(s)). The network fence is NOT \
                         in effect for this process tree.",
                        s.state, s.filters,
                    );
                }
                Ok(s) => {
                    return Err(anyhow!(
                        "WFP filters under sublayer {sl:?} are {} \
                         ({} filter(s)) — the network fence is not \
                         installed. Run `srt-win install` (or `srt-win \
                         wfp install --sublayer-guid {sl:?}`). Pass \
                         --skip-wfp-check to bypass.",
                        s.state, s.filters,
                    ));
                }
                Err(e) if skip_wfp_check => {
                    eprintln!(
                        "srt-win: WARNING: --skip-wfp-check is set and \
                         WFP filter status could not be read ({e:#}); \
                         proceeding without verifying the network fence"
                    );
                }
                Err(e) => {
                    return Err(anyhow!(
                        "cannot verify WFP filter state under sublayer \
                         {sl:?}: {e:#}. Pass --skip-wfp-check to bypass."
                    ));
                }
            }
            // `target` is `required, num_args=1..` so non-empty.
            let exe = std::path::PathBuf::from(&target[0]);
            let args = &target[1..];

            // Delete/rename fence — FALLBACK only. The primary
            // delete/rename protection is the parent-directory
            // allow-list stamp (`acl stamp` strips the user's
            // FILE_DELETE_CHILD on each protected file's parent).
            // The fence is held only on files whose parent could
            // NOT be stamped (`parent_stamp_failed = 1` — no
            // WRITE_DAC on the parent, or no parent). For that
            // subset the fence is LOAD-BEARING: if any such path
            // can't be opened (after a short retry) the deny
            // guarantee would be incomplete and exec must not run —
            // `?` propagates. With --holder-pid omitted, exec has
            // no state-DB dependency. Logged on the no-flag and
            // success paths; on failure the error names the cause
            // directly.
            let delete_fence = match holder_pid {
                None => {
                    eprintln!(
                        "srt-win: handle fence: skipped (no --holder-pid)"
                    );
                    None
                }
                Some(pid) => {
                    let holder = state_db::HolderPid(pid);
                    // One RO open + one read transaction → a
                    // single WAL snapshot for both the file-fence
                    // and parent-fence queries. Two independent
                    // opens could see different
                    // `parent_stamp_failed` bits (a concurrent
                    // re-stamp's step-4 upsert forces it to 1
                    // until step 7) and drop a stamped parent from
                    // BOTH lists.
                    let plan = state_db::fence_plan_for_holder(holder)
                        .with_context(|| {
                            format!(
                                "fence plan: state-DB lookup for \
                                 holder {pid}"
                            )
                        })?
                        .unwrap_or_default();
                    let f =
                        fence::open_delete_fence(&plan.fallback_files)?;
                    if plan.fallback_files.is_empty() {
                        eprintln!(
                            "srt-win: handle fence: holder_pid={pid} → \
                             0 path(s) (parent stamps cover all)"
                        );
                    } else {
                        eprintln!(
                            "srt-win: handle fence (fallback): \
                             holder_pid={pid} → {} parent-stamp-failed \
                             path(s) fenced",
                            plan.fallback_files.len()
                        );
                    }
                    // Best-effort dir fence on the holder's
                    // stamped parent directories + the state-DB
                    // directory: a no-FILE_SHARE_DELETE handle
                    // blocks the child renaming the parent dir
                    // ITSELF (rename is authorized by the
                    // grandparent's FILE_DELETE_CHILD, which we
                    // don't stamp) — preventing path
                    // substitution of the directory while the
                    // child runs. The state-DB dir is fenced for
                    // the same reason (a child renaming it
                    // could plant a poisoned DB at the path).
                    // Open-fail → log + continue: file DACLs
                    // still hold; only directory-rename is
                    // unguarded (the documented residual).
                    let mut dirs = plan.parents;
                    if let Ok(sd) = state_db::state_dir() {
                        dirs.push(sd.display().to_string());
                    }
                    let df = fence::open_best_effort(&dirs, "dir");
                    Some((f, df))
                }
            };

            let spec = launch::ExecSpec {
                group_sid: &gsid,
                skip_group_check,
                target_exe: &exe,
                target_args: args,
            };
            let code = launch::run(&spec)?;
            // `delete_fence` drops here → handles closed → fence
            // lifted. process::exit skips destructors, so explicitly
            // drop anything that needs cleanup BEFORE it. Propagate
            // the child's exit code verbatim.
            drop(delete_fence);
            std::process::exit(code as i32);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_elevated() -> anyhow::Result<bool> {
    use anyhow::Context;
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcessToken,
    };
    unsafe {
        let mut tok = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok)
            .context("OpenProcessToken")?;
        let mut elev = TOKEN_ELEVATION::default();
        let mut ret = 0u32;
        let r = GetTokenInformation(
            tok,
            TokenElevation,
            Some(&mut elev as *mut _ as *mut c_void),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret,
        );
        let _ = CloseHandle(tok);
        r.context("GetTokenInformation(TokenElevation)")?;
        Ok(elev.TokenIsElevated != 0)
    }
}

/// Hard elevation gate: returns an error (no UAC relaunch) when not
/// admin. The granular admin mutators self-elevate via
/// [`maybe_self_elevate`], so this currently has no caller — it's
/// retained as the non-interactive counterpart for code paths that
/// must NOT pop a UAC prompt, hence `allow(dead_code)`.
#[cfg(windows)]
#[allow(dead_code)]
fn require_elevated() -> anyhow::Result<()> {
    if is_elevated()? {
        Ok(())
    } else {
        Err(anyhow::anyhow!(
            "this command requires elevation — run from an \
             administrator prompt"
        ))
    }
}

/// If not already elevated, re-launch ourselves with the same
/// argv via `ShellExecuteExW(verb="runas")` — one UAC prompt —
/// wait for the elevated child, and return its exit code. If
/// already elevated, returns `Ok(None)` and the caller proceeds
/// in-process. If the user cancels the UAC dialog
/// (`ERROR_CANCELLED`), exits with code **10** so the caller's
/// exit-code contract holds without the caller needing a
/// separate match.
///
/// The elevated child runs in its own (hidden) console, so its
/// stdout/stderr are NOT relayed to the parent. For
/// `install`/`uninstall` that's acceptable: the exit code is the
/// contract; the convenience commands' stderr is informational
/// only. The granular `group create|delete` and `wfp
/// install|uninstall` admin mutators call this too; their stderr is
/// likewise informational. Read-only subcommands (`group status`,
/// `wfp status`, `exec`) run as the broker and never self-elevate.
#[cfg(windows)]
fn maybe_self_elevate() -> anyhow::Result<Option<i32>> {
    use anyhow::Context;
    use srt_win::launch::quote_arg;
    use srt_win::util::wstr;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_CANCELLED, GetLastError,
    };
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, WaitForSingleObject, INFINITE,
    };
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SEE_MASK_NO_CONSOLE,
        SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    if is_elevated()? {
        return Ok(None);
    }

    let exe = std::env::current_exe().context("current_exe")?;
    let exe_str = exe.to_str().ok_or_else(|| {
        anyhow::anyhow!(
            "current_exe path '{}' is not representable as UTF-8 \
             (contains unpaired surrogates); cannot self-elevate",
            exe.display()
        )
    })?;
    let exe_w = wstr(exe_str);
    // Rebuild the original argv (minus argv[0]) using
    // CommandLineToArgvW-compatible quoting so the elevated
    // child parses identically.
    let params: String = std::env::args()
        .skip(1)
        .map(|a| quote_arg(&a))
        .collect::<Vec<_>>()
        .join(" ");
    let params_w = wstr(&params);
    let verb_w = wstr("runas");

    let mut sei = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NO_CONSOLE,
        lpVerb: PCWSTR(verb_w.as_ptr()),
        lpFile: PCWSTR(exe_w.as_ptr()),
        lpParameters: PCWSTR(params_w.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    // SAFETY: sei is fully initialized; the wide-string buffers
    // outlive the call.
    let ok = unsafe { ShellExecuteExW(&mut sei) };
    if ok.is_err() {
        let err = unsafe { GetLastError() };
        if err == ERROR_CANCELLED {
            eprintln!("srt-win: UAC prompt cancelled by user");
            std::process::exit(10);
        }
        return Err(anyhow::anyhow!(
            "ShellExecuteExW(runas): {} ({}",
            std::io::Error::from_raw_os_error(err.0 as i32),
            err.0,
        ));
    }
    let h = sei.hProcess;
    if h.is_invalid() {
        return Err(anyhow::anyhow!(
            "ShellExecuteExW returned no process handle"
        ));
    }
    let wait = unsafe { WaitForSingleObject(h, INFINITE) };
    if wait == windows::Win32::Foundation::WAIT_FAILED {
        let err = std::io::Error::last_os_error();
        unsafe { let _ = CloseHandle(h); }
        return Err(anyhow::anyhow!(
            "WaitForSingleObject(elevated child): {err}"
        ));
    }
    let mut code: u32 = 1;
    unsafe {
        GetExitCodeProcess(h, &mut code)
            .context("GetExitCodeProcess(elevated child)")?;
        let _ = CloseHandle(h);
    }
    // 259 (STILL_ACTIVE) after a successful wait is a real exit
    // code (the wait already proved the process exited), not the
    // still-running sentinel.
    Ok(Some(code as i32))
}

#[cfg(not(windows))]
fn main() {
    // The clap-derived structs above keep `clap` referenced; just
    // print the platform error.
    let _ = <Cli as clap::CommandFactory>::command();
    eprintln!("srt-win: Windows only");
    std::process::exit(2);
}
