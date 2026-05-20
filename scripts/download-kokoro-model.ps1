# Download Kokoro TTS model files to public/kokoro-model/
# Run this if you get ERR_CONNECTION_RESET from HuggingFace

$baseUrl = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main"
$files = @(
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "kokoro-v1.0.onnx"
)

Write-Host "Downloading Kokoro model files to public/kokoro-model/..."
foreach ($file in $files) {
    $url = "$baseUrl/$file"
    $out = "public/kokoro-model/$file"
    Write-Host "  -> $file"
    try {
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
    } catch {
        Write-Warning "Failed to download $file. Check network/VPN."
    }
}
Write-Host "Done. Restart your dev server."
