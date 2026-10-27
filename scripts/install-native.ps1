[CmdletBinding()]
param(
  [ValidateSet('install','uninstall','check')][string]$Mode='install',
  [string]$ReleaseRoot='',
  [switch]$SkipDependencies,
  [string]$DshRuntimeHome='',
  [string]$DshProfile='',
  [switch]$SkipProcessCheck
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Get-DshRuntimeCandidates([string]$Explicit) {
  $candidates = New-Object 'System.Collections.Generic.List[string]'
  foreach ($value in @($Explicit, $(if ($env:DSH_RUNTIME_HOME) { $env:DSH_RUNTIME_HOME } else { '' }))) {
    if ($value) { $candidates.Add($value) }
  }
  # Prefer the registered install location so non-default install drives keep working.
  foreach ($root in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      $item = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $item) { continue }
      $display = $item.PSObject.Properties['DisplayName']
      $location = $item.PSObject.Properties['InstallLocation']
      if ($display -and ($display.Value -match 'DeepSeek Harness') -and $location -and $location.Value) {
        $candidates.Add((Join-Path $location.Value 'resources/runtime'))
      }
    }
  }
  $bases = New-Object 'System.Collections.Generic.List[string]'
  if ($env:LOCALAPPDATA) { $bases.Add((Join-Path $env:LOCALAPPDATA 'Programs')) }
  foreach ($name in @('ProgramFiles','ProgramFiles(x86)','ProgramW6432')) {
    $property = [Environment]::GetEnvironmentVariable($name)
    if ($property) { $bases.Add($property) }
  }
  foreach ($base in $bases) { $candidates.Add((Join-Path $base 'DeepSeek Harness/resources/runtime')) }
  $seen = @{}
  $result = New-Object 'System.Collections.Generic.List[string]'
  foreach ($candidate in $candidates) {
    if (-not $seen.ContainsKey($candidate)) { $seen[$candidate] = $true; $result.Add($candidate) }
  }
  return $result
}

function Resolve-DshRuntime([string]$Explicit) {
  $tried = New-Object 'System.Collections.Generic.List[string]'
  foreach ($candidate in (Get-DshRuntimeCandidates -Explicit $Explicit)) {
    $tried.Add($candidate)
    $cli = Join-Path $candidate 'cli/bin/dsh.cmd'
    $runtimeFile = Join-Path $candidate 'primary-runtime/runtime.json'
    if ((Test-Path -LiteralPath $cli) -and (Test-Path -LiteralPath $runtimeFile)) { return $candidate }
  }
  $hint = 'Pass -DshRuntimeHome <installed resources/runtime folder> or set DSH_RUNTIME_HOME.'
  throw ("Installed DSH Desktop runtime was not found. Tried: " + ($tried -join '; ') + ". " + $hint)
}

if(!$ReleaseRoot){$ReleaseRoot=Split-Path -Parent $PSScriptRoot}
$taskRoot=(Resolve-Path -LiteralPath $ReleaseRoot).Path
$dshRuntime=Resolve-DshRuntime -Explicit $DshRuntimeHome
$dshCli=Join-Path $dshRuntime 'cli/bin/dsh.cmd'
$runtimeFile=Join-Path $dshRuntime 'primary-runtime/runtime.json'
$runtime=Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
if($runtime.desktopVersion -ne '0.2.1-rc.3' -or $runtime.platform -ne 'win32'){throw ("This release supports Windows DSH Desktop 0.2.1-rc.3 only (found " + $runtime.desktopVersion + ' on ' + $runtime.platform + ').')}
$nodeCommand=(Get-Command node.exe -ErrorAction Stop).Source
$npmCommand=(Get-Command npm.cmd -ErrorAction Stop).Source
$nodeVersion=(& $nodeCommand --version).Trim().TrimStart('v')
if($nodeVersion -notmatch '^24\.' -or [version]$nodeVersion -lt [version]'24.14.0'){throw 'Node >=24.14.0 and npm are required.'}
$package=Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json
if($package.dependencies.'@deepseek-ai/dsh-sdk-client' -ne '0.2.1-rc.3'){throw 'SDK compatibility check failed.'}

$dshHome=if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'}
$profileName=if($DshProfile){$DshProfile}elseif($env:DSH_PROFILE){$env:DSH_PROFILE}else{'desktop'}
$profileDir=if($env:DSH_PROFILE_DIR){$env:DSH_PROFILE_DIR}else{Join-Path $dshHome ('profiles/' + $profileName)}

if($Mode -eq 'check'){
  @{compatible=$true;desktop=$runtime.desktopVersion;node=$nodeVersion;protocol=1;schema=7;runtime=$dshRuntime;profile=$profileName;profileDir=$profileDir} | ConvertTo-Json -Compress
  return
}
if($Mode -eq 'install' -and -not (Test-Path -LiteralPath (Join-Path $taskRoot 'plugins/dsh-dmn/package.json'))){throw 'DMN plugin directory is missing; run this script from the full source release.'}
if($Mode -eq 'install' -and -not (Test-Path -LiteralPath $profileDir)){throw ("DSH profile directory was not found: " + $profileDir + '. Start DSH Desktop once with -Profile ' + $profileName + ' or set DSH_PROFILE_DIR.')}
if(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue){
  if(-not $SkipProcessCheck){throw 'Exit DSH Desktop normally before installation, upgrade or uninstall. Do not force-kill an active SDK.'}
  Write-Warning 'DeepSeek Harness is running; -SkipProcessCheck was supplied. The plugin is staged and takes effect on the next Desktop restart.'
}
$backup=Join-Path $dshHome ('dmn/install-backups/'+[guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach($name in @('package.json','pnpm-lock.yaml','cordis.patch.yml','cordis.yml','compatibility.json')){
 $source=Join-Path $profileDir $name
 if(Test-Path -LiteralPath $source){Copy-Item -LiteralPath $source -Destination (Join-Path $backup $name)}
}
function Invoke-DmnStep([string]$Program,[string[]]$Arguments,[string]$Step){
 $stepPreference=$ErrorActionPreference;$ErrorActionPreference='Continue'
 try{$output=& $Program @Arguments 2>&1;$stepExit=$LASTEXITCODE}finally{$ErrorActionPreference=$stepPreference}
 if($stepExit -ne 0){$output | Set-Content -LiteralPath (Join-Path $backup ($Step+'.log')) -Encoding utf8;throw "$Step failed; retained profile backup and local diagnostic log: $backup"}
}
$pairedBackup=$null
Push-Location -LiteralPath $taskRoot
try{
 if($Mode -eq 'install'){
  if(!$SkipDependencies){Invoke-DmnStep $npmCommand @('ci','--no-audit','--no-fund') 'dependencies'}
  Invoke-DmnStep $npmCommand @('run','desktop:build') 'build'
  # Existing data migration is fenced by a complete stopped backup before plugin activation.
  $settingsFile=Join-Path $dshHome 'dmn/settings.json'
  if(Test-Path -LiteralPath $settingsFile){$settings=Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json;$database=$settings.database}else{$database=Join-Path $dshHome 'dmn/instances/default/queue.sqlite'}
  if(Test-Path -LiteralPath $database){$pairedBackup=$database+'.backups/'+[guid]::NewGuid().ToString();Invoke-DmnStep $nodeCommand @('--import','tsx','src/cli.ts','backup',$database,$pairedBackup) 'paired-backup'}
  $plugin=(Join-Path $taskRoot 'plugins/dsh-dmn').Replace('\','/')
  Invoke-DmnStep $dshCli @('plugin','--profile',$profileName,'add',('link:'+$plugin)) 'plugin-add'
 }else{Invoke-DmnStep $dshCli @('plugin','--profile',$profileName,'remove','dsh-dmn') 'plugin-remove'}
 @{operation=$Mode;profile=$profileName;profileDir=$profileDir;runtime=$dshRuntime;profileBackup=$backup;pairedBackup=$pairedBackup;businessData='preserved';restartRequired=$true;inferenceStarted=$false} | ConvertTo-Json -Compress
}finally{Pop-Location}
