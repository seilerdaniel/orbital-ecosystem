Write-Host "🚀 Inicializando Ecosistema Orbital..." -ForegroundColor Green

# 1. Directorios de configuración global
$GlobalDir = "$env:USERPROFILE\.config\orbital"
New-Item -ItemType Directory -Force -Path "$GlobalDir\skills", "$GlobalDir\mcp" | Out-Null

# 2. Clonar Colección de Subagentes (Agency Agents) y Herramientas
if (-not (Test-Path "$GlobalDir\skills\agency-agents")) {
    Write-Host "📥 Clonando Agency Agents (232 Subagentes)..." -ForegroundColor Cyan
    git clone --depth 1 https://github.com/msitarzewski/agency-agents.git "$GlobalDir\skills\agency-agents"
}

# 3. Configurar servidores MCP en OpenCode
$OpenCodeConfig = "$env:USERPROFILE\.config\opencode\opencode.json"
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\opencode" | Out-Null

$mcpConfig = @{
    mcpServers = @{
        "codebase-memory" = @{ command = "npx"; args = @("-y", "@deusdata/codebase-memory-mcp") }
        "agent-reach"     = @{ command = "npx"; args = @("-y", "agent-reach-mcp") }
    }
} | ConvertTo-Json -Depth 5

Set-Content -Path $OpenCodeConfig -Value $mcpConfig -Encoding UTF8
Write-Host "✅ Servidores MCP registrados en OpenCode." -ForegroundColor Green
Write-Host "✨ Ecosistema Orbital inicializado exitosamente." -ForegroundColor Yellow
