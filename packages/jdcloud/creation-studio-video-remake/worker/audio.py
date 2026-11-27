"""Transcribe local media and fit replacement music to the rendered video."""
import json
import math
import subprocess
import sys
from pathlib import Path

MUSIC_LIMIT = 30 * 1024 * 1024
MUSIC_FORMATS = {"mp3", "wav", "mov"}


class SpeechRecognitionError(RuntimeError):
    """The source audio could not be decoded or transcribed."""


def input_args(path, container="mov"):
    return ["-f", container, "-protocol_whitelist", "file", "-i", str(path)]


def audio_tracks(command, path):
    return json.loads(command([
        "ffprobe", "-v", "error", "-f", "mov", "-protocol_whitelist", "file",
        "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "json", str(path),
    ], 12))["streams"]


def decode_wave(command, source, target, seconds):
    """Decode a single audio stream from a bounded source for local inference."""
    command([
        "ffmpeg", "-nostdin", "-v", "error", "-y", *input_args(source), "-map", "0:a:0",
        "-t", str(seconds), "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(target),
    ], 15)


def speech_lines(command, source, seconds, cuts=None):
    """Return time-aligned speech segments on the source timeline."""
    try:
        if not audio_tracks(command, source):
            return []
        wave = source.with_suffix(".wav")
        command([
            "ffmpeg", "-nostdin", "-v", "error", "-y", *input_args(source), "-map", "0:a:0",
            "-af", "aresample=16000:async=1:first_pts=0", "-t", str(seconds), "-ac", "1", "-c:a", "pcm_s16le", str(wave),
        ], 15)
        return json.loads(command([
            sys.executable, str(Path(__file__).resolve()), "speech", str(wave), json.dumps(cuts or [0, seconds]),
        ], 45))
    except (OSError, ValueError, subprocess.TimeoutExpired) as cause:
        raise SpeechRecognitionError("The source audio could not be transcribed") from cause


def stem(command, source, seconds, which, target):
    """Extract the vocal or instrumental stem with the worker's installed model."""
    wave = target.with_name(target.stem + "-input.wav")
    decode_wave(command, source, wave, seconds)
    command([sys.executable, str(Path(__file__).resolve()), which, str(wave), str(target)], 90)
    wave.unlink()


def music_range(command, path, settings):
    """Validate a selected span against the uploaded file's decoded audio stream."""
    if not isinstance(settings, dict) or settings.keys() != {"format", "start", "end"}:
        raise ValueError("Invalid music settings")
    container, start, end = settings["format"], settings["start"], settings["end"]
    if not isinstance(container, str) or container not in MUSIC_FORMATS or type(start) not in (int, float) or type(end) not in (int, float):
        raise ValueError("Invalid music range")
    probe = json.loads(command([
        "ffprobe", "-v", "error", "-f", container, "-protocol_whitelist", "file", "-select_streams", "a:0",
        "-show_entries", "stream=duration:format=duration", "-of", "json", str(path),
    ], 15))
    stream = probe["streams"][0]
    duration = float(stream.get("duration", probe["format"].get("duration", "nan")))
    if not math.isfinite(duration) or not 0 <= start < end <= duration + 0.1 or min(end, duration) - start < 0.049:
        raise ValueError("Music range is outside the uploaded audio")
    return container, start, min(end, duration)


def mix_music(command, video, music, settings, output):
    """Keep the picture and mix the selected music span under the vocal stem."""
    info = json.loads(command([
        "ffprobe", "-v", "error", "-f", "mov", "-protocol_whitelist", "file", "-select_streams", "V:0",
        "-show_entries", "stream=duration:format=duration", "-of", "json", str(video),
    ], 12))
    seconds = float(info["streams"][0].get("duration", info["format"]["duration"]))
    if not 3.5 <= seconds <= 30.5:
        raise ValueError("Unsupported soundtrack duration")
    container, start, end = music_range(command, music, settings)
    clip = output.with_name("music-clip.wav")
    command([
        "ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", str(start), *input_args(music, container),
        "-map", "0:a:0", "-t", str(min(end - start, seconds)), "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(clip),
    ], 20)
    if clip.stat().st_size <= 78:
        raise ValueError("The selected music range is empty")
    args = ["ffmpeg", "-nostdin", "-v", "error", "-y", *input_args(video), "-stream_loop", "-1", *input_args(clip, "wav")]
    if audio_tracks(command, video):
        voice = output.with_name("vocals.wav")
        stem(command, video, seconds, "vocals", voice)
        args.extend([*input_args(voice, "wav"), "-filter_complex",
                     "[1:a]volume=0.25[bgm];[2:a]volume=0.75[voice];[bgm][voice]amix=inputs=2:normalize=0[mix]", "-map", "[mix]"])
    else:
        args.extend(["-map", "1:a:0"])
    command([*args, "-map", "0:V:0", "-t", str(seconds), "-c:v", "copy", "-c:a", "aac",
             "-movflags", "+faststart", str(output)], 20)


if __name__ == "__main__":
    operation, wave, *paths = sys.argv[1:]
    if operation == "speech":
        from speech import transcribe

        print(json.dumps(transcribe(wave, json.loads(paths[0])), ensure_ascii=True, allow_nan=False))
    else:
        from rea_video.stems import load_stereo, save_wav, separate

        vocals, music = separate(load_stereo(wave))
        save_wav(vocals if operation == "vocals" else music, Path(paths[0]))
