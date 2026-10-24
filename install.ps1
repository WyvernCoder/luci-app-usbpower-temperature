[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Router,

    [switch]$Uninstall,

    [switch]$KeepConfig,

    [int]$TimeoutSec = 15
)

$ErrorActionPreference = 'Stop'

$SshOptions = @(
    '-o', 'BatchMode=yes',
    '-o', "ConnectTimeout=$TimeoutSec",
    '-o', 'StrictHostKeyChecking=accept-new'
)

function Invoke-RemoteScript {
    param([Parameter(Mandatory)][string]$Script)

    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
    $output = & ssh @SshOptions $Router "echo $encoded | base64 -d | sh" 2>&1
    $code = $LASTEXITCODE

    if ($output) {
        $output | ForEach-Object { Write-Host $_ }
    }
    if ($code -ne 0) {
        throw "Remote command failed with exit code $code"
    }
}

function Send-File {
    param(
        [Parameter(Mandatory)][string]$LocalPath,
        [Parameter(Mandatory)][string]$RemotePath
    )

    $encoded = [Convert]::ToBase64String([IO.File]::ReadAllBytes($LocalPath))
    $encoded | & ssh @SshOptions -T $Router "base64 -d > $RemotePath"
    if ($LASTEXITCODE -ne 0) {
        throw "file transfer failed with exit code $LASTEXITCODE"
    }
}

if ($Uninstall) {
    $keep = if ($KeepConfig) { '1' } else { '0' }
    $script = @"
set -e
/etc/init.d/usbpower_temperature stop 2>/dev/null || true
/etc/init.d/usbpower_temperature disable 2>/dev/null || true
rm -f /etc/init.d/usbpower_temperature \
      /usr/sbin/usbpowerd \
      /usr/sbin/usbpower-temperature-ctl \
      /usr/share/luci/menu.d/luci-app-usbpower-temperature.json \
      /usr/share/rpcd/acl.d/luci-app-usbpower-temperature.json \
      /www/luci-static/resources/view/usbpower-temperature/overview.js
rmdir /www/luci-static/resources/view/usbpower-temperature 2>/dev/null || true
if [ "$keep" = "0" ]; then
    rm -f /etc/config/usbpower_temperature
fi
/etc/init.d/rpcd reload >/dev/null 2>&1 || true
rm -f /tmp/luci-indexcache*
echo UNINSTALL_OK
"@
    Invoke-RemoteScript -Script $script
    Write-Host 'Removed usbpower-temperature from the router.'
    exit 0
}

$source = Join-Path $PSScriptRoot 'root'
if (-not (Test-Path -LiteralPath $source)) {
    Write-Error "Missing root tree: $source"
    exit 1
}

$tar = Join-Path $env:TEMP ('usbpower-' + [guid]::NewGuid().ToString('N') + '.tar.gz')
$remoteTar = '/tmp/usbpower-plugin.tar.gz'

try {
    & tar.exe -czf $tar -C $source .
    if ($LASTEXITCODE -ne 0) {
        throw "tar failed with exit code $LASTEXITCODE"
    }

    Send-File -LocalPath $tar -RemotePath $remoteTar

    $script = @'
set -e
WORK=/tmp/usbpower-install.$$
CONFIG_BACKUP=/tmp/usbpower-config.$$
mkdir -p "$WORK"
tar -xzf /tmp/usbpower-plugin.tar.gz -C "$WORK"
if [ -f /etc/config/usbpower_temperature ]; then
    cp /etc/config/usbpower_temperature "$CONFIG_BACKUP"
fi
cp -a "$WORK/." /
if [ -f "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" /etc/config/usbpower_temperature
fi
chmod 755 /etc/init.d/usbpower_temperature /usr/sbin/usbpowerd /usr/sbin/usbpower-temperature-ctl
/etc/init.d/rpcd reload >/dev/null 2>&1 || true
/etc/init.d/usbpower_temperature enable
if [ "$(uci -q get usbpower_temperature.settings.enabled)" = "1" ]; then
    /etc/init.d/usbpower_temperature restart
else
    /etc/init.d/usbpower_temperature stop 2>/dev/null || true
fi
rm -f /tmp/luci-indexcache*
rm -rf "$WORK" "$CONFIG_BACKUP" /tmp/usbpower-plugin.tar.gz
echo INSTALL_OK
'@
    Invoke-RemoteScript -Script $script
    Write-Host ''
    Write-Host 'Installed. Open LuCI -> System -> USB Thermal Fan / USB 温控风扇.'
}
finally {
    if (Test-Path -LiteralPath $tar) {
        Remove-Item -LiteralPath $tar -Force -ErrorAction SilentlyContinue
    }
}
