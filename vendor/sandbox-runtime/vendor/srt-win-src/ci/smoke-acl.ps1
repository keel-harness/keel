<#
  Smoke test for `srt-win acl stamp|restore|recover`.

  Self-contained: creates temp files under a per-run scratch dir,
  stamps/restores them, and verifies access from both the broker
  side (this process — group enabled) and the sandboxed-child side
  (`srt-win exec --group-sid S-1-5-32-544 -- …` — group deny-only).

  Why `BUILTIN\Administrators` as the group: same reason as
  smoke-exec.ps1 — it's already on the runner token, so the child
  genuinely has it deny-only and the broker-only DACL actually
  excludes it. See that script's header.

  The state DB lives under a per-run %LOCALAPPDATA% override so a
  developer running this on their own workstation cannot destroy a
  real session's restore records (the finally block deletes the
  override dir). The override also gives each test row a clean DB
  to assert against. The init-mutex still uses the production
  `Local\sandbox-runtime-acl-init` name (process-wide kernel
  namespace; harmless contention).
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Exe
)

$ErrorActionPreference = 'Stop'

$GroupSid = 'S-1-5-32-544'   # BUILTIN\Administrators
$cmd      = Join-Path $env:SystemRoot 'System32\cmd.exe'
$pwsh     = Join-Path $env:SystemRoot `
  'System32\WindowsPowerShell\v1.0\powershell.exe'
$sqlite   = Get-Command sqlite3 -ErrorAction SilentlyContinue

# Per-run scratch dir for the files we stamp, AND a per-run
# %LOCALAPPDATA% override so the production state.db is never
# touched (running this script locally would otherwise wipe a
# live session's original-SD records).
$Scratch = Join-Path $env:TEMP "srt-acl-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $Scratch | Out-Null
$RealLocalAppData = $env:LOCALAPPDATA
$env:LOCALAPPDATA = Join-Path $Scratch '_localappdata'
New-Item -ItemType Directory -Path $env:LOCALAPPDATA | Out-Null
$stateDir = Join-Path $env:LOCALAPPDATA 'sandbox-runtime'
$stateDb  = Join-Path $stateDir 'state.db'
Write-Host ("smoke-acl: group_sid=$GroupSid  exe=$Exe  " +
            "scratch=$Scratch  stateDb=$stateDb")

# Enable srt-win's per-exec stderr diagnostics (self-protect SDDL
# etc.). The Exec helper's .out filter strips them.
$env:SANDBOX_RUNTIME_WIN_DEBUG = '1'

function Run {
  param([string[]] $argv)
  & $Exe @argv
  if ($LASTEXITCODE -ne 0) {
    throw "srt-win $($argv -join ' ') exited $LASTEXITCODE"
  }
}

# Like Run, but captures and returns the merged stdout+stderr
# (also echoed to the host) so a row can assert on srt-win's
# diagnostic messages.
function RunCapture {
  param([string[]] $argv)
  $raw = & $Exe @argv 2>&1 | Out-String
  Write-Host -NoNewline $raw
  if ($LASTEXITCODE -ne 0) {
    throw "srt-win $($argv -join ' ') exited ${LASTEXITCODE}: $raw"
  }
  return [pscustomobject]@{ raw = $raw }
}

# `acl restore --json` / `acl recover --json` — captures stdout
# (the JSON array) separately from stderr (human diagnostics) and
# returns the parsed array.
function RunJson {
  param([string[]] $argv)
  $serr = [IO.Path]::GetTempFileName()
  try {
    $sout = & $Exe @argv 2>$serr | Out-String
    $diag = Get-Content -Path $serr -Raw
    Write-Host -NoNewline $diag
    if ($LASTEXITCODE -ne 0) {
      throw "srt-win $($argv -join ' ') exited ${LASTEXITCODE}: $diag $sout"
    }
    # The result is `{paths:[…], parents:[…]}`. Callers want the
    # per-file `paths` array; `parents` (parent-dir restore
    # outcomes) is available via a direct ConvertFrom-Json if a
    # row needs it.
    if (-not $sout.Trim()) { return @() }
    $obj = $sout | ConvertFrom-Json
    return @($obj.paths)
  } finally { Remove-Item -Force $serr -ErrorAction SilentlyContinue }
}

# Run a command under `srt-win exec` and capture exit + child-only
# output (lines NOT prefixed `srt-win:`). Mirrors smoke-exec.ps1's
# Exec helper.
function ChildExec {
  param([string[]] $tail)
  # --skip-wfp-check: this script does NOT install WFP filters
  # (the network fence is orthogonal to the FS-deny tests; exec
  # is used here only to obtain a deny-only-group token). The
  # WFP pre-flight would otherwise refuse every ChildExec.
  $argv = @('exec', '--group-sid', $GroupSid, '--skip-wfp-check') + $tail
  $raw = & $Exe @argv 2>&1 | Out-String
  $exit = $LASTEXITCODE
  $lines = $raw -split "`r?`n"
  $child = ($lines | Where-Object { $_ -notmatch '^srt-win:' }) -join "`n"
  return [pscustomobject]@{ exit = $exit; raw = $raw; out = $child }
}

# This pwsh process is the stable HOLDER: production passes the
# Node-host PID so a stamp persists across the separate `acl stamp`
# and `acl restore` invocations. Here, $PID plays that role.
$Holder = $PID

# `acl stamp` reads JSON from stdin. Each invocation is its own
# short-lived `srt-win` process, but it registers $HolderPid (default
# $Holder) as the owner so the stamp persists after it exits.
function Stamp {
  param([hashtable] $payload, [int] $HolderPid = $Holder)
  $json = $payload | ConvertTo-Json -Compress
  $json | & $Exe acl stamp --group-sid $GroupSid `
    --holder-pid $HolderPid
  if ($LASTEXITCODE -ne 0) {
    throw "acl stamp exited ${LASTEXITCODE}: payload=$json"
  }
}

# Hash-ACE marker helpers. The marker is one ACCESS_DENIED_ACE
# whose SID is `S-1-0-h0-h1-…-h7` (Null SID Authority, 8×u32
# sub-auths = SHA-256(original_sd || file_id)). Read it from the
# binary SD: header(type=1,flags,size) mask(4) sid(rev=01
# subauth-count=08 idauth=000000000000 subauth[8×4]).
function Get-MarkerHash {
  param([string] $Path)
  $bin = (Get-Acl -LiteralPath $Path).GetSecurityDescriptorBinaryForm()
  $hex = ($bin | ForEach-Object { $_.ToString('x2') }) -join ''
  # Match: AceType=01 AceFlags=?? AceSize=???? Mask=00000200 (RC,
  # LE) SID rev=01 cnt=08 idauth=000000000000 + 32 hash bytes.
  # Be tolerant on flags (canonicalizers may reorder/clear them)
  # and on mask (assert it explicitly below for the canary).
  if ($hex -match '01(..)(....)(........)0108000000000000([0-9a-f]{64})') {
    return [pscustomobject]@{
      flags = [Convert]::ToByte($matches[1], 16)
      mask  = [BitConverter]::ToUInt32(
                [byte[]](-split ($matches[3] -replace '..','0x$0 ')), 0)
      hash  = $matches[4]
    }
  }
  return $null
}
function Expected-MarkerHash {
  param([byte[]] $OriginalSd, [string] $Path)
  # FILE_ID_INFO via .NET: open with no data access, read
  # VolumeSerialNumber + FileId128. PowerShell can't call
  # GetFileInformationByHandleEx directly, so shell out to a
  # tiny inline C# helper (compiled once).
  if (-not ('SrtWinSmoke.FileId' -as [type])) {
    Add-Type -TypeDefinition @'
using System;using System.IO;using System.Runtime.InteropServices;
namespace SrtWinSmoke { public static class FileId {
  [StructLayout(LayoutKind.Sequential)] struct INFO {
    public ulong vol; [MarshalAs(UnmanagedType.ByValArray,SizeConst=16)]
    public byte[] id; }
  [DllImport("kernel32",SetLastError=true)] static extern bool
    GetFileInformationByHandleEx(IntPtr h,int cls,out INFO i,int sz);
  public static byte[] Get(string p){
    using(var f=File.Open(p,FileMode.Open,FileAccess.Read,
      FileShare.ReadWrite|FileShare.Delete)){
      INFO i; if(!GetFileInformationByHandleEx(
        f.SafeFileHandle.DangerousGetHandle(),0x12,out i,24))
        throw new System.ComponentModel.Win32Exception();
      var b=new byte[24];
      Array.Copy(BitConverter.GetBytes(i.vol),0,b,0,8);
      Array.Copy(i.id,0,b,8,16); return b; }}}}
'@
  }
  $idBytes = [SrtWinSmoke.FileId]::Get($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  $h = $sha.ComputeHash($OriginalSd + $idBytes)
  return ($h | ForEach-Object { $_.ToString('x2') }) -join ''
}

# Precondition: BUILTIN\Administrators is enabled in this token,
# else the broker-only DACL would deny US too and the rows below
# would false-fail. (Same gate as smoke-exec.ps1.)
$gs = & $Exe group status --group-sid $GroupSid | ConvertFrom-Json
if ($gs.state -ne 'ready') {
  throw "smoke-acl precondition: $GroupSid must be ENABLED in this " +
        "token (got state=$($gs.state)). Run elevated."
}

try {
  # ── A1: denyRead — broker reads, child cannot ─────────────────
  $f1 = Join-Path $Scratch 'a1.txt'
  Set-Content -Path $f1 -Value 'A1-secret' -NoNewline
  Stamp @{ denyRead = @($f1) }

  # Broker (group enabled) can still read.
  $b = Get-Content -Path $f1 -Raw
  if ($b -ne 'A1-secret') { throw "A1: broker read got '$b'" }

  # Child (group deny-only) cannot. `type` exits non-zero on
  # ACCESS_DENIED. (Exit code only — the message string is
  # locale-sensitive; the binary-SD OWNER_RIGHTS check below is
  # the locale-independent ground truth that the deny landed.)
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f1`"")
  if ($r.exit -eq 0) {
    throw "A1: child read SUCCEEDED (should be denied). out: $($r.out)"
  }
  # The OWNER_RIGHTS ACE actually reached disk on the stamped
  # FILE (SetNamedSecurityInfoW silently drops a mask-0 ACE; the
  # builder uses READ_CONTROL — verify S-1-3-4 is present in the
  # binary SD and its mask excludes WRITE_DAC).
  $a1Acl = Get-Acl -LiteralPath $f1
  $a1Bin = ($a1Acl.GetSecurityDescriptorBinaryForm() |
    ForEach-Object { $_.ToString('x2') }) -join ''
  if ($a1Bin -notmatch '010100000000000304000000') {
    throw "A1(OW): OWNER_RIGHTS S-1-3-4 ACE absent from stamped " +
          "file's binary SD. SDDL: $($a1Acl.Sddl)"
  }
  $a1OwMask = ($a1Acl.Access |
    Where-Object { "$($_.IdentityReference)" -match 'OWNER|S-1-3-4' } |
    ForEach-Object { [int]$_.FileSystemRights })
  if ($a1OwMask -band 0x40000) {
    throw "A1(OW): OWNER_RIGHTS ACE on stamped file grants " +
          "WRITE_DAC (0x40000); mask=0x$($a1OwMask.ToString('x'))"
  }
  Write-Host 'A1 ok: denyRead — broker reads, child denied'

  # ── H1: hash-ACE marker round-trips on a stamped FILE ──────────
  # The CANARY for the mask-0 footgun: SetNamedSecurityInfoW and
  # .NET CommonAcl both silently drop a mask-0 ACE, so the marker
  # uses READ_CONTROL. Assert exactly one S-1-0-* deny ACE reached
  # disk, mask=0x20000, flags=0, and its 8 sub-auths ==
  # SHA-256(captured original_sd || file_id).
  $h1 = Join-Path $Scratch 'h1.txt'
  Set-Content -Path $h1 -Value 'H1' -NoNewline
  $h1Orig = (Get-Acl -LiteralPath $h1).GetSecurityDescriptorBinaryForm()
  Stamp @{ denyRead = @($h1) }
  $m = Get-MarkerHash $h1
  if (-not $m) {
    throw ("H1: hash-ACE marker did NOT reach disk on the stamped " +
           "file — the mask-0 footgun? SDDL: " +
           "$((Get-Acl -LiteralPath $h1).Sddl)")
  }
  if ($m.mask -ne 0x20000) {
    throw "H1: marker mask=0x$($m.mask.ToString('x')) (must be " +
          "READ_CONTROL 0x20000; mask-0 is silently dropped)"
  }
  if ($m.flags -ne 0) {
    throw "H1: marker flags=0x$($m.flags.ToString('x')) (must be 0, " +
          "non-inheriting)"
  }
  $h1Want = Expected-MarkerHash $h1Orig $h1
  if ($m.hash -ne $h1Want) {
    throw "H1: marker hash mismatch.`n want: $h1Want`n got:  $($m.hash)"
  }
  # marker-ace-inert: the deny-READ_CONTROL ACE for an S-1-0-*
  # SID does not affect access (no token holds an authority-0
  # 8-sub-auth SID). Broker can still read (FILE_ALL via group);
  # the marker did not break it.
  if ((Get-Content -Path $h1 -Raw) -ne 'H1') {
    throw 'H1(inert): broker read of marker-stamped file FAILED'
  }
  Write-Host ("H1 ok: hash-ACE marker on file — mask=READ_CONTROL, " +
              "flags=0, sha256(orig||file_id) round-trips")

  # ── H2: hash-ACE marker round-trips on a stamped PARENT ────────
  # The parent allow-list also carries one marker ACE; flags=0 so
  # it does NOT inherit to children (would pollute classify_sd).
  $h2Dir = Split-Path -Parent $h1
  $mP = Get-MarkerHash $h2Dir
  if (-not $mP) {
    throw ("H2: hash-ACE marker missing from stamped parent dir. " +
           "SDDL: $((Get-Acl -LiteralPath $h2Dir).Sddl)")
  }
  if ($mP.flags -ne 0) {
    throw "H2: parent marker flags=0x$($mP.flags.ToString('x')) — " +
          "must be NON-inheriting (0) so it doesn't propagate to children"
  }
  # And confirm the marker did NOT inherit: a fresh sibling has no
  # S-1-0-* ACE.
  $h2Sib = Join-Path $h2Dir 'h2-sib.txt'
  Set-Content -Path $h2Sib -Value 'x' -NoNewline
  if (Get-MarkerHash $h2Sib) {
    throw "H2: parent marker inherited to a child — would break " +
          "classify_sd. sib SDDL: $((Get-Acl -LiteralPath $h2Sib).Sddl)"
  }
  Remove-Item -Force $h2Sib
  Write-Host 'H2 ok: hash-ACE marker on parent — non-inheriting, present'

  # ── H3: escalate-marker-stable ─────────────────────────────────
  # WriteDeny then ReadDeny on the same path: the marker SID is
  # the hash of the SAME original_sd||file_id, so it must NOT
  # change across mask escalation.
  $h3 = Join-Path $Scratch 'h3.txt'
  Set-Content -Path $h3 -Value 'H3' -NoNewline
  $h3A = Start-Process -PassThru -WindowStyle Hidden cmd `
    -ArgumentList '/c','timeout','/t','120','/nobreak'
  $h3B = Start-Process -PassThru -WindowStyle Hidden cmd `
    -ArgumentList '/c','timeout','/t','120','/nobreak'
  try {
    Stamp @{ denyWrite = @($h3) } -HolderPid $h3A.Id
    $h3m1 = (Get-MarkerHash $h3).hash
    Stamp @{ denyRead = @($h3) } -HolderPid $h3B.Id
    $h3m2 = (Get-MarkerHash $h3).hash
    if ($h3m1 -ne $h3m2) {
      throw "H3: marker hash CHANGED across escalation (original_sd " +
            "was lost). before=$h3m1 after=$h3m2"
    }
    # marker-ace-inert (denyWrite side, before escalation, was
    # already covered by A2; here under denyRead the child cannot
    # read — confirming the marker does not LOOSEN access either).
    $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$h3`"")
    if ($r.exit -eq 0) { throw "H3(inert): child read after escalate" }
  } finally {
    Stop-Process -Id $h3A.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $h3B.Id -Force -ErrorAction SilentlyContinue
    & $Exe acl recover --group-sid $GroupSid 2>$null
  }
  Write-Host 'H3 ok: marker hash stable across mask escalation'

  # ── A2: denyWrite — child reads, cannot write; broker can ─────
  $f2 = Join-Path $Scratch 'a2.txt'
  Set-Content -Path $f2 -Value 'A2-readable' -NoNewline
  Stamp @{ denyWrite = @($f2) }

  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f2`"")
  if ($r.exit -ne 0 -or $r.out.Trim() -ne 'A2-readable') {
    throw "A2: child read failed (denyWrite should leave read open). " +
          "exit=$($r.exit) out=$($r.out)"
  }
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "echo nope > `"$f2`"")
  if ($r.exit -eq 0) {
    throw "A2: child WRITE succeeded (should be denied)"
  }
  # Broker can write.
  Set-Content -Path $f2 -Value 'A2-broker-wrote' -NoNewline
  if ((Get-Content -Path $f2 -Raw) -ne 'A2-broker-wrote') {
    throw 'A2: broker write did not stick'
  }
  Write-Host 'A2 ok: denyWrite — child reads, child denied write, broker writes'

  # Regression: A2's `Stamp` was a SECOND register_broker for the
  # same $Holder; A1's hold on f1 must survive (UPSERT, not REPLACE).
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f1`"")
  if ($r.exit -eq 0) {
    throw "A2(reg): A1's hold on f1 was DROPPED by A2's second " +
          "register_broker (CASCADE) — sandbox escape. out: $($r.out)"
  }
  Write-Host 'A2(reg) ok: second stamp by same holder kept earlier holds'

  # ── A17: parent allow-list — child cannot delete/rename stamped ─
  # The PRIMARY delete/rename protection: `acl stamp` stamped
  # $Scratch (the parent of f1/f2) with the FDC-removing
  # allow-list. The child gets Modify-without-FILE_DELETE_CHILD
  # on the parent, so it cannot delete or rename-over a child of
  # this directory via the parent's FDC; and the protected files'
  # broker-only DACLs withhold file-level DELETE — so the child
  # has no path to delete/rename them. NO --holder-pid here: the
  # parent stamp is on-disk, not a per-exec handle.
  $sib17 = Join-Path $Scratch 'a17-sibling.txt'
  Set-Content -Path $sib17 -Value 'SIB' -NoNewline
  $imp17 = Join-Path $Scratch 'a17-impostor.txt'
  Set-Content -Path $imp17 -Value 'IMPOSTOR' -NoNewline
  # Child tries to delete the denyRead-stamped f1 — must FAIL.
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "del /f /q `"$f1`"")
  if (-not (Test-Path $f1) -or
      (Get-Content -Path $f1 -Raw) -ne 'A1-secret') {
    throw "A17: child del of stamped f1 SUCCEEDED (parent " +
          "allow-list ineffective). raw: $($r.raw)"
  }
  # Child tries to move impostor over the denyWrite-stamped f2 —
  # must FAIL, f2 content unchanged.
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c',
                   "move /y `"$imp17`" `"$f2`"")
  if ((Get-Content -Path $f2 -Raw) -ne 'A2-broker-wrote') {
    throw "A17: child move-over of stamped f2 SUCCEEDED. " +
          "got: '$((Get-Content -Path $f2 -Raw))' raw: $($r.raw)"
  }
  # Child CAN delete its own non-protected sibling: it inherits
  # user:Modify (with file-level DELETE 0x10000) from the parent
  # allow-list, and the sibling has no broker-only DACL.
  #
  # Ground-truth instrumentation — captures everything needed to
  # diagnose if this assertion fails: parent + sibling effective
  # SDDL, sibling owner, the user SID srt-win wrote into the
  # parent allow-list (the 0x1301bf ACE), and the child token's
  # actual user/groups. Printed unconditionally and included in
  # the throw.
  $a17ParentAcl = Get-Acl -LiteralPath $Scratch
  $a17SibAcl    = Get-Acl -LiteralPath $sib17
  $a17UserAce   = ($a17ParentAcl.Sddl |
    Select-String '\(A;OICI;0x[0-9a-fA-F]+;;;[^)]+\)').Matches.Value
  # OWNER_RIGHTS ACE present (regression guard: a mask-0 ACE is
  # silently dropped by SetNamedSecurityInfoW, so the builder
  # uses READ_CONTROL — verify S-1-3-4 is in the binary SD).
  $a17OwAce = ($a17ParentAcl.Access |
    Where-Object { "$($_.IdentityReference)" -match 'OWNER|S-1-3-4' } |
    ForEach-Object {
      "$($_.IdentityReference)=$($_.FileSystemRights)/$($_.AccessControlType)"
    }) -join ', '
  $a17BinSd = ($a17ParentAcl.GetSecurityDescriptorBinaryForm() |
    ForEach-Object { $_.ToString('x2') }) -join ''
  # SID S-1-3-4 in binary: rev=01 subauth-count=01 idauth=000000000003
  # subauth[0]=04000000 → "0101000000000003 04000000".
  $a17OwInBin = $a17BinSd -match '010100000000000304000000'
  $a17Diag = @(
    "parent SDDL:    $($a17ParentAcl.Sddl)"
    "parent user-ACE:$a17UserAce"
    "parent OW-ACE:  $(if ($a17OwAce) { $a17OwAce } else { '<none in .Access>' })"
    "parent binSD has S-1-3-4: $a17OwInBin"
    "sibling SDDL:   $($a17SibAcl.Sddl)"
    "sibling owner:  $($a17SibAcl.Owner)"
  )
  $a17Diag | ForEach-Object { Write-Host "A17 $_" }
  $rWho = ChildExec @('--', $cmd, '/d', '/s', '/c',
                      'whoami /user /groups /fo list')
  Write-Host "A17 child token (whoami):"
  $rWho.out -split "`n" | ForEach-Object { Write-Host "  $_" }
  # Attempt 1 — cmd `del` (DeleteFileW; /f also touches attrs).
  # `/v:on` + `!errorlevel!` (delayed expansion): with `&` on one
  # line, `%errorlevel%` is parse-time-expanded BEFORE `del` runs
  # and would always print 0.
  $rDel = ChildExec @('--', $cmd, '/v:on', '/d', '/s', '/c',
    "del /f /q `"$sib17`" 2>&1 & echo DEL_EXIT=!errorlevel!")
  Write-Host "A17 child del:    $($rDel.out.Trim())"
  # Attempt 2 — PowerShell Remove-Item (different open path; if
  # this succeeds where `del` fails, it's the cmd-builtin's
  # access mask, not the DACL).
  $rRm = ChildExec @('--', $pwsh, '-NoProfile', '-Command',
    "try { Remove-Item -LiteralPath '$sib17' -Force -ErrorAction Stop; " +
    "'RM_OK' } catch { 'RM_ERR: ' + `$_.Exception.Message }")
  Write-Host "A17 child Remove-Item: $($rRm.out.Trim())"
  if (Test-Path $sib17) {
    throw ("A17: child could NOT delete its non-protected sibling " +
           "(parent allow-list over-restricted; user should still " +
           "have file-level DELETE on inherited Modify).`n" +
           ($a17Diag -join "`n") +
           "`nchild whoami: $($rWho.out)" +
           "`nchild del:    $($rDel.out.Trim())" +
           "`nchild rm:     $($rRm.out.Trim())")
  }
  # And the file ACL is still doing its job: child read of f1
  # still denied.
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f1`"")
  if ($r.exit -eq 0) {
    throw "A17: child read of f1 allowed after del attempt. out: $($r.out)"
  }
  Remove-Item -Force $imp17 -ErrorAction SilentlyContinue
  Write-Host ('A17 ok: parent allow-list — child denied del/rename of ' +
              'stamped files; CAN delete non-protected sibling')

  # ── A21: parent OWNER_RIGHTS — child cannot WRITE_DAC parent ──
  # The OWNER_RIGHTS ACE on the parent suppresses the implicit
  # READ_CONTROL|WRITE_DAC the kernel grants the owner. Without
  # it, an owner-child could `icacls /grant` itself FDC on the
  # parent and re-open the delete/rename gap A17 just closed.
  if (-not $a17OwInBin) {
    throw "A21: OWNER_RIGHTS S-1-3-4 ACE absent from parent's binary " +
          "SD — the OW guard is not on disk. parent SDDL: " +
          "$($a17ParentAcl.Sddl)"
  }
  # The OW ACE's mask must exclude WRITE_DAC (0x40000) — the
  # whole point of the ACE.
  $a21OwMask = ($a17ParentAcl.Access |
    Where-Object { "$($_.IdentityReference)" -match 'OWNER|S-1-3-4' } |
    ForEach-Object { [int]$_.FileSystemRights })
  Write-Host "A21 parent OW mask: 0x$($a21OwMask.ToString('x'))"
  if ($a21OwMask -band 0x40000) {
    throw "A21: parent OWNER_RIGHTS ACE grants WRITE_DAC " +
          "(mask=0x$($a21OwMask.ToString('x'))). SDDL: $($a17ParentAcl.Sddl)"
  }
  $a21Me = "$env:USERDOMAIN\$env:USERNAME"
  # `/v:on` + `!errorlevel!`: with `%errorlevel%` cmd would expand
  # at parse time (always 0) and the exit-code check would be a
  # tautology, leaving only the locale-sensitive string match.
  $r = ChildExec @('--', $cmd, '/v:on', '/d', '/s', '/c',
    "icacls `"$Scratch`" /grant `"${a21Me}:(F)`" 2>&1 & " +
    "echo ICACLS_EXIT=!errorlevel!")
  if ($r.out -match 'ICACLS_EXIT=0') {
    throw ("A21: child icacls /grant on stamped parent SUCCEEDED — " +
           "OWNER_RIGHTS not suppressing owner WRITE_DAC. " +
           "out: $($r.out)`nparent SDDL: $($a17ParentAcl.Sddl)")
  }
  # And confirm the parent DACL was NOT modified.
  if ((Get-Acl -LiteralPath $Scratch).Sddl -ne $a17ParentAcl.Sddl) {
    throw "A21: parent DACL was modified by child's icacls. " +
          "before: $($a17ParentAcl.Sddl) " +
          "after:  $((Get-Acl -LiteralPath $Scratch).Sddl)"
  }
  Write-Host ('A21 ok: OWNER_RIGHTS on parent — child cannot ' +
              'WRITE_DAC the directory')

  # exec --holder-pid with all parents stamped → fence has nothing
  # to do (0-path fallback).
  $r = ChildExec @('--holder-pid', $Holder, '--', $cmd, '/d', '/s', '/c',
                   'echo NOFENCE')
  if ($r.raw -notmatch 'parent stamps cover all') {
    throw "A17(diag): expected '0 path(s) (parent stamps cover all)'; " +
          "raw: $($r.raw)"
  }
  Write-Host 'A17(diag) ok: fence fallback set is empty when parent stamped'

  # ── A3: restore → child can read again ────────────────────────
  Run @('acl', 'restore', '--group-sid', $GroupSid,
        '--holder-pid', $Holder)
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f1`"")
  if ($r.exit -ne 0 -or $r.out.Trim() -ne 'A1-secret') {
    throw "A3: child read after restore failed. exit=$($r.exit) out=$($r.out)"
  }
  Write-Host 'A3 ok: restore — child reads denyRead file again'

  # ── A4: refcount — two live holders, two restores ─────────────
  # Two DIFFERENT holder PIDs claim the same path (modelling two
  # concurrent sandbox sessions). Restoring one leaves the file
  # stamped (the other still holds); restoring the second restores.
  # Holder B is a real, still-alive process so crash-recovery does
  # NOT prematurely reap it.
  $f4 = Join-Path $Scratch 'a4.txt'
  Set-Content -Path $f4 -Value 'A4' -NoNewline
  $holderB = Start-Process -FilePath $pwsh `
    -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 120') `
    -PassThru
  try {
    Stamp @{ denyRead = @($f4) } $Holder        # holder A
    Stamp @{ denyRead = @($f4) } $holderB.Id    # holder B (alive)

    # Restore A → B still holds → file stays stamped → child denied.
    Run @('acl', 'restore', '--group-sid', $GroupSid,
          '--holder-pid', $Holder)
    $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f4`"")
    if ($r.exit -eq 0) {
      throw "A4: file unstamped after only one of two holders released"
    }
    # Restore B → refcount 0 → restored → child reads.
    Run @('acl', 'restore', '--group-sid', $GroupSid,
          '--holder-pid', $holderB.Id)
    $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f4`"")
    if ($r.exit -ne 0) {
      throw "A4: file still stamped after both holders released. " +
            "exit=$($r.exit) out=$($r.out)"
    }
    Write-Host 'A4 ok: refcount — two live holders, restore only on last release'
  }
  finally {
    Stop-Process -Id $holderB.Id -Force -ErrorAction SilentlyContinue
  }

  # ── A5: crash recovery via `acl recover` ──────────────────────
  # A holder process stamps then DIES without restoring. `acl
  # recover` from another process prunes the dead holder and
  # restores the orphan.
  $f5 = Join-Path $Scratch 'a5.txt'
  Set-Content -Path $f5 -Value 'A5' -NoNewline
  # Spawn a short-lived holder, capture its PID, let it exit.
  $holderC = Start-Process -FilePath $pwsh `
    -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 1') -PassThru
  Stamp @{ denyRead = @($f5) } $holderC.Id
  $holderC.WaitForExit()   # holder C is now dead

  # Confirm child IS denied (stamp took effect, holder dead but
  # snapshot persists).
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f5`"")
  if ($r.exit -eq 0) { throw 'A5: stamp did not take effect' }

  Run @('acl', 'recover', '--group-sid', $GroupSid)
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f5`"")
  if ($r.exit -ne 0) {
    throw "A5: still stamped after recover. exit=$($r.exit) out=$($r.out)"
  }
  Write-Host 'A5 ok: acl recover — orphan from dead holder restored'

  # ── A6: state-DB dir is broker-only ──────────────────────
  if (-not (Test-Path $stateDb)) {
    throw "A6: state.db not at $stateDb"
  }
  # Child cannot write to the DB file (broker-only DACL on the
  # parent dir inherits via (OI)(CI)).
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "echo x >> `"$stateDb`"")
  if ($r.exit -eq 0) {
    throw 'A6: child WROTE to state.db (S2 dir stamp ineffective)'
  }
  Write-Host 'A6 ok: child denied write to state.db'

  # ── A7: directory in payload → clear error ────────────────────
  $json7 = @{ denyRead = @($Scratch) } | ConvertTo-Json -Compress
  $out7 = $json7 | & $Exe acl stamp --group-sid $GroupSid `
    --holder-pid $Holder 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { throw 'A7: directory was accepted' }
  if ($out7 -notmatch '(?i)requires explicit file paths') {
    throw "A7: wrong error message: $out7"
  }
  Write-Host 'A7 ok: directory in payload rejected with clear message'

  # ── A8: glob in payload → clear error ─────────────────────────
  $json8 = @{ denyRead = @("$Scratch\*.txt") } | ConvertTo-Json -Compress
  $out8 = $json8 | & $Exe acl stamp --group-sid $GroupSid `
    --holder-pid $Holder 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { throw 'A8: glob was accepted' }
  if ($out8 -notmatch '(?i)got glob') {
    throw "A8: wrong error message: $out8"
  }
  Write-Host 'A8 ok: glob in payload rejected with clear message'

  # ── A9: restore fidelity on an explicit-ACE, UNPROTECTED file ─
  # A1–A3 only touched purely-inherited files. This covers the
  # branch where the original DACL has an explicit ACE but is NOT
  # protected (still auto-inheriting): restore must bring back the
  # explicit ACE AND keep AreAccessRulesProtected = false (our
  # stamp forces PROTECTED; restore must undo that).
  $f9 = Join-Path $Scratch 'a9.txt'
  Set-Content -Path $f9 -Value 'A9' -NoNewline
  # Add an explicit grant for BUILTIN\Users WITHOUT breaking
  # inheritance (no /inheritance:d), so the file stays unprotected.
  & icacls $f9 /grant '*S-1-5-32-545:(R)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'A9: icacls grant failed' }
  $aclBefore = Get-Acl -Path $f9
  if ($aclBefore.AreAccessRulesProtected) {
    throw 'A9: precondition — file should be UNPROTECTED before stamp'
  }
  $sddlBefore = $aclBefore.Sddl

  Stamp @{ denyRead = @($f9) }
  # While stamped it must be protected + child-denied.
  if (-not (Get-Acl -Path $f9).AreAccessRulesProtected) {
    throw 'A9: stamp should have set PROTECTED'
  }
  Run @('acl', 'restore', '--group-sid', $GroupSid,
        '--holder-pid', $Holder)

  $aclAfter = Get-Acl -Path $f9
  if ($aclAfter.AreAccessRulesProtected) {
    throw 'A9: restore left file PROTECTED (should be unprotected)'
  }
  if ($aclAfter.Sddl -ne $sddlBefore) {
    throw "A9: restored SDDL differs.`n before: $sddlBefore`n after:  $($aclAfter.Sddl)"
  }
  Write-Host 'A9 ok: restore is bit-exact for explicit-unprotected file'

  # ── A10: third-party edit → classify=Unstamped → leftChanged ──
  # Stamp a file, then a third party (icacls /reset) rewrites its
  # DACL to something that is NOT broker-shaped. classify_sd →
  # Unstamped; cur ≠ row.original_sd → restore reports
  # leftChanged and does NOT revert. `recover --force` then DOES.
  $f10 = Join-Path $Scratch 'a10.txt'
  Set-Content -Path $f10 -Value 'A10' -NoNewline
  $sddl10Orig = (Get-Acl -Path $f10).Sddl
  Stamp @{ denyRead = @($f10) }
  & icacls $f10 /reset | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'A10: icacls /reset failed' }
  & icacls $f10 /grant '*S-1-5-32-545:(F)' | Out-Null
  $sddl10Edited = (Get-Acl -Path $f10).Sddl

  $j10 = RunJson @('acl', 'restore', '--group-sid', $GroupSid,
                   '--holder-pid', $Holder, '--json')
  $e10 = $j10 | Where-Object { $_.path -like "*a10.txt" }
  if (-not $e10 -or $e10.status -ne 'leftChanged') {
    throw "A10: expected status=leftChanged for a third-party-edited " +
          "DACL; got: $($j10 | ConvertTo-Json -Compress)"
  }
  if ((Get-Acl -Path $f10).Sddl -ne $sddl10Edited) {
    throw 'A10: restore reverted a third-party-edited DACL (should leave)'
  }
  Run @('acl', 'recover', '--group-sid', $GroupSid, '--force')
  $noAI = { param($s) $s -replace '(?<=D:)(P?)AI', '$1' }
  if ((& $noAI (Get-Acl -Path $f10).Sddl) -ne (& $noAI $sddl10Orig)) {
    throw "A10: --force did not restore original"
  }
  Write-Host 'A10 ok: Unstamped-but-changed → leftChanged; --force reverts'

  # ── A11/A12 use their own fresh subdir, decoupled from $Scratch's
  # parent-stamp lifecycle (A1-A10 stamp/restore $Scratch repeatedly;
  # `icacls /inheritance:r` on a child of a directory that just went
  # PROTECTED→UNPROTECTED can produce an empty DACL — an icacls
  # quirk, not our bug, but it makes A11's setup non-deterministic).
  $d11 = Join-Path $Scratch 'd11'
  New-Item -ItemType Directory -Path $d11 | Out-Null

  # ── A11: PROTECTED original → restore is bit-exact ─────────────
  # Set up a file with an explicit PROTECTED DACL (via .NET
  # SetAccessRuleProtection — copies inherited ACEs to explicit and
  # sets PROTECTED), stamp, restore. The `was_protected=true` arm of
  # restore_sd must round-trip the SDDL exactly — including the
  # PROTECTED bit.
  $f11 = Join-Path $d11 'a11.txt'
  Set-Content -Path $f11 -Value 'A11' -NoNewline
  $sd11 = Get-Acl -LiteralPath $f11
  $sd11.SetAccessRuleProtection($true, $true)
  Set-Acl -LiteralPath $f11 -AclObject $sd11
  $acl11 = Get-Acl -LiteralPath $f11
  if (-not $acl11.AreAccessRulesProtected) {
    throw 'A11 setup: file should be PROTECTED after SetAccessRuleProtection'
  }
  if ($acl11.Access.Count -eq 0) {
    throw "A11 setup: empty DACL after SetAccessRuleProtection " +
          "(d11 SDDL: $((Get-Acl -LiteralPath $d11).Sddl))"
  }
  $sddl11Orig = $acl11.Sddl
  Stamp @{ denyRead = @($f11) }
  Run @('acl', 'restore', '--group-sid', $GroupSid,
        '--holder-pid', $Holder)
  $sddl11After = (Get-Acl -LiteralPath $f11).Sddl
  if (-not (Get-Acl -LiteralPath $f11).AreAccessRulesProtected) {
    throw 'A11: PROTECTED bit lost on restore'
  }
  if ($sddl11After -ne $sddl11Orig) {
    throw "A11: SDDL not bit-exact.`n want: $sddl11Orig`n got:  $sddl11After"
  }
  Write-Host 'A11 ok: PROTECTED original round-trips bit-exact'

  # ── A12: restore-when-already-original drops stale row ─────────
  # Stamp, then manually put the DACL back to the original (Set-Acl
  # with the captured SDDL); `acl restore` should hit Case A
  # (cur == original) — drop the row, no "DACL changed" warning.
  # The file is made PROTECTED (explicit ACEs only) BEFORE
  # capturing the original, so the original is stable regardless
  # of d11's parent-stamp state — otherwise Set-Acl would
  # re-derive inherited ACEs from d11's CURRENT (stamped) state
  # and on-disk would never match the captured original.
  $f12 = Join-Path $d11 'a12.txt'
  Set-Content -Path $f12 -Value 'A12' -NoNewline
  $sd12 = Get-Acl -LiteralPath $f12
  $sd12.SetAccessRuleProtection($true, $true)
  Set-Acl -LiteralPath $f12 -AclObject $sd12
  if ((Get-Acl -LiteralPath $f12).Access.Count -eq 0) {
    throw 'A12 setup: empty DACL after SetAccessRuleProtection'
  }
  $a12Orig = Get-Acl -LiteralPath $f12
  Stamp @{ denyRead = @($f12) }
  Set-Acl -LiteralPath $f12 -AclObject $a12Orig
  # classify_sd → Unstamped; cur.equiv(original_sd) → drop row
  # silently (status=restored, no leftChanged).
  $j12 = RunJson @('acl', 'restore', '--group-sid', $GroupSid,
                   '--holder-pid', $Holder, '--json')
  $e12 = $j12 | Where-Object { $_.path -like "*a12.txt" }
  if (-not $e12 -or $e12.status -ne 'restored') {
    throw "A12: cur==original should drop row silently " +
          "(status=restored); got: $($j12 | ConvertTo-Json -Compress)"
  }
  Write-Host 'A12 ok: classify=Unstamped + cur==original → row dropped'

  # ── A13: mask escalation (denyWrite then denyRead → read denied) ─
  $f13 = Join-Path $Scratch 'a13.txt'
  Set-Content -Path $f13 -Value 'A13' -NoNewline
  $holderA = Start-Process -PassThru -WindowStyle Hidden cmd `
    -ArgumentList '/c','timeout','/t','120','/nobreak'
  $holderB = Start-Process -PassThru -WindowStyle Hidden cmd `
    -ArgumentList '/c','timeout','/t','120','/nobreak'
  try {
    Stamp @{ denyWrite = @($f13) } -HolderPid $holderA.Id
    # Under WriteDeny, child can read.
    $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f13`"")
    if ($r.exit -ne 0 -or $r.out.Trim() -ne 'A13') {
      throw "A13 setup: child read under denyWrite failed. out=$($r.out)"
    }
    # Holder B requests STRICTER denyRead on the same path → escalate.
    Stamp @{ denyRead = @($f13) } -HolderPid $holderB.Id
    $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f13`"")
    if ($r.exit -eq 0) {
      throw "A13: stricter denyRead NOT applied (mask escalation " +
            "ignored) — child read SUCCEEDED. out: $($r.out)"
    }
  } finally {
    # Kill FIRST, then non-throwing restore: a throwing `Run`
    # inside finally would abort before Kill() and (a) leak both
    # 120s holders, (b) replace the original assertion message.
    Stop-Process -Id $holderA.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $holderB.Id -Force -ErrorAction SilentlyContinue
    & $Exe acl recover --group-sid $GroupSid 2>$null
  }
  Write-Host 'A13 ok: denyWrite then denyRead on same path → read denied'

  # ── A14: deleted-file orphan → status=missing, row KEPT ────────
  # A stamped file is deleted (broker side) and its holder dies.
  # `acl recover --json` reports it as `missing` (file_id not
  # locatable on the volume) and KEEPS the snapshot row
  # (fail-closed orphan tracking) — it does NOT silently reap.
  $f14 = Join-Path $Scratch 'a14.txt'
  Set-Content -Path $f14 -Value 'A14' -NoNewline
  $holderD = Start-Process -PassThru -WindowStyle Hidden cmd `
    -ArgumentList '/c','timeout','/t','120','/nobreak'
  try {
    Stamp @{ denyRead = @($f14) } -HolderPid $holderD.Id
    Remove-Item -Force $f14
  } finally {
    Stop-Process -Id $holderD.Id -Force -ErrorAction SilentlyContinue
  }
  $holderD.WaitForExit()
  $j = RunJson @('acl', 'recover', '--group-sid', $GroupSid, '--json')
  $e14 = $j | Where-Object { $_.path -like "*a14.txt" }
  if (-not $e14 -or $e14.status -ne 'missing' -or
      $e14.leftStamped -ne $true) {
    throw "A14: expected status=missing leftStamped=true; got: " +
          "$($j | ConvertTo-Json -Compress)"
  }
  # Row STAYS — a second recover still reports it.
  $j2 = RunJson @('acl', 'recover', '--group-sid', $GroupSid, '--json')
  if (-not ($j2 | Where-Object { $_.path -like "*a14.txt" })) {
    throw "A14: orphan row was DROPPED on a second recover " +
          "(fail-closed: row must persist for the host to surface)"
  }
  Write-Host 'A14 ok: deleted-file orphan → status=missing, row kept'

  # ── A15/A16: fence FALLBACK — parent-stamp-fail file is fenced ─
  # The parent allow-list is the primary delete protection. When
  # a file's parent allow-list isn't sufficient on its own, that
  # file is marked `parent_stamp_failed` and the per-exec handle
  # fence covers it as the fallback. Route to the fence via the
  # hardlink-detect path (no test-only env var needed): a second
  # name on the inode means the allow-list on ONE parent can't
  # close delete/rename via the OTHER name, so stamp routes the
  # file straight to the fence (NumberOfLinks > 1 → force_fence).
  # This is also the only end-to-end coverage of that detect.
  $d15 = Join-Path $Scratch 'a15-noparent'
  New-Item -ItemType Directory -Path $d15 | Out-Null
  $f15 = Join-Path $d15 'fb.txt'
  Set-Content -Path $f15 -Value 'A15' -NoNewline
  New-Item -ItemType HardLink -Path (Join-Path $d15 'fb-link.txt') `
    -Target $f15 | Out-Null
  $stampOut = @{ denyRead = @($f15) } | ConvertTo-Json -Compress |
    & $Exe acl stamp --group-sid $GroupSid --holder-pid $Holder 2>&1 |
    Out-String
  Write-Host -NoNewline $stampOut
  if ($LASTEXITCODE -ne 0) { throw "A15: stamp failed: $stampOut" }
  if ($stampOut -notmatch '(?i)2 hardlink') {
    throw "A15: hardlink-detect did not fire (expected " +
          "'has 2 hardlink(s)'). stamp out: $stampOut"
  }
  if ($stampOut -notmatch '1 parent-stamp fallback') {
    throw "A15: parent-stamp fallback not engaged. stamp out: $stampOut"
  }
  # exec --holder-pid → fence engages on f15 only.
  $r = ChildExec @('--holder-pid', $Holder, '--', $cmd, '/d', '/s', '/c',
                   "del /f /q `"$f15`"")
  $diag15 = ($r.raw -split "`r?`n" |
             Where-Object {$_ -match 'handle fence'}) -join ' | '
  if ($diag15 -notmatch '[1-9]\d* parent-stamp-failed path\(s\) fenced') {
    throw "A15: fallback fence diag did not report ≥1 fenced. " +
          "raw: $($r.raw)"
  }
  if (-not (Test-Path $f15) -or
      (Get-Content -Path $f15 -Raw) -ne 'A15') {
    throw "A15: child del of fallback-fenced f15 SUCCEEDED. raw: $($r.raw)"
  }
  Write-Host 'A15 ok: parent-stamp-failed file is handle-fenced (fallback)'

  # A16 (load-bearing on the fallback set): hold f15 no-share so
  # the fence open hits SHARING_VIOLATION → retries exhaust →
  # exec refuses; release → exec succeeds.
  $hold = [IO.File]::Open($f15, 'Open', 'Read', 'None')
  try {
    $r = ChildExec @('--holder-pid', $Holder, '--', $cmd, '/d', '/s', '/c',
                     'echo SENTINEL')
    if ($r.exit -eq 0 -or $r.out -match 'SENTINEL' -or
        $r.raw -notmatch 'refusing to run') {
      throw "A16: exec ran with an unfenceable fallback path. " +
            "raw: $($r.raw)"
    }
  } finally { $hold.Close() }
  $r = ChildExec @('--holder-pid', $Holder, '--', $cmd, '/d', '/s', '/c',
                   'echo SENTINEL')
  if ($r.exit -ne 0 -or $r.out -notmatch 'SENTINEL') {
    throw "A16: exec did not succeed after release. raw: $($r.raw)"
  }
  # Restore (clears the fallback row).
  Run @('acl', 'restore', '--group-sid', $GroupSid, '--holder-pid', $Holder)
  Write-Host 'A16 ok: fallback fence load-bearing — refuses on share-fail'

  # ── A18: deep tree — ancestor rmdir cannot remove protected file ─
  $d18 = Join-Path $Scratch 'a18'
  $d18b = Join-Path $d18 'b'
  New-Item -ItemType Directory -Path $d18b -Force | Out-Null
  $f18 = Join-Path $d18b 'prot.txt'
  Set-Content -Path $f18 -Value 'A18' -NoNewline
  Stamp @{ denyRead = @($f18) }
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "rmdir /s /q `"$d18`"")
  if (-not (Test-Path $f18) -or
      (Get-Content -Path $f18 -Raw) -ne 'A18') {
    throw "A18: protected file removed by ancestor rmdir /s. raw: $($r.raw)"
  }
  Run @('acl', 'restore', '--group-sid', $GroupSid, '--holder-pid', $Holder)
  Write-Host 'A18 ok: ancestor rmdir /s cannot remove protected file'

  # ── A19: relocation — DACL travels; restore → relocated ────────
  # Stamp a file in its OWN subdir, then (broker side) MOVE it
  # elsewhere. The broker-only DACL travels with the inode, so
  # the child is still denied at the NEW location — protection
  # is sticky to the data, not the path. `acl restore --json`
  # reports `relocated` with `movedTo`, leaves the stamp, and
  # keeps the row (fail-closed; never restore by inode).
  $d19 = Join-Path $Scratch 'a19'
  New-Item -ItemType Directory -Path $d19 | Out-Null
  $f19 = Join-Path $d19 'cookies.txt'
  Set-Content -Path $f19 -Value 'A19-secret' -NoNewline
  Stamp @{ denyRead = @($f19) }
  $f19m = Join-Path $Scratch 'a19-moved.txt'
  Move-Item -Force -Path $f19 -Destination $f19m
  # Child read at the NEW path → still denied (DACL traveled).
  $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "type `"$f19m`"")
  if ($r.exit -eq 0) {
    throw "A19: child read of relocated file SUCCEEDED — DACL did " +
          "not travel with the inode. out: $($r.out)"
  }
  $j = RunJson @('acl', 'restore', '--group-sid', $GroupSid,
                 '--holder-pid', $Holder, '--json')
  $e19 = $j | Where-Object { $_.path -like "*cookies.txt" }
  if (-not $e19 -or $e19.status -ne 'relocated' -or
      $e19.leftStamped -ne $true -or
      $e19.movedTo -notlike "*a19-moved.txt") {
    throw "A19: expected status=relocated movedTo=*a19-moved.txt " +
          "leftStamped=true; got: $($j | ConvertTo-Json -Compress)"
  }
  # Stamp left in place (fail-closed): file at movedTo is STILL
  # broker-only after restore.
  if (-not (Get-Acl -Path $f19m).AreAccessRulesProtected) {
    throw "A19: relocated file is NOT still protected after restore"
  }
  # Move it back to the recorded path, restore again → restored.
  Move-Item -Force -Path $f19m -Destination $f19
  # The previous restore unregistered $Holder; re-register by
  # The Relocated outcome kept the snapshot row but the previous
  # restore unregistered $Holder — re-stamp to re-add the hold.
  Stamp @{ denyRead = @($f19) }
  $j = RunJson @('acl', 'restore', '--group-sid', $GroupSid,
                 '--holder-pid', $Holder, '--json')
  $e19b = $j | Where-Object { $_.path -like "*cookies.txt" }
  if (-not $e19b -or $e19b.status -ne 'restored') {
    throw "A19: after move-back, expected status=restored; got: " +
          "$($j | ConvertTo-Json -Compress)"
  }
  Write-Host ('A19 ok: relocated file stays denied; restore reports ' +
              'relocated+movedTo, leaves stamp; move-back → restored')

  # ── A20: path substitution — restore does NOT touch impostor ───
  # Stamp a file, then (broker side) DELETE it and create a NEW
  # file at the same path. file_id differs → restore reports
  # `missing` (the original is gone), keeps the row, and does
  # NOT touch the impostor's DACL.
  $d20 = Join-Path $Scratch 'a20'
  New-Item -ItemType Directory -Path $d20 | Out-Null
  $f20 = Join-Path $d20 'sub.txt'
  Set-Content -Path $f20 -Value 'A20-original' -NoNewline
  Stamp @{ denyRead = @($f20) }
  Remove-Item -Force $f20
  Set-Content -Path $f20 -Value 'A20-impostor' -NoNewline
  $sddl20Imp = (Get-Acl -Path $f20).Sddl
  $j = RunJson @('acl', 'restore', '--group-sid', $GroupSid,
                 '--holder-pid', $Holder, '--json')
  $e20 = $j | Where-Object { $_.path -like "*sub.txt" }
  if (-not $e20 -or $e20.status -notin @('missing', 'relocated') -or
      $e20.leftStamped -ne $true) {
    throw "A20: expected status∈{missing,relocated} leftStamped=true; " +
          "got: $($j | ConvertTo-Json -Compress)"
  }
  if ((Get-Acl -Path $f20).Sddl -ne $sddl20Imp) {
    throw "A20: impostor's DACL was modified by restore (must not " +
          "touch a file whose file_id differs from the snapshot)"
  }
  Write-Host ('A20 ok: path-substituted impostor untouched; ' +
              'restore reports missing/relocated, row kept')

  # ── A22: parent restore must not clobber third-party edits ───
  # The PARENT-restore path uses the same disk-is-truth case
  # analysis as files: classify_sd → Unstamped (admin edit moved
  # the DACL away from the allow-list shape) and cur ≠
  # row.original_sd → LeftChanged, dir untouched.
  $d22 = Join-Path $Scratch 'a22'
  New-Item -ItemType Directory -Path $d22 | Out-Null
  $f22 = Join-Path $d22 'inside.txt'
  Set-Content -Path $f22 -Value 'A22' -NoNewline
  $sddl22Before = (Get-Acl -LiteralPath $d22).Sddl
  Stamp @{ denyRead = @($f22) }
  $sddl22Stamped = (Get-Acl -LiteralPath $d22).Sddl
  if ($sddl22Stamped -eq $sddl22Before) {
    throw "A22 setup: parent stamp did not change the dir's DACL"
  }
  # Third-party edit: add an explicit ACE that is in neither the
  # original nor the allow-list stamp. The parent stamp sets
  # PROTECTED, but that only blocks inheritance — an explicit
  # /grant goes through.
  icacls $d22 /grant 'NT AUTHORITY\Authenticated Users:(RX)' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "A22 setup: icacls /grant failed (exit $LASTEXITCODE)"
  }
  $sddl22Edited = (Get-Acl -LiteralPath $d22).Sddl
  if ($sddl22Edited -eq $sddl22Stamped) {
    throw "A22 setup: third-party edit produced no SDDL change " +
          "($sddl22Edited)"
  }
  # Restore. The parent's current DACL no longer equals the
  # recorded stamped_sd → the parent restore must LEAVE IT
  # (not blind-write original_sd). The AU:(RX) ACE must survive.
  $sout22 = & $Exe acl restore --group-sid $GroupSid `
              --holder-pid $Holder --json | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "A22: acl restore exited ${LASTEXITCODE}: $sout22"
  }
  $j22 = $sout22 | ConvertFrom-Json
  $sddl22After = (Get-Acl -LiteralPath $d22).Sddl
  $a22Au = (Get-Acl -LiteralPath $d22).Access | Where-Object {
    "$($_.IdentityReference)" -match '(?i)Authenticated Users|S-1-5-11'
  }
  if (-not $a22Au) {
    throw ("A22: parent restore CLOBBERED a third-party ACL " +
           "edit — the AU:(RX) ACE added between stamp and " +
           "restore is gone. The parent-restore path must classify " +
           "the live DACL (marker present + extra ACE → " +
           "StampedUnrecognized → leftStamped, fail-closed) before " +
           "writing original_sd back.`n" +
           "  before-stamp:  $sddl22Before`n" +
           "  after-stamp:   $sddl22Stamped`n" +
           "  after-edit:    $sddl22Edited`n" +
           "  after-restore: $sddl22After`n" +
           "  parents[]:     $($j22.parents | ConvertTo-Json -Compress)")
  }
  $p22 = $j22.parents | Where-Object { $_.path -like "*a22*" }
  if (-not $p22 -or $p22.status -ne 'leftStamped' -or
      $p22.error -ne 'stamped_unrecognized') {
    throw ("A22: expected parents[].{status='leftStamped', " +
           "error='stamped_unrecognized'} for the edited dir " +
           "(marker survives the icacls /grant, so classify_sd → " +
           "StampedUnrecognized → fail-closed); got: " +
           "$($j22.parents | ConvertTo-Json -Compress)")
  }
  Write-Host ('A22 ok: parent restore left a third-party-edited ' +
              "DACL alone → stamped_unrecognized, leftStamped; " +
              "parents[]: $($j22.parents | ConvertTo-Json -Compress)")
  # The A22 row deliberately leaves $d22 with a non-original
  # DACL (leftStamped keeps the row). The finally-block's
  # `recover --force` will clear it.

  # ── A23: child cannot rename a stamped parent dir ────────────
  # The parent allow-list strips FILE_DELETE_CHILD from the dir,
  # but rename-of-the-dir-ITSELF is authorized by the
  # GRANDPARENT (which we don't stamp). The per-exec dir fence
  # opens a no-FILE_SHARE_DELETE handle on each stamped parent
  # so the child cannot move it aside while a session runs.
  $d23 = Join-Path $Scratch 'a23'
  New-Item -ItemType Directory -Path $d23 | Out-Null
  $f23 = Join-Path $d23 'inside.txt'
  Set-Content -Path $f23 -Value 'A23' -NoNewline
  Stamp @{ denyRead = @($f23) }
  $r = ChildExec @('--holder-pid', $Holder, '--', $cmd, '/v:on', '/d',
    '/s', '/c',
    "move `"$d23`" `"$d23-moved`" 2>&1 & echo MOVE_EXIT=!errorlevel!")
  if (-not (Test-Path -PathType Container $d23) -or
      (Test-Path "$d23-moved")) {
    throw ("A23: child renamed the stamped parent directory — " +
           "the per-exec dir fence is not holding it. raw: $($r.raw)`n" +
           "  d23 exists: $(Test-Path $d23)  " +
           "d23-moved exists: $(Test-Path "$d23-moved")")
  }
  if ($r.raw -notmatch '(?i)dir fence: \d+/\d+ dir') {
    throw "A23: dir-fence diag missing from exec output. raw: $($r.raw)"
  }
  Run @('acl', 'restore', '--group-sid', $GroupSid, '--holder-pid', $Holder)
  Write-Host 'A23 ok: per-exec dir fence — child cannot rename ' +
             'a stamped parent directory'

  # ── A24: child cannot rename the state-DB dir ────────────────
  # Same fence covers `%LOCALAPPDATA%\sandbox-runtime` so the
  # child can't move it aside and plant a poisoned DB at the
  # path. (The hash-ACE seal is the second layer.)
  if (-not (Test-Path $stateDir)) {
    Write-Host 'A24 skip: state-DB dir not present'
  } else {
    try {
      $r = ChildExec @('--holder-pid', $Holder, '--', $cmd, '/v:on',
        '/d', '/s', '/c',
        "move `"$stateDir`" `"$stateDir-poisoned`" 2>&1 & " +
        "echo MOVE_EXIT=!errorlevel!")
      if (-not (Test-Path -PathType Container $stateDir) -or
          (Test-Path "$stateDir-poisoned")) {
        throw ("A24: child renamed the state-DB directory — " +
               "the per-exec dir fence is not holding it. " +
               "raw: $($r.raw)")
      }
    } finally {
      # If a regression DID let the move succeed, the renamed dir
      # is OUTSIDE $Scratch — clean it up so it doesn't leak with
      # a broker-only DACL.
      Remove-Item -Recurse -Force "$stateDir-poisoned" `
        -ErrorAction SilentlyContinue
    }
    Write-Host 'A24 ok: per-exec dir fence — child cannot rename ' +
               'the state-DB directory'
  }

  # ── A25: junction → stamped parent (probe) ───────────────────
  # A junction at an unstamped path resolves to the stamped
  # parent's inode. NTFS authorizes delete of `$junc\file` via
  # the JUNCTION's parent (unstamped) only if the share-mode
  # check passes — but the per-exec dir fence holds a
  # no-SHARE_DELETE handle on the TARGET inode, so the
  # share-mode check should refuse. Probe and assert.
  $d25 = Join-Path $Scratch 'a25'
  New-Item -ItemType Directory -Path $d25 | Out-Null
  $f25 = Join-Path $d25 'prot.txt'
  Set-Content -Path $f25 -Value 'A25' -NoNewline
  Stamp @{ denyRead = @($f25) }
  $junc = Join-Path $Scratch 'a25j'
  cmd /c mklink /j "$junc" "$d25" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "A25 skip: mklink /j failed (exit $LASTEXITCODE)"
  } else {
    $r = ChildExec @('--holder-pid', $Holder, '--', $cmd, '/v:on',
      '/d', '/s', '/c', "del /f /q `"$junc\prot.txt`" 2>&1 & " +
            "echo DEL_EXIT=!errorlevel!")
    $stillThere = (Test-Path $f25) -and
                  ((Get-Content -Raw $f25) -eq 'A25')
    Write-Host ("A25 probe: del via junction → " +
                "DEL_EXIT in: $($r.out -match 'DEL_EXIT=\d+'); " +
                "file survives: $stillThere; raw: $($r.raw)")
    if (-not $stillThere) {
      throw ("A25: child deleted the protected file via a " +
             "junction to its stamped parent. The per-exec dir " +
             "fence (no-SHARE_DELETE on the parent inode) should " +
             "block this — share-mode is on the inode regardless " +
             "of the access path. raw: $($r.raw)")
    }
    Write-Host 'A25 ok: delete via junction to stamped parent denied'
  }
  Run @('acl', 'restore', '--group-sid', $GroupSid, '--holder-pid', $Holder)

  # ── H4: original_sd_tampered → fail-closed ─────────────────────
  # Stamp F, then poison the DB row's original_sd. Restore must
  # see hash(row.original_sd||file_id) ≠ on-disk marker, report
  # originalSdTampered, and leave F broker-only.
  if (-not $sqlite) {
    if ($env:GITHUB_ACTIONS -eq 'true') {
      throw ("H4/H6/H8: sqlite3 CLI not on PATH (REQUIRED on CI — " +
             "the DB-poison security tests must not be silently " +
             "bypassed). Did the `choco install sqlite` step fail?")
    }
    Write-Host 'H4/H6/H8 skip: sqlite3 CLI not on PATH'
  } else {
    $h4 = Join-Path $Scratch 'h4.txt'
    Set-Content -Path $h4 -Value 'H4' -NoNewline
    Stamp @{ denyRead = @($h4) }
    $h4Stamped = (Get-Acl -LiteralPath $h4).Sddl
    & $sqlite $stateDb `
      "UPDATE acl_snapshots SET original_sd = X'deadbeef' WHERE canonical_path LIKE '%h4.txt'"
    if ($LASTEXITCODE -ne 0) { throw "H4: sqlite3 update failed" }
    $j = RunJson @('acl', 'restore', '--group-sid', $GroupSid,
                   '--holder-pid', $Holder, '--json')
    $eH4 = $j | Where-Object { $_.path -like "*h4.txt" }
    if (-not $eH4 -or $eH4.status -ne 'originalSdTampered' -or
        $eH4.leftStamped -ne $true) {
      throw "H4: expected status=originalSdTampered leftStamped=true; " +
            "got: $($j | ConvertTo-Json -Compress)"
    }
    if ((Get-Acl -LiteralPath $h4).Sddl -ne $h4Stamped) {
      throw "H4: a poisoned original_sd was WRITTEN to disk — " +
            "fail-closed broken. before=$h4Stamped " +
            "after=$((Get-Acl -LiteralPath $h4).Sddl)"
    }
    Write-Host 'H4 ok: poisoned original_sd → originalSdTampered, ' +
               'file left broker-only'

    # ── H6: ensure_stamped uncorroborated row → FAIL ─────────────
    # Row exists, file_id matches, original_sd poisoned, file is
    # still stamped on disk. Next `acl stamp` must refuse (no
    # holder added, exit ≠ 0).
    $json6 = @{ denyRead = @($h4) } | ConvertTo-Json -Compress
    $out6 = $json6 | & $Exe acl stamp --group-sid $GroupSid `
      --holder-pid $Holder 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
      throw "H6: ensure_stamped accepted an uncorroborated " +
            "(poisoned) row. out: $out6"
    }
    if ($out6 -notmatch '(?i)tampered') {
      throw "H6: expected 'tampered' in error; got: $out6"
    }
    Write-Host 'H6 ok: ensure_stamped fails closed on uncorroborated row'
    # Reset for the next rows.
    & $sqlite $stateDb `
      "DELETE FROM acl_snapshots WHERE canonical_path LIKE '%h4.txt'"

    # ── H8: crash-between-upsert-and-stamp ──────────────────────
    # Row exists with original_sd=O, file UNSTAMPED. Next
    # ensure_stamped: classify→Unstamped, original_sd=cur,
    # upsert overwrites — no error, file gets stamped, and the
    # action is Fresh (NOT AlreadyStamped — that would mean the
    # row was trusted without checking disk).
    $h8 = Join-Path $Scratch 'h8.txt'
    Set-Content -Path $h8 -Value 'H8' -NoNewline
    $h8Orig = (Get-Acl -LiteralPath $h8).GetSecurityDescriptorBinaryForm()
    $h8Hex = ($h8Orig | ForEach-Object { $_.ToString('x2') }) -join ''
    $h8FileId = ([SrtWinSmoke.FileId]::Get($h8) |
      ForEach-Object { $_.ToString('x2') }) -join ''
    # SQLite string literals do NOT use backslash escaping (only
    # '' for embedded single-quote), so the canonical \\?\… path
    # goes in verbatim. The previous `-replace '\\','\\'` doubled
    # every backslash and the seeded row never matched the real
    # canon — the test passed vacuously as a fresh stamp.
    $h8Canon = "\\?\$h8"
    & $sqlite $stateDb ("INSERT INTO acl_snapshots " +
      "(canonical_path, original_sd, file_id, parent_path, " +
      "parent_stamp_failed) VALUES " +
      "('$($h8Canon -replace "'","''")', " +
      "X'$h8Hex', X'$h8FileId', NULL, 1)")
    if ($LASTEXITCODE -ne 0) { throw "H8: sqlite3 seed failed" }
    # Verify the seed actually matches what srt-win will key on.
    $h8Got = & $sqlite $stateDb `
      "SELECT count(*) FROM acl_snapshots WHERE canonical_path LIKE '%\h8.txt'"
    if ($h8Got -ne '1') {
      throw "H8 setup: seeded row not found by canonical key " +
            "(got count=$h8Got for canon='$h8Canon')"
    }
    $r8 = @{ denyRead = @($h8) } | ConvertTo-Json -Compress |
      & $Exe acl stamp --group-sid $GroupSid --holder-pid $Holder 2>&1 |
      Out-String
    Write-Host -NoNewline $r8
    if ($LASTEXITCODE -ne 0) {
      throw "H8: stamp over a row-but-unstamped file FAILED " +
            "(should re-derive original_sd=cur and overwrite). out: $r8"
    }
    if ($r8 -notmatch '1 newly stamped' -or
        $r8 -match '[1-9]\d* already held') {
      throw "H8: expected 1 newly stamped, 0 already held " +
            "(disk-first must NOT trust the seeded row); got: $r8"
    }
    if (-not (Get-MarkerHash $h8)) {
      throw "H8: file not stamped after a row-but-unstamped state"
    }
    Run @('acl', 'restore', '--group-sid', $GroupSid,
          '--holder-pid', $Holder)
    Write-Host 'H8 ok: row-exists-file-unstamped → next stamp re-derives'
  }

  # ── H5: StampedUnrecognized → fail-closed; --force overrides ──
  # Stamp F, then (broker-side) strip ONLY the S-1-0-* deny ACE,
  # leaving the N broker ACEs. Next `acl stamp` must FAIL with
  # marker_stripped — never set original_sd = (the broker stamp).
  $h5 = Join-Path $Scratch 'h5.txt'
  Set-Content -Path $h5 -Value 'H5' -NoNewline
  Stamp @{ denyRead = @($h5) }
  # Strip the marker via SDDL string surgery. Neither
  # Get-Acl/RemoveAccessRule/Set-Acl (.NET FileSecurity refuses to
  # modify a non-canonical deny-after-allow ACL), nor `icacls
  # /remove:d *S-1-0-…` (rejects the Null-authority synthetic SID,
  # error 1332), nor a hand-built FileSecurity (the FileSystemRights
  # enum OR's in SYNCHRONIZE so masks don't round-trip — 0x20000 →
  # 0x120000) can do this cleanly. Read SDDL → regex-strip the one
  # `(D;;RC;;;S-1-0-…)` ACE → write back via SetSecurityDescriptor-
  # SddlForm (no enum mapping; bytes identical to what srt-win
  # wrote, minus the marker). With no DENY ACE the result is
  # canonical so Set-Acl accepts it.
  $h5Sddl = (Get-Acl -LiteralPath $h5).Sddl
  $h5Stripped = $h5Sddl -replace '\(D;;[^;]*;;;S-1-0-[0-9-]+\)', ''
  if ($h5Stripped -eq $h5Sddl) {
    throw "H5 setup: marker ACE pattern not found in SDDL: $h5Sddl"
  }
  $fs = New-Object Security.AccessControl.FileSecurity
  $fs.SetSecurityDescriptorSddlForm($h5Stripped)
  Set-Acl -LiteralPath $h5 -AclObject $fs
  if (Get-MarkerHash $h5) {
    throw "H5 setup: marker still on disk after SDDL strip. " +
          "SDDL: $((Get-Acl -LiteralPath $h5).Sddl)"
  }
  Write-Host ("H5 setup: markerless broker DACL: " +
              "$((Get-Acl -LiteralPath $h5).Sddl) (was: $h5Sddl)")
  $h5Before = (Get-Acl -LiteralPath $h5).Sddl
  $json5 = @{ denyRead = @($h5) } | ConvertTo-Json -Compress
  $out5 = $json5 | & $Exe acl stamp --group-sid $GroupSid `
    --holder-pid $Holder 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -or
      $out5 -notmatch '(?i)stamped_unrecognized') {
    throw "H5: ensure_stamped did not fail-closed on a markerless " +
          "broker-shaped DACL. exit=$LASTEXITCODE out: $out5"
  }
  if ((Get-Acl -LiteralPath $h5).Sddl -ne $h5Before) {
    throw "H5: a markerless broker DACL was overwritten — " +
          "original_sd would have been destroyed"
  }
  Write-Host 'H5 ok: StampedUnrecognized → ensure_stamped fails closed'
  # Restore: same fail-closed via the restore path.
  $j5 = RunJson @('acl', 'restore', '--group-sid', $GroupSid,
                  '--holder-pid', $Holder, '--json')
  $eH5 = $j5 | Where-Object { $_.path -like "*h5.txt" }
  if (-not $eH5 -or $eH5.status -ne 'stampedUnrecognized') {
    throw "H5(restore): expected status=stampedUnrecognized; " +
          "got: $($j5 | ConvertTo-Json -Compress)"
  }
  # And `--force` IS the escape hatch — restores the recorded
  # original (loud) and drops the row.
  $r5f = RunCapture @('acl', 'recover', '--group-sid', $GroupSid,
                      '--force')
  if ($r5f.raw -notmatch '(?i)--force overriding') {
    throw "H5(--force): expected loud override; got: $($r5f.raw)"
  }
  if (Get-MarkerHash $h5) {
    throw "H5(--force): file still carries a marker after forced " +
          "restore. SDDL: $((Get-Acl -LiteralPath $h5).Sddl)"
  }
  & icacls $h5 /reset | Out-Null

  # ── H7: wiped-db-stamped-file → original_sd_lost ──────────────
  # Stamp F, delete state.db, stamp F again: succeeds with
  # original_sd_lost warning, marker UNCHANGED, no overwrite.
  $h7 = Join-Path $Scratch 'h7.txt'
  Set-Content -Path $h7 -Value 'H7' -NoNewline
  $h7Hold = Start-Process -PassThru -WindowStyle Hidden cmd `
    -ArgumentList '/c','timeout','/t','120','/nobreak'
  try {
    Stamp @{ denyRead = @($h7) } -HolderPid $h7Hold.Id
    $h7m1 = (Get-MarkerHash $h7).hash
    Remove-Item -Force $stateDb, "$stateDb-wal", "$stateDb-shm" `
      -ErrorAction SilentlyContinue
    $r = @{ denyRead = @($h7) } | ConvertTo-Json -Compress |
      & $Exe acl stamp --group-sid $GroupSid --holder-pid $Holder 2>&1 |
      Out-String
    Write-Host -NoNewline $r
    if ($LASTEXITCODE -ne 0) {
      throw "H7: stamp after DB wipe FAILED (should succeed with " +
            "original_sd_lost). out: $r"
    }
    if ($r -notmatch '(?i)original_sd_lost|original_sd is unrecoverable') {
      throw "H7: expected original_sd_lost warning; got: $r"
    }
    $h7m2 = (Get-MarkerHash $h7).hash
    if ($h7m1 -ne $h7m2) {
      throw "H7: marker CHANGED after DB wipe (genuine original was " +
            "overwritten with the broker stamp). before=$h7m1 after=$h7m2"
    }
    # Restore: original_sd is NULL → originalSdLost, leave stamped.
    $j7 = RunJson @('acl', 'restore', '--group-sid', $GroupSid,
                    '--holder-pid', $Holder, '--json')
    $eH7 = $j7 | Where-Object { $_.path -like "*h7.txt" }
    if (-not $eH7 -or $eH7.status -ne 'originalSdLost') {
      throw "H7: expected status=originalSdLost; " +
            "got: $($j7 | ConvertTo-Json -Compress)"
    }
  } finally {
    Stop-Process -Id $h7Hold.Id -Force -ErrorAction SilentlyContinue
  }
  Write-Host 'H7 ok: wiped DB → original_sd_lost, marker preserved'

  # ── H9: restore is DACL-only (not OWNER/GROUP) ─────────────────
  # restore_sd writes DACL_SECURITY_INFORMATION only — never the
  # captured owner/group (which would ERROR_INVALID_OWNER without
  # SeRestorePrivilege when the captured owner ≠ caller and leave
  # the file stuck broker-only). The load-bearing guarantee is the
  # source-level invariant in acl.rs::restore_sd (`let mut info =
  # DACL_SECURITY_INFORMATION;` — OWNER/GROUP never OR'd in); this
  # row is the smoke pin that owner is untouched end-to-end.
  #
  # Note: a "change owner mid-session, then restore" probe is NOT
  # workable on Windows — the kernel removes the OWNER_RIGHTS ACE
  # whenever owner changes (it was scoped to the previous owner;
  # CI-confirmed for both `takeown` and `icacls /setowner`), so
  # the post-change DACL no longer matches the broker shape and
  # classify_sd correctly returns Unstamped. That is the design
  # behaving as intended, not a bug.
  #
  # Runs in its own fresh subdir so H7's DB-wipe fallout
  # ($Scratch's parent_stamps row left with original_sd=NULL →
  # ensure_parent_stamped → Unstampable) does not interact.
  $d9 = Join-Path $Scratch 'h9d'
  New-Item -ItemType Directory -Path $d9 | Out-Null
  $h9 = Join-Path $d9 'h9.txt'
  Set-Content -Path $h9 -Value 'H9' -NoNewline
  $h9AclPre = Get-Acl -LiteralPath $h9
  Write-Host "H9 diag: pre-stamp  SDDL: $($h9AclPre.Sddl)"
  Stamp @{ denyRead = @($h9) }
  Write-Host "H9 diag: stamped    SDDL: $((Get-Acl -LiteralPath $h9).Sddl)"
  $j9 = RunJson @('acl', 'restore', '--group-sid', $GroupSid,
                  '--holder-pid', $Holder, '--json')
  $eH9 = $j9 | Where-Object { $_.path -like "*h9.txt" }
  $h9AclPost = Get-Acl -LiteralPath $h9
  Write-Host "H9 diag: restored   SDDL: $($h9AclPost.Sddl)"
  if (-not $eH9 -or $eH9.status -ne 'restored') {
    throw ("H9: expected status=restored (DACL-only restore); " +
           "got: $($j9 | ConvertTo-Json -Compress)")
  }
  if ($h9AclPost.Owner -ne $h9AclPre.Owner) {
    throw ("H9: owner changed across stamp→restore (must be " +
           "DACL-only). pre: $($h9AclPre.Owner)  " +
           "post: $($h9AclPost.Owner)")
  }
  Write-Host ('H9 ok: restore is DACL-only — owner untouched ' +
              "($($h9AclPre.Owner))")

  # ── R2/R20: poisoned-DB subsumed-arm regression ────────────────
  # Pre-seed an acl_snapshots row claiming F is already stamped
  # (poisoned DB). Under disk-is-truth, ensure_stamped reads the
  # live DACL → Unstamped → stamps regardless. The old subsumed
  # arm would have skipped the FS write entirely.
  if ($sqlite) {
    $r2 = Join-Path $Scratch 'r2.txt'
    Set-Content -Path $r2 -Value 'R2' -NoNewline
    $r2FileId = ([SrtWinSmoke.FileId]::Get($r2) |
      ForEach-Object { $_.ToString('x2') }) -join ''
    $r2Canon = "\\?\$($r2)"
    & $sqlite $stateDb ("INSERT OR REPLACE INTO acl_snapshots " +
      "(canonical_path, original_sd, file_id, parent_path, " +
      "parent_stamp_failed) VALUES " +
      "('$($r2Canon -replace "'","''")', X'00', X'$r2FileId', NULL, 0)")
    if ($LASTEXITCODE -ne 0) { throw "R2: sqlite3 seed failed" }
    Stamp @{ denyWrite = @($r2) }
    # Ground truth: file IS now broker-only (child write denied).
    $r = ChildExec @('--', $cmd, '/d', '/s', '/c', "echo x > `"$r2`"")
    if ($r.exit -eq 0) {
      throw "R2: poisoned-DB row caused stamp to be SKIPPED — " +
            "child wrote to a denyWrite target. raw: $($r.raw)"
    }
    Run @('acl', 'restore', '--group-sid', $GroupSid,
          '--holder-pid', $Holder)
    Write-Host 'R2 ok: poisoned row does NOT bypass disk-first stamp'
  }

  # ── R18: sibling fan-out — Unstampable parent fences ALL kids ─
  # Two files in one dir; stamp the first, then deny the broker
  # WRITE_DAC on the parent so ensure_parent_stamped → Unstampable
  # for the second; BOTH must be in the fence-fallback set.
  # (Exercises the `UPDATE … WHERE parent_path = ?` fan-out.)
  # Too intrusive to set up reliably from PowerShell without
  # affecting other rows; covered by the unit test
  # `fence_fallback_filter` and the design's =1-only invariant.
  Write-Host 'R18: covered by fence_fallback_filter unit test'

  # ── R820: nonexistent input → per-path skip + EXIT 2 ──────────
  # The resolvable input IS stamped, but exit is 2 (partial) so
  # the host never treats a partial stamp as success.
  $r820Real = Join-Path $Scratch 'r820.txt'
  Set-Content -Path $r820Real -Value 'R820' -NoNewline
  $r820 = @{ denyRead = @("$Scratch\no-such-file.txt", $r820Real) } |
    ConvertTo-Json -Compress |
    & $Exe acl stamp --group-sid $GroupSid --holder-pid $Holder 2>&1 |
    Out-String
  Write-Host -NoNewline $r820
  if ($LASTEXITCODE -ne 2) {
    throw "R820: expected exit 2 (partial) when an input path " +
          "could not be canonicalized; got exit=$LASTEXITCODE. " +
          "out: $r820"
  }
  if (-not (Get-MarkerHash $r820Real)) {
    throw "R820: real path was not stamped after skipping the bad one"
  }
  if ($r820 -notmatch '(?i)skipped:') {
    throw "R820: expected 'srt-win: skipped:' diagnostic; got: $r820"
  }
  Run @('acl', 'restore', '--group-sid', $GroupSid, '--holder-pid', $Holder)
  Write-Host ('R820 ok: nonexistent path skipped, rest stamped, ' +
              'exit=2 (partial)')

  Write-Host 'smoke-acl: OK'
}
finally {
  # Best-effort: restore anything this process still holds, then
  # recover anything the separate-process stampers left. The
  # state DB lives under the per-run %LOCALAPPDATA% override
  # (inside $Scratch), so deleting $Scratch removes it; the
  # production state.db is never touched. Restore the real
  # %LOCALAPPDATA% so any later cleanup steps see it.
  & $Exe acl restore --group-sid $GroupSid --holder-pid $Holder 2>$null
  & $Exe acl recover --group-sid $GroupSid --force 2>$null
  Remove-Item -Recurse -Force "$stateDir-poisoned" `
    -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $Scratch -ErrorAction SilentlyContinue
  $env:LOCALAPPDATA = $RealLocalAppData
}
