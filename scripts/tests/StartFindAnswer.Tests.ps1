. (Join-Path $PSScriptRoot '..\start-findanswer.ps1')

$script:failures = 0

function Reset-LauncherDoubles {
    $script:backendReady = $false
    $script:frontendReady = $false
    $script:waitReady = $true
    $script:dependencyError = $null
    $script:backendStarts = 0
    $script:frontendStarts = 0
    $script:waits = 0
    $script:browserOpens = 0
}

function Test-FindAnswerDependencies {
    if ($script:dependencyError) { throw $script:dependencyError }
}
function Test-FindAnswerBackend { $script:backendReady }
function Test-FindAnswerFrontend { $script:frontendReady }
function Start-FindAnswerBackend { $script:backendStarts += 1 }
function Start-FindAnswerFrontend { $script:frontendStarts += 1 }
function Wait-FindAnswerEndpoint {
    $script:waits += 1
    $script:waitReady
}
function Open-FindAnswerBrowser { $script:browserOpens += 1 }

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    if ($Actual -ne $Expected) {
        throw "$Message expected $Expected but got $Actual"
    }
}

function Invoke-LauncherTest {
    param([string]$Name, [scriptblock]$Test)
    Reset-LauncherDoubles
    try {
        & $Test
        Write-Host "PASS $Name"
    } catch {
        $script:failures += 1
        Write-Host "FAIL $Name`: $($_.Exception.Message)"
    }
}

Invoke-LauncherTest 'opens the site without duplicate services when both are ready' {
    $script:backendReady = $true
    $script:frontendReady = $true
    Start-FindAnswer
    Assert-Equal $script:backendStarts 0 'backend starts'
    Assert-Equal $script:frontendStarts 0 'frontend starts'
    Assert-Equal $script:browserOpens 1 'browser opens'
}

Invoke-LauncherTest 'starts only the missing frontend' {
    $script:backendReady = $true
    Start-FindAnswer
    Assert-Equal $script:backendStarts 0 'backend starts'
    Assert-Equal $script:frontendStarts 1 'frontend starts'
    Assert-Equal $script:browserOpens 1 'browser opens'
}

Invoke-LauncherTest 'starts both services and waits before opening the site' {
    Start-FindAnswer
    Assert-Equal $script:backendStarts 1 'backend starts'
    Assert-Equal $script:frontendStarts 1 'frontend starts'
    Assert-Equal $script:waits 2 'readiness waits'
    Assert-Equal $script:browserOpens 1 'browser opens'
}

Invoke-LauncherTest 'does not open the site when a service does not become ready' {
    $script:waitReady = $false
    $threw = $false
    try { Start-FindAnswer } catch { $threw = $true }
    Assert-Equal $threw $true 'startup failure'
    Assert-Equal $script:browserOpens 0 'browser opens'
}

Invoke-LauncherTest 'does not start processes when dependencies are missing' {
    $script:dependencyError = 'missing dependency'
    $threw = $false
    try { Start-FindAnswer } catch { $threw = $true }
    Assert-Equal $threw $true 'dependency failure'
    Assert-Equal $script:backendStarts 0 'backend starts'
    Assert-Equal $script:frontendStarts 0 'frontend starts'
    Assert-Equal $script:browserOpens 0 'browser opens'
}

if ($script:failures -gt 0) {
    Write-Host "$script:failures launcher tests failed"
    exit 1
}
Write-Host 'All 5 launcher tests passed'
