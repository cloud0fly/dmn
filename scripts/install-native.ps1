[CmdletBinding()]
param([ValidateSet('install','uninstall','check')][string]$Mode='install',[string]$ReleaseRoot='',[switch]$SkipDependencies)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(!$ReleaseRoot){$ReleaseRoot=Split-Path -Parent $PSScriptRoot}
$taskRoot=(Resolve-Path -LiteralPath $ReleaseRoot).Path
$dshBase=Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime'
$dshCli=Join-Path $dshBase 'cli/bin/dsh.cmd'
$runtimeFile=Join-Path $dshBase 'primary-runtime/runtime.json'
if(!(Test-Path -LiteralPath $dshCli) -or !(Test-Path -LiteralPath $runtimeFile)){throw 'Installed DSH Desktop runtime was not found.'}
$runtime=Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
if($runtime.desktopVersion -ne '0.2.1-rc.3' -or $runtime.platform -ne 'win32'){throw 'This release supports Windows DSH Desktop 0.2.1-rc.3 only.'}
$nodeCommand=(Get-Command node.exe -ErrorAction Stop).Source
$npmCommand=(Get-Command npm.cmd -ErrorAction Stop).Source
$nodeVersion=(& $nodeCommand --version).Trim().TrimStart('v')
if($nodeVersion -notmatch '^24\.' -or [version]$nodeVersion -lt [version]'24.14.0'){throw 'Node >=24.14.0 and npm are required.'}
$package=Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json
if($package.dependencies.'@deepseek-ai/dsh-sdk-client' -ne '0.2.1-rc.3'){throw 'SDK compatibility check failed.'}
if($Mode -eq 'check'){@{compatible=$true;desktop=$runtime.desktopVersion;node=$nodeVersion;protocol=1;schema=8} | ConvertTo-Json -Compress;return}
if(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue){throw 'Exit DSH Desktop normally before installation, upgrade or uninstall. Do not force-kill an active SDK.'}
$dshHome=if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'}
$profile=Join-Path $dshHome 'profiles/desktop'
$backup=Join-Path $dshHome ('dmn/install-backups/'+[guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach($name in @('package.json','pnpm-lock.yaml','cordis.patch.yml','cordis.yml','compatibility.json')){
 $source=Join-Path $profile $name
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
  Invoke-DmnStep $dshCli @('plugin','--profile','desktop','add',('link:'+$plugin)) 'plugin-add'
 }else{Invoke-DmnStep $dshCli @('plugin','--profile','desktop','remove','dsh-dmn') 'plugin-remove'}
 @{operation=$Mode;profileBackup=$backup;pairedBackup=$pairedBackup;businessData='preserved';restartRequired=$true;inferenceStarted=$false} | ConvertTo-Json -Compress
}finally{Pop-Location}
