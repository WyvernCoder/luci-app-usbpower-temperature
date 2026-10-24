#Requires -Version 5.1
<#
.SYNOPSIS
    Manually control a USB port fan through a sysfs GPIO value file.

.DESCRIPTION
    Reference helper for the "gpio" backend. It writes 0/1 to a sysfs GPIO
    value and verifies the readback. Use the LuCI app for automatic
    temperature control and for uhubctl/regulator/command backends.

    If the daemon is running it will re-apply the configured policy on its
    next poll, so stop the service before using this script for overrides.

.PARAMETER Action
    Status (default) / On / Off / Cycle (off for one second) / Toggle.

.PARAMETER Target
    SSH target, for example root@router.

.PARAMETER GpioPath
    Path to the GPIO value file on the router.

.PARAMETER TimeoutSec
    SSH connect timeout in seconds.

.PARAMETER Force
    Allow power-off even when a /dev/sd* storage is mounted.

.EXAMPLE
    .\usb-fan.ps1 status -Target 'root@<router>'

.EXAMPLE
    .\usb-fan.ps1 off -Target 'root@<router>' -Force
#>
[CmdletBinding()]
param(
    [ValidateSet('Status', 'On', 'Off', 'Cycle', 'Toggle')]
    [string]$Action = 'Status',

    [Parameter(Mandatory)]
    [string]$Target,

    [string]$GpioPath = '/sys/class/gpio/usb_power/value',

    [int]$TimeoutSec = 10,

    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 在路由器上执行一条 sh 命令，返回输出与退出码。
function Invoke-Router {
    param([Parameter(Mandatory)][string]$Command)

    $sshArgs = @(
        '-o', 'BatchMode=yes',
        '-o', "ConnectTimeout=$TimeoutSec",
        '-o', 'StrictHostKeyChecking=accept-new',
        $Target, $Command
    )
    $raw = & ssh @sshArgs 2>&1
    $code = $LASTEXITCODE
    [pscustomobject]@{
        Output   = (($raw | Out-String).Trim())
        ExitCode = $code
    }
}

# 读取设备型号与 GPIO 当前值。
function Get-Info {
    $cmd = 'echo MODEL=$(cat /proc/device-tree/model 2>/dev/null); echo GPIO=$(cat {0} 2>/dev/null)' -f $GpioPath
    $r = Invoke-Router $cmd
    if ($r.ExitCode -ne 0) {
        throw "SSH 失败（退出码 $($r.ExitCode)）：$($r.Output)"
    }
    [pscustomobject]@{
        Model = [regex]::Match($r.Output, '(?m)^MODEL=(.*)$').Groups[1].Value
        Value = [regex]::Match($r.Output, '(?m)^GPIO=(.*)$').Groups[1].Value
    }
}

# 写入 GPIO 并回读校验，失败则抛异常。
function Set-FanPower {
    param([Parameter(Mandatory)][ValidateSet('0', '1')][string]$Level)

    $cmd = 'echo {0} > {1} && echo GPIO=$(cat {1}) || echo ERR=write-failed' -f $Level, $GpioPath
    $r = Invoke-Router $cmd
    if ($r.ExitCode -ne 0) {
        throw "SSH 执行失败（退出码 $($r.ExitCode)）：$($r.Output)"
    }
    if ($r.Output -match 'ERR=write-failed') {
        throw "写入 GPIO 失败：$GpioPath"
    }
    $m = [regex]::Match($r.Output, '(?m)^GPIO=(\d)$')
    if (-not $m.Success -or $m.Groups[1].Value -ne $Level) {
        throw "回读校验失败：期望 $Level，实际输出：$($r.Output)"
    }
}

# 是否挂载了 /dev/sd* 存储。
function Test-UsbStorageMounted {
    $r = Invoke-Router 'mount 2>/dev/null | grep "/dev/sd" | wc -l'
    if ($r.ExitCode -ne 0) { return $false }
    $text = $r.Output.Trim()
    return ($text -match '^\d+$' -and [int]$text -gt 0)
}

# 断电前的安全检查（避免切断正在写入的 U 盘）。
function Assert-SafeToCutPower {
    if ($Force) { return }
    if (Test-UsbStorageMounted) {
        Write-Host '检测到已挂载的 /dev/sd* 存储，为避免数据损坏已拒绝断电；确认安全后请加 -Force。' -ForegroundColor Yellow
        exit 2
    }
}

# 输出当前状态并返回信息对象。
function Show-State {
    $info = Get-Info
    if ($info.Value -notmatch '^[01]$') {
        throw "读取 GPIO 失败或值异常：'$($info.Value)'（$GpioPath）"
    }
    $state = if ($info.Value -eq '1') { 'ON（通电）' } else { 'OFF（断电）' }
    $model = if ($info.Model) { $info.Model } else { '未知' }
    Write-Host ("目标 : {0}" -f $Target)
    Write-Host ("型号 : {0}" -f $model)
    Write-Host ("GPIO : {0} = {1}" -f $GpioPath, $info.Value)
    Write-Host ("风扇 : {0}" -f $state)
    return $info
}

try {
    switch ($Action) {
        'Status' {
            Show-State | Out-Null
        }
        'On' {
            Set-FanPower '1'
            Write-Host '已通电。'
            Show-State | Out-Null
        }
        'Off' {
            Assert-SafeToCutPower
            Set-FanPower '0'
            Write-Host '已断电。'
            Show-State | Out-Null
        }
        'Toggle' {
            $info = Get-Info
            if ($info.Value -notmatch '^[01]$') {
                throw "读取 GPIO 失败或值异常：'$($info.Value)'（$GpioPath）"
            }
            $new = if ($info.Value -eq '1') { '0' } else { '1' }
            if ($new -eq '0') { Assert-SafeToCutPower }
            Set-FanPower $new
            $label = if ($new -eq '1') { 'ON（通电）' } else { 'OFF（断电）' }
            Write-Host ("已切换为：{0}" -f $label)
            Show-State | Out-Null
        }
        'Cycle' {
            Assert-SafeToCutPower
            Set-FanPower '0'
            Start-Sleep -Seconds 1
            try {
                Set-FanPower '1'
            }
            catch {
                Write-Host '严重：已断电，但恢复通电失败！请立即手动执行：' -ForegroundColor Red
                Write-Host "ssh $Target 'echo 1 > $GpioPath'" -ForegroundColor Red
                throw
            }
            Write-Host '已断电 1 秒并恢复通电。'
            Show-State | Out-Null
        }
    }
}
catch {
    Write-Host ("错误：{0}" -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}

exit 0
