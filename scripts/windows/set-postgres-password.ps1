# Gives PostgreSQL 16 a password without reinstalling it (for an install that finished without one).
# Run in PowerShell as Administrator. It asks for the new password itself; nobody else sees it.
& {
    $pg  = "C:\Program Files\PostgreSQL\16"
    $data = "$pg\data"
    if (-not (Test-Path "$pg\bin\psql.exe")) { Write-Host "PostgreSQL 16 not found in $pg" -ForegroundColor Red; return }
    function Get-Port {
        $p = Select-String -Path "$data\postgresql.conf" -Pattern '^\s*port\s*=\s*(\d+)' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1
        if ($p) { $p } else { 5432 }
    }
    $svc = (Get-Service postgresql* -ErrorAction SilentlyContinue | Select-Object -First 1).Name
    if (-not $svc) { $svc = "postgresql-x64-16" }

    if (-not (Test-Path "$data\postgresql.conf")) {
        # The installer stopped before it made the database folder: make it now.
        Write-Host "Creating the database. Type the NEW password twice (it stays hidden)." -ForegroundColor Cyan
        New-Item -ItemType Directory -Force $data | Out-Null
        & "$pg\bin\initdb.exe" -D $data -U postgres -W -E UTF8 -A scram-sha-256
        if ($LASTEXITCODE) { Write-Host "initdb failed" -ForegroundColor Red; return }
        icacls $data /grant "NT AUTHORITY\NetworkService:(OI)(CI)F" /T | Out-Null
        if (-not (Get-Service $svc -ErrorAction SilentlyContinue)) {
            & "$pg\bin\pg_ctl.exe" register -N $svc -D $data -S auto -U "NT AUTHORITY\NetworkService"
        }
        Start-Service $svc
    } else {
        # The database exists: let local logins in without a password for one minute, set it, then lock again.
        if (-not (Get-Service $svc -ErrorAction SilentlyContinue)) {
            & "$pg\bin\pg_ctl.exe" register -N $svc -D $data -S auto -U "NT AUTHORITY\NetworkService"
        }
        $hba = "$data\pg_hba.conf"
        Copy-Item $hba "$hba.bak" -Force
        try {
            (Get-Content $hba) | ForEach-Object {
                if ($_ -match '^\s*#' -or $_ -notmatch '\S') { $_ } else { $_ -replace '(scram-sha-256|md5|password)\s*$', 'trust' }
            } | Set-Content $hba -Encoding ascii
            Restart-Service $svc
            Start-Sleep 3
            Write-Host "Type the NEW password twice (it stays hidden)." -ForegroundColor Cyan
            & "$pg\bin\psql.exe" -U postgres -h 127.0.0.1 -p (Get-Port) -c "\password postgres"
        } finally {
            Copy-Item "$hba.bak" $hba -Force
            Restart-Service $svc
        }
    }

    $port = Get-Port
    Get-Service $svc | Format-Table Name, Status, StartType -AutoSize
    Write-Host "Done. Port: $port. Open Pezhohesh and give it this password." -ForegroundColor Green
}
