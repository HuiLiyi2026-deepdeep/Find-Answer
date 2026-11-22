$script:FindAnswerRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:FindAnswerBackendUrl = 'http://127.0.0.1:8000/api/health'
$script:FindAnswerFrontendUrl = 'http://127.0.0.1:5173'

function Test-FindAnswerBackend {
    try {
        $health = Invoke-RestMethod -Uri $script:FindAnswerBackendUrl -TimeoutSec 2
        return $health.status -eq 'ok'
    } catch {
        return $false
    }
}

function Test-FindAnswerFrontend {
    try {
        $response = Invoke-WebRequest -Uri $script:FindAnswerFrontendUrl -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200 -and $response.Content -match '<title>FindAnswer'
    } catch {
        return $false
    }
}

function Test-FindAnswerDependencies {
    $python = Get-Command python -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $python -or -not $npm) {
        throw 'Python or Node.js is unavailable. Install the project prerequisites first.'
    }
    & $python.Source -c "import fastapi, chromadb, httpx, pypdf, dotenv, multipart, uvicorn, keyring" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'Backend dependencies are missing. Run: python -m pip install -r backend\requirements.txt'
    }
    if (-not (Test-Path (Join-Path $script:FindAnswerRoot 'frontend\node_modules'))) {
        throw 'Frontend dependencies are missing. Run: npm install in the frontend directory.'
    }
}

function Start-FindAnswerBackend {
    $runtimeDir = Join-Path $script:FindAnswerRoot '.runtime'
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $python = Get-Command python -ErrorAction Stop
    Start-Process -FilePath $python.Source `
        -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000') `
        -WorkingDirectory (Join-Path $script:FindAnswerRoot 'backend') `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir 'backend.stdout.log') `
        -RedirectStandardError (Join-Path $runtimeDir 'backend.stderr.log') | Out-Null
}

function Start-FindAnswerFrontend {
    $runtimeDir = Join-Path $script:FindAnswerRoot '.runtime'
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $npm = Get-Command npm.cmd -ErrorAction Stop
    Start-Process -FilePath $npm.Source `
        -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort') `
        -WorkingDirectory (Join-Path $script:FindAnswerRoot 'frontend') `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir 'frontend.stdout.log') `
        -RedirectStandardError (Join-Path $runtimeDir 'frontend.stderr.log') | Out-Null
}

function Wait-FindAnswerEndpoint {
    param([Parameter(Mandatory = $true)][ValidateSet('Backend', 'Frontend')][string]$Kind)

    for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
        $ready = if ($Kind -eq 'Backend') {
            Test-FindAnswerBackend
        } else {
            Test-FindAnswerFrontend
        }
        if ($ready) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Open-FindAnswerBrowser {
    Start-Process $script:FindAnswerFrontendUrl | Out-Null
}

function Show-FindAnswerError {
    param([Parameter(Mandatory = $true)][string]$Message)
    $shell = New-Object -ComObject WScript.Shell
    $shell.Popup($Message, 0, 'FindAnswer', 16) | Out-Null
}

function Start-FindAnswer {
    $mutex = New-Object System.Threading.Mutex($false, 'Local\FindAnswerLauncher')
    $hasLock = $false
    try {
        $hasLock = $mutex.WaitOne(60000)
        if (-not $hasLock) {
            throw 'Another FindAnswer launcher is still starting the services.'
        }

        $backendReady = Test-FindAnswerBackend
        $frontendReady = Test-FindAnswerFrontend
        if (-not ($backendReady -and $frontendReady)) {
            Test-FindAnswerDependencies
        }
        if (-not $backendReady) {
            Start-FindAnswerBackend
            if (-not (Wait-FindAnswerEndpoint -Kind Backend)) {
                throw 'The backend did not start. Check .runtime\backend.stderr.log.'
            }
        }
        if (-not $frontendReady) {
            Start-FindAnswerFrontend
            if (-not (Wait-FindAnswerEndpoint -Kind Frontend)) {
                throw 'The frontend did not start. Check .runtime\frontend.stderr.log.'
            }
        }
        Open-FindAnswerBrowser
    } finally {
        if ($hasLock) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Start-FindAnswer
    } catch {
        Show-FindAnswerError -Message $_.Exception.Message
    }
}
