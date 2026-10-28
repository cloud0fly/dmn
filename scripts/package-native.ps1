[CmdletBinding()]
param([string]$Destination='')
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
if(!$Destination){$Destination=Join-Path $taskRoot '.dmn/releases'}
Push-Location -LiteralPath $taskRoot
try{
 if(git status --porcelain){throw 'Commit the release source before packaging.'}
 $revision=(git rev-parse HEAD).Trim()
 $package=Get-Content plugins/dsh-dmn/package.json -Raw | ConvertFrom-Json
 New-Item -ItemType Directory -Path $Destination -Force | Out-Null
 $zip=Join-Path ([IO.Path]::GetFullPath($Destination)) ('dmn-desktop-'+$package.version+'-'+$revision.Substring(0,7)+'.zip')
 if(Test-Path -LiteralPath $zip){throw 'Release destination already exists.'}
 git archive --format=zip "--output=$zip" HEAD
 if($LASTEXITCODE -ne 0){throw 'Git source archive failed.'}
 Add-Type -AssemblyName System.IO.Compression
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Update)
 try{$entry=$archive.CreateEntry('release-manifest.json');$writer=[IO.StreamWriter]::new($entry.Open());try{$writer.Write((@{version=$package.version;commit=$revision;desktop='0.2.1-rc.3';sdk='0.2.1-rc.3';protocol=1;schema=8;dependencies='npm ci using package-lock.json';createdAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json))}finally{$writer.Dispose()}}finally{$archive.Dispose()}
 $stream=[IO.File]::OpenRead($zip);$hasher=[Security.Cryptography.SHA256]::Create()
 try{$hash=([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$hasher.Dispose()}
 "$hash  $([IO.Path]::GetFileName($zip))" | Set-Content -LiteralPath ($zip+'.sha256') -Encoding ascii
 @{archive=$zip;sha256=$hash;commit=$revision} | ConvertTo-Json -Compress
}finally{Pop-Location}
