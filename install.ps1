# One command to put Conn on a Windows machine:
#
#   irm https://raw.githubusercontent.com/umarbashirr/Conn/main/install.ps1 | iex
#
# It reads the newest release from the public GitHub API, so there is no gh CLI
# to install and no account to log into, downloads the installer that matches
# the machine, and runs it. The installer is one click: it goes into
# %LOCALAPPDATA%\Programs\conn for the current user, asks for no password,
# puts `conn` on PATH and adds "Open with Conn" to a folder's right-click
# menu.
#
# A piped script takes no arguments, so pass them like this instead:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/umarbashirr/Conn/main/install.ps1))) -Uninstall

[CmdletBinding()]
param(
  [string] $Version,      # a release to install instead of the newest
  [switch] $Force,        # reinstall even if this version is already here
  [switch] $Silent,       # no installer window, for scripting
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$repo = 'umarbashirr/Conn'

# Windows PowerShell 5.1 still defaults to TLS 1.0, which GitHub hung up on
# years ago. PowerShell 7 ignores this and is right to.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

function Say  { param($m) Write-Host $m }
function Step { param($m) Write-Host "`n> $m" }

# The installed copy registers itself the way every Windows program does, and
# that registration is the only honest answer to what is already here.
function Get-Installed {
  foreach ($root in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  )) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $p = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($p -and $p.DisplayName -like 'Conn*') { return $p }
    }
  }
  return $null
}

# Releases have been named pba-* and are now conn-*, so the asset is found by
# its extension and the architecture in its name, never by the product name.
# One .exe with no architecture in its name is still this machine's, as long as
# this machine is the one Windows builds are made for.
function Select-Asset {
  param($assets, [string] $arch)
  $exes = @($assets | Where-Object { $_.name -like '*.exe' })
  $hit = $exes | Where-Object { $_.name -like "*$arch*" } | Select-Object -First 1
  if (-not $hit -and $arch -eq 'x64' -and $exes.Count -eq 1) { $hit = $exes[0] }
  return $hit
}

# The uninstall string is a quoted path, sometimes with arguments after it.
function Split-Command {
  param([string] $cmd)
  if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') { return @($Matches[1], $Matches[2]) }
  return @($cmd, '')
}

function Remove-Conn {
  Step 'Removing Conn'
  $found = Get-Installed
  if (-not $found) { throw 'Conn is not installed for this user' }

  $cmd = if ($found.QuietUninstallString) { $found.QuietUninstallString } else { $found.UninstallString }
  if (-not $cmd) { throw 'the installed copy has no uninstaller registered' }

  $exe, $rest = Split-Command $cmd
  $argList = @($rest -split '\s+' | Where-Object { $_ })
  if ($Silent -and $argList -notcontains '/S') { $argList += '/S' }

  # Start-Process refuses an empty -ArgumentList, so the parameter is only
  # there when there is something to put in it.
  $start = @{ FilePath = $exe; Wait = $true }
  if ($argList.Count) { $start.ArgumentList = $argList }
  Start-Process @start
  Say 'Gone. Your settings and open-project state are still in %USERPROFILE%\.conn; delete that too if you want none of it back.'
}

function Install-Conn {
  if ($env:OS -ne 'Windows_NT') { throw 'this installer is for Windows. On Linux, use install.sh' }

  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { $env:PROCESSOR_ARCHITECTURE }
  }

  Step 'Looking up the release'
  $api = if ($Version) {
    "https://api.github.com/repos/$repo/releases/tags/v$($Version.TrimStart('v'))"
  } else {
    "https://api.github.com/repos/$repo/releases/latest"
  }

  try {
    $release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'conn-install' }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 404 -and $Version) { throw "there is no release v$($Version.TrimStart('v'))" }
    throw "could not reach GitHub. Are you online? ($($_.Exception.Message))"
  }

  $latest = ([string]$release.tag_name).TrimStart('v')
  if (-not $latest) { throw 'GitHub answered with a release that has no tag' }

  $asset = Select-Asset $release.assets $arch
  if (-not $asset) {
    $have = @($release.assets | ForEach-Object { $_.name })
    if ($have.Count -eq 0) {
      throw "release v$latest has no files attached yet"
    }
    throw "release v$latest has no Windows installer for $arch. Attached: $($have -join ', ')."
  }

  Say "Conn $latest, $($asset.name)"

  $here = Get-Installed
  if (-not $Force -and $here -and $here.DisplayVersion -eq $latest) {
    Say "Already on $latest. Nothing to do, and -Force if you disagree."
    return
  }

  $file = Join-Path ([IO.Path]::GetTempPath()) $asset.name
  Step "Downloading $([math]::Round($asset.size / 1MB)) MB"

  # Invoke-WebRequest draws a progress bar that costs more than the download on
  # a file this size, so it is turned off and the size is said up front instead.
  $progress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing
  } catch {
    throw "the download failed ($($_.Exception.Message))"
  } finally {
    $ProgressPreference = $progress
  }

  Step 'Installing'
  $start = @{ FilePath = $file; Wait = $true; PassThru = $true }
  if ($Silent) { $start.ArgumentList = '/S' }
  $run = Start-Process @start
  if ($run.ExitCode -ne 0) { throw "the installer stopped with exit code $($run.ExitCode)" }
  Remove-Item $file -ErrorAction SilentlyContinue

  Step "Conn $latest is installed"
  Say @'

  conn .             open the folder you are in
  conn C:\code\shop  open another one
  conn go 3000       point the preview at a port

The conn command was just added to your PATH, so open a new terminal before
using it. Right-clicking a folder in Explorer offers "Open with Conn" too.

The agent uses your existing Claude Code login. If claude works in your
terminal, the panel works.
'@
}

# The one-liner always fetches this file from main. The bytes it installs belong
# to a release. Run that release's copy so the script and the binary are the
# same tag. A tag from before this pin has no such check and just installs.
function Invoke-PinnedInstall {
  if ($env:CONN_INSTALL_FROM_TAG) { return $false }
  $api = if ($Version) {
    "https://api.github.com/repos/$repo/releases/tags/v$($Version.TrimStart('v'))"
  } else {
    "https://api.github.com/repos/$repo/releases/latest"
  }
  try {
    $release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'conn-install' }
  } catch {
    return $false
  }
  $tag = ([string]$release.tag_name).Trim()
  if (-not $tag) { return $false }
  $raw = "https://raw.githubusercontent.com/$repo/$tag/install.ps1"
  $file = Join-Path ([IO.Path]::GetTempPath()) "conn-install-$tag.ps1"
  try {
    Invoke-WebRequest -Uri $raw -OutFile $file -UseBasicParsing
  } catch {
    return $false
  }
  $env:CONN_INSTALL_FROM_TAG = $tag
  $bound = @{}
  if ($Version) { $bound.Version = $Version }
  if ($Force) { $bound.Force = $true }
  if ($Silent) { $bound.Silent = $true }
  & $file @bound
  return $true
}

# Nothing here calls exit: this script is meant to be piped into iex, and an
# exit there closes the window the person was about to read the error in.
try {
  if (-not $Uninstall -and (Invoke-PinnedInstall)) { return }
  if ($Uninstall) { Remove-Conn } else { Install-Conn }
} catch {
  Write-Host "conn: $($_.Exception.Message)" -ForegroundColor Red
}
