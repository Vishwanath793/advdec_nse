$ErrorActionPreference = 'Stop'
$projectDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$serverFile = Join-Path $projectDir 'server/index.js'
$logFile = Join-Path $projectDir '.data/backend.log'
$taskName = 'AdvanceDecline-Backend'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
New-Item -ItemType Directory -Path (Join-Path $projectDir '.data') -Force | Out-Null
$escapePs = { param($value) "'" + $value.Replace("'", "''") + "'" }
$commandText = '& ' + (& $escapePs $nodeExe) + ' ' + (& $escapePs $serverFile) + ' >> ' + (& $escapePs $logFile) + ' 2>&1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $commandText + '"') -WorkingDirectory $projectDir
$triggers = @(New-ScheduledTaskTrigger -AtLogOn -User $identity)
# Start the backend before research time if it was stopped during the day.
# The Node scheduler itself always uses Asia/Kolkata, including holiday checks.
$indiaZone = [TimeZoneInfo]::FindSystemTimeZoneById('India Standard Time')
$indiaEvening = [DateTime]::SpecifyKind([DateTime]::Today.AddHours(18).AddMinutes(55), [DateTimeKind]::Unspecified)
$localEvening = [TimeZoneInfo]::ConvertTimeToUtc($indiaEvening, $indiaZone).ToLocalTime()
$triggers += New-ScheduledTaskTrigger -Daily -At $localEvening
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.Actions.Arguments -ne $action.Arguments) { throw "A different task named $taskName exists. It was not overwritten." }
} else {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -User $identity -RunLevel Limited -Description 'Runs the local Advance/Decline backend, including 19:00 IST TV research on NSE equity market days.' | Out-Null
}
Start-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
