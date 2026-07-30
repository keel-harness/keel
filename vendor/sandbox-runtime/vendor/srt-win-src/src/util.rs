//! Small Win32 helpers shared across the crate.

use std::ffi::c_void;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};

/// Owns a kernel `HANDLE`; `CloseHandle` on drop. For tokens, file
/// handles, process handles — anything whose only cleanup is
/// `CloseHandle`. `into_raw()` disarms the guard and returns the
/// handle for callers that need to pass ownership upward.
#[derive(Debug)]
pub struct OwnedHandle(pub HANDLE);

impl OwnedHandle {
    pub fn raw(&self) -> HANDLE {
        self.0
    }
    /// Disarm the guard and return the raw handle (caller takes
    /// ownership and is responsible for closing it).
    pub fn into_raw(self) -> HANDLE {
        let h = self.0;
        std::mem::forget(self);
        h
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// UTF-8 → NUL-terminated UTF-16 buffer. Keep the returned `Vec`
/// alive for as long as the resulting `PCWSTR` / `PWSTR` is in use.
pub fn wstr(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Borrow a `Vec<u16>` from `wstr` as a `PCWSTR`.
pub fn pcwstr(buf: &[u16]) -> PCWSTR {
    PCWSTR(buf.as_ptr())
}

/// Read a NUL-terminated `PWSTR` (typically returned by a Win32 API
/// that allocates) into an owned `String`. Caller still owns the
/// underlying allocation.
pub fn from_pwstr(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    unsafe {
        while *p.0.add(len) != 0 {
            len += 1;
        }
    }
    let slice = unsafe { std::slice::from_raw_parts(p.0, len) };
    String::from_utf16_lossy(slice)
}

/// `LocalFree` a pointer returned by a Win32 API documented to require
/// it (e.g. `ConvertSidToStringSidW`,
/// `ConvertStringSecurityDescriptorToSecurityDescriptorW`).
pub fn local_free(p: *mut c_void) {
    unsafe {
        let _ = LocalFree(Some(HLOCAL(p)));
    }
}

use anyhow::{anyhow, Result};
use windows::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows::Win32::Security::{
    GetSecurityDescriptorLength, PSECURITY_DESCRIPTOR,
};

const SDDL_REVISION_1: u32 = 1;

/// Heap-allocated security descriptor owned by us; `LocalFree` on
/// drop. Built from an SDDL string via [`OwnedSd::from_sddl`].
/// Fields are `pub(crate)` so callers that need the byte view
/// (e.g. `wfp.rs`'s `FWP_BYTE_BLOB` provider data) can read them
/// without pulling subsystem-specific types into util.
pub struct OwnedSd {
    pub(crate) ptr: PSECURITY_DESCRIPTOR,
    pub(crate) len: u32,
}

impl OwnedSd {
    pub fn from_sddl(sddl: &str) -> Result<Self> {
        let w = wstr(sddl);
        let mut psd = PSECURITY_DESCRIPTOR::default();
        let mut sz: u32 = 0;
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                pcwstr(&w),
                SDDL_REVISION_1,
                &mut psd,
                Some(&mut sz),
            )
            .map_err(|e| {
                anyhow!(
                    "ConvertStringSecurityDescriptorToSecurityDescriptorW({sddl}): {e}"
                )
            })?;
            if sz == 0 {
                sz = GetSecurityDescriptorLength(psd);
            }
        }
        Ok(Self { ptr: psd, len: sz })
    }
}

impl Drop for OwnedSd {
    fn drop(&mut self) {
        if !self.ptr.0.is_null() {
            local_free(self.ptr.0);
        }
    }
}
