# Prints, as a JSON array, the screens of the first graphics adapter in the order ffmpeg's
# ddagrab numbers them (its output_idx), each with where it is on the desktop in physical pixels.
. "$PSScriptRoot\common.ps1"
$i = 0
Write-Json @([HowbenchDxgi]::Outputs() | ForEach-Object {
    [ordered]@{ index = $i++; device = $_.DeviceName; rotation = $_.Rotation; box = ConvertTo-Box $_.DesktopCoordinates }
})
