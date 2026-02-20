const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('[main:prebuild] Prisma lock preflight skipped on non-Windows platform.');
  process.exit(0);
}

const script = [
  "$targets = Get-CimInstance Win32_Process | Where-Object {",
  "  ($_.Name -in @('node.exe','electron.exe','Cosmosh.exe')) -and $_.CommandLine -like '*Cosmosh*'",
  "}",
  "if (-not $targets) {",
  "  Write-Output '[main:prebuild] No Cosmosh lock-holder process detected.'",
  "  exit 0",
  "}",
  "$targets | ForEach-Object {",
  "  try {",
  "    Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop",
  "    Write-Output (\"[main:prebuild] Stopped lock-holder process {0}#{1}.\" -f $_.Name, $_.ProcessId)",
  "  } catch {",
  "    Write-Output (\"[main:prebuild] Failed to stop process #{0}: {1}\" -f $_.ProcessId, $_.Exception.Message)",
  "  }",
  "}",
].join('; ');

const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
  stdio: 'inherit',
});

if (result.error) {
  console.error('[main:prebuild] Failed to execute Prisma lock preflight.', result.error);
  process.exitCode = 1;
}

if (typeof result.status === 'number' && result.status !== 0) {
  process.exitCode = result.status;
}
