"""Build a bounded edit reel and restore its rendered shots to the source timeline."""
import json
import math
from fractions import Fraction
from audio import audio_tracks, input_args, stem

EDIT_LIMIT = 120 * 1024 * 1024
VIDEO_LIMIT = 30 * 1024 * 1024
MAX_SHOTS = 120
CLIP_DURATION_TOLERANCE = 0.2
WHOLE_EDIT_DURATION_TOLERANCE = 0.4
MP4_AUDIO_CODECS = {"aac", "alac", "mp3", "ac3", "eac3"}


def video_info(path, command, *, generated=False):
    """Read dimensions, rotation, duration and rate from a local MP4-family file."""
    result = json.loads(command([
        "ffprobe", "-v", "error", "-f", "mov", "-protocol_whitelist", "file", "-select_streams", "v:0",
        "-show_entries", "format=duration:stream=width,height,avg_frame_rate:stream_tags=rotate:stream_side_data_list",
        "-of", "json", str(path),
    ], 12))
    stream = result["streams"][0]
    rotation = next((info["rotation"] for info in stream.get("side_data_list", []) if "rotation" in info),
                    stream.get("tags", {}).get("rotate", 0))
    width, height = stream["width"], stream["height"]
    if int(rotation) % 180 == 90:
        width, height = height, width
    seconds = float(result["format"]["duration"])
    rate = Fraction(stream["avg_frame_rate"])
    limits = (min(width, height) >= 2 and max(width, height) <= 6000 and width * height <= 4096 * 2160
              if generated else 2 <= min(width, height) <= 1080 and max(width, height) <= 1920)
    if not math.isfinite(seconds) or not 0 < rate <= 60 or not limits:
        raise ValueError("Unsupported edit video metadata")
    return seconds, rate, width - width % 2, height - height % 2


def frame_ranges(plan, seconds, fps):
    """Convert sorted source ranges to one shared frame grid."""
    if not isinstance(plan, list) or not 1 <= len(plan) <= MAX_SHOTS:
        raise ValueError("Invalid edit ranges")
    total = math.floor(seconds * fps + 0.5)
    previous = 0
    result = []
    for bounds in plan:
        if not isinstance(bounds, list) or len(bounds) != 2:
            raise ValueError("Invalid edit range")
        start, end = bounds
        if (type(start) not in (float, int) or type(end) not in (float, int)
                or not 0 <= start < end <= seconds + 0.08):
            raise ValueError("Edit range is outside the source video")
        first = math.floor(start * fps + 0.5)
        last = min(total, math.floor(end * fps + 0.5))
        if not previous <= first < last <= total:
            raise ValueError("Edit ranges overlap or are shorter than a frame")
        result.append((first, last))
        previous = last
    return total, result


def render(command, source, edited, output, pieces, fps, width, height, frames, pad_frames=0, edited_scale=1,
           audio_mode=None):
    """Encode picture ranges and assemble the selected soundtrack on the source timeline."""
    filters = []
    for index, (input_index, first, last) in enumerate(pieces):
        retime = f"setpts={edited_scale:.9f}*(PTS-STARTPTS)," if input_index == 1 and edited_scale != 1 else ""
        filters.append(
            f"[{input_index}:v:0]{retime}fps={fps},tpad=stop_mode=clone:stop_duration=0.25,"
            f"trim=start_frame={first}:end_frame={last},setpts=PTS-STARTPTS,"
            f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[p{index}]"
        )
    inputs = "".join(f"[p{i}]" for i in range(len(pieces)))
    filters.append(f"{inputs}concat=n={len(pieces)}:v=1:a=0,setpts=N/({fps}*TB),fps={fps},"
                   f"tpad=stop_mode=clone:stop={pad_frames + 1},trim=end_frame={frames}[result]")
    args = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-filter_complex_threads", "2"]
    for path in (source, edited):
        if path is not None:
            args.extend(["-threads", "2", *input_args(path)])
    audio_arguments = []
    if audio_mode:
        if not audio_tracks(command, edited):
            raise ValueError("Provider returned no requested audio track")
        seconds = float(frames / fps)
        fit = f"atempo={1 / edited_scale:.9f},apad,atrim=duration={seconds:.9f}"
        if audio_mode == "keep-music" and audio_tracks(command, source):
            original_music = output.with_name("original-music.wav")
            edited_voice = output.with_name("edited-voice.wav")
            stem(command, source, seconds, "music", original_music)
            stem(command, edited, seconds / edited_scale, "vocals", edited_voice)
            args.extend([*input_args(original_music, "wav"), *input_args(edited_voice, "wav")])
            filters.extend([f"[3:a]{fit},volume=0.75[voice]", "[2:a]volume=0.75[music]",
                            f"[voice][music]amix=inputs=2:normalize=0,alimiter=limit=0.98,atrim=duration={seconds:.9f}[audio]"])
        else:
            filters.append(f"[1:a]{fit}[audio]")
        audio_arguments = ["-map", "[audio]", "-c:a", "aac"]
    elif edited is not None:
        audio_arguments = ["-map", "0:a?", "-c:a", "copy"]
        for index, track in enumerate(audio_tracks(command, source)):
            if track["codec_name"] not in MP4_AUDIO_CODECS:
                audio_arguments.extend([f"-c:a:{index}", "alac"])
    args.extend(["-filter_complex", ";".join(filters), "-map", "[result]", *audio_arguments])
    args.extend([
        "-r", str(fps), "-threads", "2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-maxrate", "5M", "-bufsize", "8M",
        "-movflags", "+faststart", str(output),
    ])
    command(args, 115)
    if not 0 < output.stat().st_size <= VIDEO_LIMIT:
        raise ValueError("Edited clip exceeds the video size limit")


def edit_video(command, source, out, plan, edited=None, output_settings=None):
    """Prepare selected shots or fit a supplied render and its soundtrack to the source frame grid."""
    duration, original_rate, width, height = video_info(source, command)
    if not 4 <= duration <= 30:
        raise ValueError("Source duration outside the edit range")
    render_seconds = None
    audio_mode = None
    if output_settings is not None:
        if edited is None or not isinstance(output_settings, dict) or output_settings.keys() - {"seconds", "audio"}:
            raise ValueError("Invalid edit output settings")
        if "audio" in output_settings:
            audio_mode = output_settings["audio"]
            if audio_mode not in ("generated", "keep-music") or plan is not None:
                raise ValueError("Generated audio requires a whole-video edit")
        if "seconds" in output_settings:
            render_seconds = output_settings["seconds"]
            if type(render_seconds) is not int or not 4 <= render_seconds <= 15:
                raise ValueError("Invalid generated render duration")
    if plan is None:
        if edited is None:
            raise ValueError("Whole edit requires a rendered video")
        fps = original_rate
        original_frames = math.floor(duration * fps + 0.5)
        reel_frames = original_frames
        ranges = [(0, original_frames)]
    else:
        fps = max(24, min(60, round(original_rate)))
        original_frames, ranges = frame_ranges(plan, duration, fps)
        selected_frames = sum(last - first for first, last in ranges)
        if selected_frames >= original_frames:
            raise ValueError("Selected ranges cover the whole video")
        reel_frames = max(selected_frames, 4 * fps + 1)
    if edited is None:
        render(command, source, None, out, [(0, start, end) for start, end in ranges],
               fps, width, height, reel_frames, reel_frames - selected_frames)
        return fps, reel_frames / fps

    reel_seconds = float(reel_frames / fps)
    edited_seconds, _, edited_width, edited_height = video_info(edited, command, generated=output_settings is not None)
    duration_delta = abs(edited_seconds - (render_seconds or reel_seconds))
    aligns_to_source = plan is None and render_seconds is None
    tolerance = WHOLE_EDIT_DURATION_TOLERANCE if aligns_to_source or audio_mode else CLIP_DURATION_TOLERANCE
    if duration_delta > tolerance:
        raise ValueError("Rendered edit does not match the selected shot timeline")
    if output_settings is not None:
        # Fit an output canvas to the delivered resolution without changing the source aspect ratio.
        size_scale = min(edited_width / width, edited_height / height)
        width = max(2, round(width * size_scale / 2) * 2)
        height = max(2, round(height * size_scale / 2) * 2)
    retime = render_seconds is not None or audio_mode is not None or duration_delta > CLIP_DURATION_TOLERANCE
    edited_scale = reel_seconds / edited_seconds if retime else 1
    pieces = []
    source_cursor = 0
    reel_cursor = 0
    for start, end in ranges:
        if source_cursor < start:
            pieces.append((0, source_cursor, start))
        length = end - start
        pieces.append((1, reel_cursor, reel_cursor + length))
        source_cursor = end
        reel_cursor += length
    if source_cursor < original_frames:
        pieces.append((0, source_cursor, original_frames))
    render(command, source, edited, out, pieces, fps, width, height, original_frames, edited_scale=edited_scale,
           audio_mode=audio_mode)
    return float(fps), float(original_frames / fps)
