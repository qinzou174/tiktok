param(
  [string]$Output = "shiguang-server-package.zip"
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $projectRoot $Output
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("shiguang-package-" + [guid]::NewGuid().ToString("N"))

try {
  New-Item -ItemType Directory -Path $staging | Out-Null
  $items = @(
    "public", "deploy", "docs", "scripts", "tests",
    "server.mjs", "archive.mjs", "api-scheduler.mjs", "api-circuit-breaker.mjs", "douyin-url.mjs", "package.json", "Dockerfile", "compose.yaml",
    ".dockerignore", ".gitignore", ".env.example", "README.md"
  )
  foreach ($item in $items) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $staging -Recurse
  }
  if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $outputPath -CompressionLevel Optimal
  Write-Host "已生成安全部署包：$outputPath"
  Write-Host "已排除 .env、data、SQLite、媒体文件和日志。"
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
