//! Per-exec delete/rename fence — **fallback** for ACL-stamped
//! files whose parent directory could not be stamped.
//!
//! Delete/rename is authorized by the PARENT directory's
//! `FILE_DELETE_CHILD`, which a file's broker-only DACL does not
//! touch. The PRIMARY protection is `acl stamp`'s parent-directory
//! allow-list (user gets Modify-without-`FILE_DELETE_CHILD`; see
//! [`crate::acl::apply_parent_allow_list`]) — that protection is
//! on-disk and survives across exec boundaries and process
//! teardown.
//!
//! When the parent can't be stamped (no `WRITE_DAC` on it, or the
//! file is at a volume root), the snapshot is marked
//! `parent_stamp_failed` and `srt-win exec --holder-pid` falls
//! back to this module: it opens each such path with
//! `FILE_SHARE_READ|FILE_SHARE_WRITE` (no `FILE_SHARE_DELETE`) and
//! holds the handle until the child exits — the OS refuses
//! delete/rename of those files (sharing violation). Multi-broker
//! handles coexist (each opens with R|W sharing); the child
//! cannot pre-fence (the file's DACL denies its open).
//!
//! For the fallback set the fence is **load-bearing**: a path
//! that exists but cannot be fenced means the deny guarantee is
//! incomplete, so [`open_delete_fence`] retries transient
//! share-mode conflicts and
//! then **fails** the exec rather than running the child with a
//! partial fence. A path that no longer exists is skipped — the
//! sandbox protects files present at initialization time, so a
//! file deleted from outside the sandbox after initialization is
//! no longer in scope.

use anyhow::{bail, Result};
use std::time::Duration;
use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_READ,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};

use crate::util::{pcwstr, wstr, OwnedHandle};

const RETRY_ROUNDS: u32 = 10;
/// Increasing backoff: round `r` (1-indexed) sleeps `20·r` ms
/// (20, 40, …, 200), so the total wait before declaring failure
/// is ~1.1s — long enough for a transient AV/indexer share-mode
/// holder to release.
fn retry_backoff(round: u32) -> Duration {
    Duration::from_millis(20 * round as u64)
}

/// Held until this struct drops; the OS refuses delete/rename of
/// each path while the wrapped handles are open.
#[derive(Debug)]
pub struct DeleteFence {
    /// Held purely for Drop — the OS refuses delete/rename of
    /// each path while these handles are open.
    _handles: Vec<OwnedHandle>,
}

enum OpenOutcome {
    Fenced(OwnedHandle),
    /// File no longer exists — nothing to fence.
    Gone,
    /// Open refused (sharing violation, access denied, …) —
    /// retry, then fail the exec.
    Blocked(String),
}

/// Open every path with no `FILE_SHARE_DELETE` and hold the
/// handles. Load-bearing: if any path can't be opened after up to
/// [`RETRY_ROUNDS`] retry rounds with increasing backoff (~1s
/// total — long enough for a transient AV/indexer share-mode
/// holder to release), the exec must NOT run (the deny guarantee
/// would be incomplete). A path that is GONE
/// (`ERROR_FILE_NOT_FOUND` / `ERROR_PATH_NOT_FOUND`) is skipped
/// without retry — the deny target no longer exists, so there is
/// nothing to fence; the child could create a NEW file at that
/// path via the parent directory, but that is a different,
/// unstamped file (path-level deny is a separate concern).
///
/// The path set is read at exec start; a path stamped AFTER this
/// exec begins is not fenced for this exec's child. Acceptable in
/// production: stamp at initialize, then exec.
pub fn open_delete_fence(canonical_paths: &[String]) -> Result<DeleteFence> {
    let mut handles = Vec::with_capacity(canonical_paths.len());
    let mut pending: Vec<(&str, String)> = canonical_paths
        .iter()
        .map(|p| (p.as_str(), String::new()))
        .collect();

    for round in 0..=RETRY_ROUNDS {
        if pending.is_empty() {
            break;
        }
        if round > 0 {
            std::thread::sleep(retry_backoff(round));
        }
        let mut still: Vec<(&str, String)> = Vec::new();
        for (p, _) in pending.drain(..) {
            match try_open(p) {
                OpenOutcome::Fenced(h) => handles.push(h),
                OpenOutcome::Gone => {
                    eprintln!(
                        "srt-win: handle fence: '{p}' no longer exists; \
                         skipping (nothing to fence)"
                    );
                }
                OpenOutcome::Blocked(why) => still.push((p, why)),
            }
        }
        pending = still;
    }

    if !pending.is_empty() {
        // Already-opened handles drop here, lifting the partial
        // fence before we fail the exec.
        let detail = pending
            .iter()
            .map(|(p, why)| format!("  '{p}': {why}"))
            .collect::<Vec<_>>()
            .join("\n");
        bail!(
            "handle fence: {} of {} stamped path(s) could not be \
             opened after {} retries — the deny guarantee would be \
             incomplete; refusing to run the sandboxed command:\n{}",
            pending.len(),
            canonical_paths.len(),
            RETRY_ROUNDS,
            detail
        );
    }

    Ok(DeleteFence { _handles: handles })
}

/// Best-effort no-`FILE_SHARE_DELETE` fence for a set of
/// **directories** (stamped parents and the state-DB dir).
///
/// Unlike [`open_delete_fence`] this is NOT load-bearing: a dir
/// that won't open is logged and skipped — the file inside it
/// is still protected by its broker-only DACL; what's lost is
/// the rename guard on the directory ITSELF (path substitution
/// becomes possible, which is the documented residual). For the
/// state-DB dir, the next session's verify-before-accept on the
/// existing-row path catches a poisoned DB regardless.
pub fn open_best_effort(paths: &[String], kind: &str) -> DeleteFence {
    let mut handles = Vec::with_capacity(paths.len());
    for p in paths {
        match try_open(p) {
            OpenOutcome::Fenced(h) => handles.push(h),
            OpenOutcome::Gone => {
                eprintln!(
                    "srt-win: {kind} fence: '{p}' no longer exists; \
                     skipping"
                );
            }
            OpenOutcome::Blocked(why) => {
                eprintln!(
                    "srt-win: {kind} fence: '{p}' could not be opened \
                     ({why}); proceeding without it (file DACLs still \
                     hold; only directory-rename is unguarded)"
                );
            }
        }
    }
    if !paths.is_empty() {
        eprintln!(
            "srt-win: {kind} fence: {}/{} dir(s) fenced",
            handles.len(),
            paths.len()
        );
    }
    DeleteFence { _handles: handles }
}

/// One no-`FILE_SHARE_DELETE` open. `FILE_GENERIC_READ` + R|W
/// sharing = the fence; the broker has FILE_ALL via the stamp's
/// `<group>` ACE so the access check passes even on a `ReadDeny`
/// file. `BACKUP_SEMANTICS` so the open also works on directories
/// once those become supported targets (harmless for files).
fn try_open(canonical_path: &str) -> OpenOutcome {
    let w = wstr(canonical_path);
    let h = unsafe {
        CreateFileW(
            pcwstr(&w),
            FILE_GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    };
    match h {
        Ok(h) => OpenOutcome::Fenced(OwnedHandle(h)),
        // The sandbox protects files present at initialization
        // time from reads/writes from within the sandbox. A file
        // deleted after initialization from OUTSIDE the sandbox is
        // no longer in scope — there is nothing left to fence.
        // (The child cannot have done the deleting: it isn't
        // running yet.)
        Err(e)
            if e.code() == ERROR_FILE_NOT_FOUND.into()
                || e.code() == ERROR_PATH_NOT_FOUND.into() =>
        {
            OpenOutcome::Gone
        }
        Err(e) => OpenOutcome::Blocked(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Storage::FileSystem::FILE_SHARE_NONE;

    /// Fence a temp file end-to-end: open succeeds, and while the
    /// fence is held the OS refuses `remove_file` (sharing
    /// violation); after dropping the fence the delete succeeds.
    #[test]
    fn fence_blocks_delete_then_lifts() {
        let tmp = std::env::temp_dir().join(format!(
            "srt-win-fence-rt-{}.tmp",
            std::process::id()
        ));
        std::fs::write(&tmp, b"x").unwrap();
        let p = tmp.display().to_string();
        let f = open_delete_fence(std::slice::from_ref(&p)).expect("fence");
        let r = std::fs::remove_file(&tmp);
        assert!(
            r.is_err(),
            "delete of fenced file should fail; got {r:?}"
        );
        drop(f);
        std::fs::remove_file(&tmp).expect("delete after fence drop");
    }

    /// A nonexistent path is skipped (Gone), not fatal.
    #[test]
    fn fence_skips_gone_path() {
        let bogus = format!(
            r"\\?\C:\srt-win-fence-no-such-{}.tmp",
            std::process::id()
        );
        let f = open_delete_fence(&[bogus]).expect("gone is skip");
        assert_eq!(f._handles.len(), 0);
    }

    /// A path another process holds with no sharing → fence open
    /// is Blocked, retried, then fatal (and the error names the
    /// path + retry count). Releasing the holder → fence succeeds.
    #[test]
    fn fence_blocked_path_is_fatal_after_retries() {
        let tmp = std::env::temp_dir().join(format!(
            "srt-win-fence-blocked-{}.tmp",
            std::process::id()
        ));
        std::fs::write(&tmp, b"x").unwrap();
        let p = tmp.display().to_string();
        // Hold the file with dwShareMode=0 so any other open fails
        // ERROR_SHARING_VIOLATION.
        let w = wstr(&p);
        let holder = unsafe {
            CreateFileW(
                pcwstr(&w),
                FILE_GENERIC_READ.0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
        }
        .map(OwnedHandle)
        .expect("holder open");

        let r = open_delete_fence(std::slice::from_ref(&p));
        let e = r.expect_err("blocked path should be fatal");
        let msg = format!("{e:#}");
        assert!(msg.contains(&p), "error names the path: {msg}");
        assert!(
            msg.contains(&format!("after {RETRY_ROUNDS} retries")),
            "error reports retries: {msg}"
        );
        assert!(msg.contains("refusing to run"), "{msg}");

        // Release the holder → fence now succeeds.
        drop(holder);
        let f = open_delete_fence(&[p]).expect("fence after release");
        assert_eq!(f._handles.len(), 1);
        drop(f);
        let _ = std::fs::remove_file(&tmp);
    }
}
