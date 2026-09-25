# Local STT tool runbook

## Tool
- Name: Local STT Transcription
- Slug: `local_stt_transcribe`

## Purpose
Provides a first-class Agent HQ tool for turning a local audio artifact into plain transcript text.
It is optimized for Telegram voice-note intake, where the messaging/runtime layer already has a downloaded audio file path, but it can also be reused for other local audio artifacts.

## Expected input
```json
{
  "audio_path": "/absolute/or/workspace/relative/path/to/audio.ogg",
  "language": "en",
  "model": "base",
  "prompt": "optional hint text"
}
```

`audio_path` is required.

## Supported formats
Current allowlist:
- `.ogg`
- `.oga`
- `.opus`
- `.mp3`
- `.wav`
- `.m4a`
- `.mp4`
- `.mpeg`
- `.mpga`
- `.webm`

Telegram voice notes are typically `.ogg` or `.opus`, which are supported.

## Runtime behavior
The tool:
1. validates that the file exists
2. validates the extension against the current allowlist
3. checks for local dependencies
4. runs local Whisper transcription
5. returns machine-readable JSON with plain transcript text on success

Success shape:
```json
{
  "ok": true,
  "text": "transcribed text here",
  "language": "en",
  "model": "base",
  "source_path": "/path/to/file.ogg"
}
```

Failure shape:
```json
{
  "ok": false,
  "error_code": "missing_dependency",
  "message": "ffmpeg is required for local transcription but is not installed. Install with: brew install ffmpeg"
}
```

## Host dependencies
The first implementation targets the Mac mini host environment and expects:
- `python3`
- `ffmpeg`
- Python package `openai-whisper` (imported as `whisper`)

Provisioning example:
```bash
brew install ffmpeg
python3 -m pip install -U openai-whisper
```

## Notes on model choice
Default model is `base` for a reasonable local speed/quality balance.
If better accuracy is needed and host resources allow it, callers can pass `model` such as `small` or `medium`.

## Telegram intake usage
The intended runtime boundary is simple:
- messaging/runtime downloads the Telegram voice message to a local file
- runtime passes that local file path into `local_stt_transcribe`
- downstream assistant logic consumes the returned `text`

That keeps Telegram-specific download handling outside the transcription tool while avoiding bespoke per-channel STT glue.
