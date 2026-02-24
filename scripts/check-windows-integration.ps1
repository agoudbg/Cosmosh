param(
  [switch]$Detailed
)

$ErrorActionPreference = 'Stop'

if ($env:OS -notlike '*Windows*') {
  Write-Host '[Cosmosh Integration Check] This script is intended for Windows only.' -ForegroundColor Yellow
  exit 0
}

$checks = @(
  @{
    Name = 'App Paths: Cosmosh.exe default';
    Path = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Cosmosh.exe';
    Value = '';
  },
  @{
    Name = 'App Paths: Cosmosh.exe Path';
    Path = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Cosmosh.exe';
    Value = 'Path';
  },
  @{
    Name = 'App Paths: cosmosh.exe default';
    Path = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\cosmosh.exe';
    Value = '';
  },
  @{
    Name = 'App Paths: cosmosh.exe Path';
    Path = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\cosmosh.exe';
    Value = 'Path';
  },
  @{
    Name = 'Applications: FriendlyAppName';
    Path = 'Registry::HKEY_CURRENT_USER\Software\Classes\Applications\Cosmosh.exe';
    Value = 'FriendlyAppName';
  },
  @{
    Name = 'Applications: open command';
    Path = 'Registry::HKEY_CURRENT_USER\Software\Classes\Applications\Cosmosh.exe\shell\open\command';
    Value = '';
  },
  @{
    Name = 'Context Menu: Directory Background command';
    Path = 'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\Cosmosh\command';
    Value = '';
  },
  @{
    Name = 'Context Menu: Directory command';
    Path = 'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\shell\Cosmosh\command';
    Value = '';
  },
  @{
    Name = 'Context Menu: Drive command';
    Path = 'Registry::HKEY_CURRENT_USER\Software\Classes\Drive\shell\Cosmosh\command';
    Value = '';
  }
)

function Get-RegistryValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RegistryPath,
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$ValueName
  )

  $prefix = 'Registry::HKEY_CURRENT_USER\'

  if (-not $RegistryPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsupported path scope: $RegistryPath"
  }

  $subPath = $RegistryPath.Substring($prefix.Length)
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subPath)

  if ($null -eq $key) {
    throw "Registry key not found: $RegistryPath"
  }

  try {
    return $key.GetValue($ValueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  }
  finally {
    $key.Close()
  }
}

$passed = 0
$failed = 0

Write-Host '=== Cosmosh Windows Integration Check ===' -ForegroundColor Cyan

foreach ($check in $checks) {
  $path = $check.Path
  $valueName = $check.Value

  try {
    $actualValue = Get-RegistryValue -RegistryPath $path -ValueName $valueName

    if ($null -eq $actualValue -or [string]::IsNullOrWhiteSpace([string]$actualValue)) {
      Write-Host "[MISSING] $($check.Name)" -ForegroundColor Red
      if ($Detailed) {
        Write-Host "  Path: $path" -ForegroundColor DarkGray
        Write-Host "  Value: <empty>" -ForegroundColor DarkGray
      }
      $failed += 1
      continue
    }

    Write-Host "[OK]      $($check.Name)" -ForegroundColor Green
    if ($Detailed) {
      Write-Host "  Path: $path" -ForegroundColor DarkGray
      Write-Host "  Value: $actualValue" -ForegroundColor DarkGray
    }
    $passed += 1
  }
  catch {
    Write-Host "[MISSING] $($check.Name)" -ForegroundColor Red
    if ($Detailed) {
      Write-Host "  Path: $path" -ForegroundColor DarkGray
      Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor DarkGray
    }
    $failed += 1
  }
}

Write-Host ''

try {
  # Validate that the shell can resolve the user-facing launcher command.
  $command = Get-Command cosmosh -ErrorAction Stop
  Write-Host '[OK]      Command: cosmosh' -ForegroundColor Green
  if ($Detailed) {
    Write-Host "  Source: $($command.Source)" -ForegroundColor DarkGray
    Write-Host "  CommandType: $($command.CommandType)" -ForegroundColor DarkGray
  }
  $passed += 1
}
catch {
  Write-Host '[MISSING] Command: cosmosh' -ForegroundColor Red
  if ($Detailed) {
    Write-Host '  Error: command not found in current PATH/PATHEXT resolution.' -ForegroundColor DarkGray
  }
  $failed += 1
}

Write-Host "Summary: Passed=$passed Failed=$failed" -ForegroundColor Cyan

if ($failed -gt 0) {
  Write-Host 'Result: Integration is partially missing. Re-run installer and enable Windows integration options.' -ForegroundColor Yellow
  exit 1
}

Write-Host 'Result: Integration looks complete.' -ForegroundColor Green
exit 0
