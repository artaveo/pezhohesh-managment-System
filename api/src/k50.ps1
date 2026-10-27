# Talks to the ZKTeco K50 through ZKTeco's own Standalone SDK (zkemkeeper.dll, the same one
# ZKAccess uses). The core API runs this with 32-bit PowerShell, because the SDK is a 32-bit
# COM library. It reads one JSON request on stdin and writes one JSON answer on stdout:
#   { "ip": "...", "port": 4370, "machine": 1, "key": 0, "ops": [ { "op": "info" }, ... ] }
#   { "ok": true, "results": [ { "ok": true, ... }, ... ] }   or   { "ok": false, "error": "..." }
# Nothing here deletes a user or a finger; a member who should not come in is disabled.

$ErrorActionPreference = 'Stop'

# The answer goes out as raw UTF-8 bytes, whatever code page the console has (names are Persian).
function Answer($o) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Depth 6 -Compress))
    $out = [Console]::OpenStandardOutput()
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
    exit 0
}

# PowerShell hands what was piped in to the script as $input; the request is plain ASCII
# (the app writes other letters as \u escapes), so no code page can garble it.
try {
    $text = @($input) -join "`n"
    if (-not $text.Trim()) {
        $buf = New-Object IO.MemoryStream
        [Console]::OpenStandardInput().CopyTo($buf)
        $text = [Text.Encoding]::UTF8.GetString($buf.ToArray())
    }
    $req = $text | ConvertFrom-Json
} catch {
    Answer @{ ok = $false; error = 'bad_request'; detail = $_.Exception.Message }
}

$zk = $null
foreach ($id in 'zkemkeeper.ZKEM.1', 'zkemkeeper.ZKEM', 'zkemkeeper.CZKEM') {
    try { $zk = New-Object -ComObject $id; break } catch { }
}
if ($null -eq $zk) { Answer @{ ok = $false; error = 'sdk_missing'; bits = [IntPtr]::Size * 8 } }

$m = [int]$req.machine
if ($m -le 0) { $m = 1 }
function LastError { $e = 0; [void]$zk.GetLastError([ref]$e); return $e }

if ($req.key) { [void]$zk.SetCommPassword([int]$req.key) }
if (-not $zk.Connect_Net([string]$req.ip, [int]$req.port)) {
    Answer @{ ok = $false; error = 'connect_failed'; code = (LastError) }
}

function Fmt([string]$day, [string]$time) { return "$day $time" }

# The valid-date call differs between SDK versions; the first form the device takes is kept.
$script:dateForm = $null
function SetValid([string]$no, [string]$start, [string]$end) {
    $forms = @(
        @{ s = $start; e = $end },
        @{ s = (Fmt $start '00:00:00'); e = (Fmt $end '23:59:59') },
        @{ s = $start.Replace('-', ''); e = $end.Replace('-', '') }
    )
    if ($null -ne $script:dateForm) { $forms = @($forms[$script:dateForm]) + $forms }
    for ($i = 0; $i -lt $forms.Count; $i++) {
        try {
            if ($zk.SetUserValidDate($m, $no, 1, 0, $forms[$i].s, $forms[$i].e)) {
                if ($null -eq $script:dateForm) { $script:dateForm = $i }
                return $true
            }
        } catch { return $false }  # this SDK has no such call
    }
    return $false
}

function UserInfo([string]$no) {
    $name = ''; $pw = ''; $priv = 0; $en = $false
    if (-not $zk.SSR_GetUserInfo($m, $no, [ref]$name, [ref]$pw, [ref]$priv, [ref]$en)) { return @{ ok = $true; exists = $false } }
    $fingers = 0
    for ($f = 0; $f -lt 10; $f++) {
        $tmp = ''; $len = 0
        try { if ($zk.SSR_GetUserTmpStr($m, $no, $f, [ref]$tmp, [ref]$len)) { $fingers++ } } catch { }
    }
    $valid = $null
    try {
        $exp = 0; $cnt = 0; $s = ''; $e = ''
        if ($zk.GetUserValidDate($m, $no, [ref]$exp, [ref]$cnt, [ref]$s, [ref]$e)) { $valid = @{ expires = $exp; start = $s; end = $e } }
    } catch { }
    return @{ ok = $true; exists = $true; name = $name; enabled = [bool]$en; privilege = $priv; fingers = $fingers; valid = $valid }
}

$writes = @($req.ops | Where-Object { $_.op -in 'set_user', 'set_time' }).Count -gt 0
$results = New-Object System.Collections.ArrayList
try {
    if ($writes) { [void]$zk.EnableDevice($m, $false) }
    foreach ($o in $req.ops) {
        try {
            switch ($o.op) {
                'info' {
                    $sn = ''; $fw = ''; $plat = ''; $users = 0; $fps = 0; $logs = 0
                    [void]$zk.GetSerialNumber($m, [ref]$sn)
                    [void]$zk.GetFirmwareVersion($m, [ref]$fw)
                    try { [void]$zk.GetPlatform($m, [ref]$plat) } catch { }
                    [void]$zk.GetDeviceStatus($m, 2, [ref]$users)
                    [void]$zk.GetDeviceStatus($m, 3, [ref]$fps)
                    [void]$zk.GetDeviceStatus($m, 6, [ref]$logs)
                    $y = 0; $mo = 0; $d = 0; $h = 0; $mi = 0; $se = 0
                    [void]$zk.GetDeviceTime($m, [ref]$y, [ref]$mo, [ref]$d, [ref]$h, [ref]$mi, [ref]$se)
                    $calls = @{}
                    foreach ($c in 'SetUserValidDate', 'GetUserValidDate', 'SSR_SetUserInfo', 'StartEnrollEx', 'SSR_GetGeneralLogData') {
                        $def = ($zk | Get-Member -Name $c -ErrorAction SilentlyContinue)
                        $calls[$c] = if ($def) { [string]$def.Definition } else { $null }
                    }
                    [void]$results.Add(@{ ok = $true; serial = $sn; firmware = $fw; platform = $plat; users = $users; fingers = $fps; logs = $logs
                        time = ('{0:D4}-{1:D2}-{2:D2} {3:D2}:{4:D2}:{5:D2}' -f $y, $mo, $d, $h, $mi, $se); calls = $calls; bits = [IntPtr]::Size * 8 })
                }
                'user' { [void]$results.Add((UserInfo ([string]$o.no))) }
                'set_user' {
                    $no = [string]$o.no
                    # Keep the name, password and privilege the device already has for this user.
                    $name = ''; $pw = ''; $priv = 0; $en = $false
                    $had = $zk.SSR_GetUserInfo($m, $no, [ref]$name, [ref]$pw, [ref]$priv, [ref]$en)
                    # The device's own administrators are left as they are.
                    if ($had -and $priv -gt 0) { [void]$results.Add(@{ ok = $false; error = 'device_admin' }); break }
                    if (-not $had) { $name = [string]$o.name; $pw = ''; $priv = 0 }
                    if (-not $zk.SSR_SetUserInfo($m, $no, $name, $pw, $priv, [bool]$o.enabled)) {
                        [void]$results.Add(@{ ok = $false; error = 'set_user_failed'; code = (LastError) }); break
                    }
                    $dates = $null
                    if ($o.start -and $o.end) { $dates = SetValid $no ([string]$o.start) ([string]$o.end) }
                    [void]$results.Add(@{ ok = $true; created = -not $had; valid_dates = $dates; date_form = $script:dateForm })
                }
                'enroll' {
                    $no = [string]$o.no; $f = [int]$o.finger
                    [void]$zk.CancelOperation()
                    $ok = $zk.StartEnrollEx($no, $f, 1)
                    if (-not $ok) { $ok = $zk.StartEnroll([int]$no, $f) }
                    if ($ok) { [void]$results.Add(@{ ok = $true }) } else { [void]$results.Add(@{ ok = $false; error = 'enroll_failed'; code = (LastError) }) }
                }
                'logs' {
                    # Every punch after `since` ("yyyy-MM-dd HH:mm:ss", the device's own clock).
                    $since = [string]$o.since
                    $list = New-Object System.Collections.ArrayList
                    if ($zk.ReadGeneralLogData($m)) {
                        $no = ''; $vm = 0; $io = 0; $y = 0; $mo = 0; $d = 0; $h = 0; $mi = 0; $se = 0; $wc = 0
                        while ($zk.SSR_GetGeneralLogData($m, [ref]$no, [ref]$vm, [ref]$io, [ref]$y, [ref]$mo, [ref]$d, [ref]$h, [ref]$mi, [ref]$se, [ref]$wc)) {
                            $at = '{0:D4}-{1:D2}-{2:D2} {3:D2}:{4:D2}:{5:D2}' -f $y, $mo, $d, $h, $mi, $se
                            if (-not $since -or $at -gt $since) { [void]$list.Add(@{ no = $no; at = $at; verify = $vm; io = $io }) }
                        }
                    }
                    [void]$results.Add(@{ ok = $true; logs = $list })
                }
                'users' {
                    # Every user on the device (ID, name, admin or not), to compare with the app.
                    $list = New-Object System.Collections.ArrayList
                    if ($zk.ReadAllUserID($m)) {
                        $no = ''; $name = ''; $pw = ''; $priv = 0; $en = $false
                        while ($zk.SSR_GetAllUserInfo($m, [ref]$no, [ref]$name, [ref]$pw, [ref]$priv, [ref]$en)) {
                            [void]$list.Add(@{ no = $no; name = $name; privilege = $priv; enabled = [bool]$en })
                        }
                    }
                    [void]$results.Add(@{ ok = $true; users = $list })
                }
                'set_time' { [void]$results.Add(@{ ok = [bool]$zk.SetDeviceTime($m) }) }
                default { [void]$results.Add(@{ ok = $false; error = 'unknown_op' }) }
            }
        } catch {
            [void]$results.Add(@{ ok = $false; error = 'exception'; detail = $_.Exception.Message })
        }
    }
} finally {
    if ($writes) { [void]$zk.RefreshData($m); [void]$zk.EnableDevice($m, $true) }
    $zk.Disconnect()
}
Answer @{ ok = $true; results = $results }
