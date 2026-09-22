Set-StrictMode -Version Latest

function Invoke-BimStudioHttpProbe(
    [string]$Uri,
    [scriptblock]$Validate,
    [int]$TimeoutSeconds = 3
) {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSeconds
        $stopwatch.Stop()
        $valid = $response.StatusCode -ge 200 -and $response.StatusCode -lt 300 -and (& $Validate $response)
        return [pscustomobject]@{
            Healthy = [bool]$valid
            LatencyMs = [math]::Max(1, [math]::Round($stopwatch.Elapsed.TotalMilliseconds))
            Message = if ($valid) { "响应合同有效" } else { "端口响应不属于 Deep Monkey Studio" }
        }
    } catch {
        $stopwatch.Stop()
        return [pscustomobject]@{
            Healthy = $false
            LatencyMs = [math]::Max(1, [math]::Round($stopwatch.Elapsed.TotalMilliseconds))
            Message = $_.Exception.Message
        }
    }
}

function Test-BimStudioExpectedService([string]$Name) {
    switch ($Name) {
        "api" {
            $probe = Invoke-BimStudioHttpProbe "http://127.0.0.1:4100/health" {
                param($response)
                try {
                    $payload = $response.Content | ConvertFrom-Json
                    return $payload.status -eq "ok" -and $payload.service -eq "bim-studio-api"
                } catch { return $false }
            }
            return $probe.Healthy
        }
        "web" {
            $probe = Invoke-BimStudioHttpProbe "http://127.0.0.1:5173/" {
                param($response)
                return $response.Content -match "<title>\s*Deep\s*Monkey\s+Studio\s*</title>" -and $response.Content -match '<div\b[^>]*\sid\s*=\s*["'']root["''][^>]*>'
            }
            return $probe.Healthy
        }
        "minio" {
            $probe = Invoke-BimStudioHttpProbe "http://127.0.0.1:9000/minio/health/live" {
                param($response)
                return $response.StatusCode -eq 200
            }
            return $probe.Healthy
        }
        default { return $true }
    }
}

function Get-BimStudioServiceHealth([string]$Name, [bool]$Listening) {
    $checkedAt = (Get-Date).ToString("o")
    if (-not $Listening) {
        return [pscustomobject]@{ Health = "offline"; LatencyMs = "-"; CheckedAt = $checkedAt; Message = "服务未监听" }
    }

    $probe = switch ($Name) {
        "api" {
            Invoke-BimStudioHttpProbe "http://127.0.0.1:4100/health" {
                param($response)
                try {
                    $payload = $response.Content | ConvertFrom-Json
                    return $payload.status -eq "ok" -and $payload.service -eq "bim-studio-api"
                } catch { return $false }
            }
        }
        "web" {
            Invoke-BimStudioHttpProbe "http://127.0.0.1:5173/" {
                param($response)
                return $response.Content -match "<title>\s*Deep\s*Monkey\s+Studio\s*</title>" -and $response.Content -match '<div\b[^>]*\sid\s*=\s*["'']root["''][^>]*>'
            }
        }
        "minio" {
            Invoke-BimStudioHttpProbe "http://127.0.0.1:9000/minio/health/live" {
                param($response)
                return $response.StatusCode -eq 200
            }
        }
        default {
            [pscustomobject]@{ Healthy = $true; LatencyMs = "<1"; Message = "TCP 监听正常" }
        }
    }

    return [pscustomobject]@{
        Health = if ($probe.Healthy) { "healthy" } else { "degraded" }
        LatencyMs = $probe.LatencyMs
        CheckedAt = $checkedAt
        Message = $probe.Message
    }
}
