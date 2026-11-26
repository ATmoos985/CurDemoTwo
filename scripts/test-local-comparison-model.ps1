<#
.SYNOPSIS
Checks the local Ollama model used for workbench comparison questions and warms it for the preview.
#>
param([string]$Model = 'qwen3.5:4b')
$ErrorActionPreference = 'Stop'
$origin = 'http://127.0.0.1:11434'

$installed = (Invoke-RestMethod "$origin/api/tags" -TimeoutSec 5).models
if ($Model -notin $installed.name) {
    throw "本机未找到模型 $Model。请先核对 ollama list。"
}

$topics = @('SHORTAGE', 'SAVING', 'SUMMARY', 'OTHER')
$schema = @{
    type = 'object'
    properties = @{ topic = @{ type = 'string'; enum = $topics } }
    required = @('topic')
    additionalProperties = $false
}
$cases = @(
    @{ question = '这两个版分别漏排了哪些裁片？'; expected = 'SHORTAGE' }
    @{ question = '两个方案能节省多少毫米的布？'; expected = 'SAVING' }
)
foreach ($case in $cases) {
    $body = @{
        model = $Model
        stream = $false
        think = $false
        format = $schema
        options = @{ temperature = 0; num_predict = 48 }
        messages = @(
            @{ role = 'system'; content = '选择唯一的对比问题意图。缺件、齐套为 SHORTAGE；耗布、预计节省为 SAVING；多项或选择建议为 SUMMARY；其他为 OTHER。' }
            @{ role = 'user'; content = $case.question }
        )
    } | ConvertTo-Json -Depth 10 -Compress
    $reply = Invoke-RestMethod "$origin/api/chat" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 120
    $topic = ($reply.message.content | ConvertFrom-Json).topic
    if (-not $reply.done -or $topic -cne $case.expected) {
        throw "模型 $Model 未返回预期意图 $($case.expected)，实际为 $topic。"
    }
    Write-Output "$Model  $topic  $($case.question)"
}
