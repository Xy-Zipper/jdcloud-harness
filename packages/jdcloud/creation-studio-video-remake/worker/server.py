"""Private HTTP worker for bounded, local reference-video analysis."""
import json
import math
import os
import signal
import shutil
import subprocess
import tempfile
from fractions import Fraction
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore
from audio import MUSIC_LIMIT, SpeechRecognitionError, mix_music, music_range, speech_lines
from capacity import MIB, detect_capacity
from captions import SETTINGS_LIMIT, probe_captions, sync_captions
from edit import EDIT_LIMIT, edit_video

MAX_BYTES = 30 * 1024 * 1024
MIN_SECONDS = 4
MAX_SECONDS = 30
MAX_PIXELS = 1920 * 1080


def command(args, timeout):
    """Collect short diagnostics and terminate the entire subprocess group on timeout."""
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True) as process:
        try:
            stdout, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise
        if process.returncode:
            raise ValueError("The media command rejected the video")
        return stdout


def measure(video):
    """Validate media metadata and measure the original duration."""
    probe = json.loads(command([
        "ffprobe", "-v", "error", "-f", "mov", "-protocol_whitelist", "file",
        "-select_streams", "V:0", "-show_entries",
        "format=duration:stream=width,height,avg_frame_rate",
        "-of", "json", str(video),
    ], 12))
    stream = probe["streams"][0]
    duration = float(probe["format"]["duration"])
    fps = Fraction(stream["avg_frame_rate"])
    if (not MIN_SECONDS <= duration <= MAX_SECONDS or not 0 < fps <= 60
            or not 0 < stream["width"] * stream["height"] <= MAX_PIXELS
            or max(stream["width"], stream["height"]) > 1920
            or min(stream["width"], stream["height"]) > 1080):
        raise ValueError("Unsupported video duration, frame rate or dimensions")

    return duration


def analyze(video, directory):
    """Measure cuts and transcribe the original soundtrack on the same timeline."""
    duration = measure(video)
    output = directory / "analysis"
    command([
        "rea-video", "decompose", str(video), "-o", str(output), "--workers", "2",
        "--no-vlm", "--no-asr", "--no-stems", "--no-ocr", "--no-packaging", "--no-moments",
    ], 120)
    breakdown = json.loads((output / "breakdown.json").read_text(encoding="utf-8"))
    shots = [{"start": shot["start"], "end": shot["end"]} for shot in breakdown["shots"]]
    return {
        "duration": duration,
        "shots": shots,
        "dialogue": speech_lines(command, video, duration, [0, *[shot["start"] for shot in shots[1:]], duration]),
    }


def prepare_source(source, output):
    """Convert QuickTime footage to browser-playable MP4 on the measured source timeline."""
    duration = measure(source)
    subtitles = json.loads(command([
        "ffprobe", "-v", "error", "-f", "mov", "-protocol_whitelist", "file", "-select_streams", "s",
        "-show_entries", "stream=index,codec_name", "-of", "json", str(source),
    ], 12))["streams"]
    subtitle_maps = [argument for stream in subtitles if stream["codec_name"] in {"mov_text", "text", "subrip"}
                     for argument in ("-map", f"0:{stream['index']}")]
    command([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-threads", "2", "-f", "mov", "-protocol_whitelist", "file", "-i", str(source),
        "-map", "0:V:0", "-map", "0:a?", *subtitle_maps, "-map_metadata", "-1", "-map_chapters", "-1",
        "-vsync", "0", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-threads", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
        "-crf", "18", "-maxrate", "5M", "-bufsize", "5M",
        "-c:a", "aac", "-c:s", "mov_text", "-movflags", "+faststart", "-f", "mp4", str(output),
    ], 115)
    if not 0 < output.stat().st_size <= MAX_BYTES or abs(measure(output) - duration) > 0.08:
        raise ValueError("Prepared MP4 size or timeline does not match the source")


class WorkerServer(ThreadingHTTPServer):
    """Run at most the advertised number of media requests at the same time."""

    def __init__(self, address, handler, concurrency):
        self.concurrency = concurrency
        self.available = BoundedSemaphore(concurrency)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        self.available.acquire()
        try:
            super().process_request(request, client_address)
        except Exception:
            self.available.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.available.release()


class Handler(BaseHTTPRequestHandler):
    """Accept one authenticated-through-Harness upload over the private network."""

    def setup(self):
        self.request.settimeout(10)
        super().setup()

    def reply(self, status, data, *, full_edit_supported=False, error_code=None):
        body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if error_code:
            self.send_header("X-Remake-Error", error_code)
        if full_edit_supported:
            self.send_header("X-Remake-Full-Edit", "1")
            self.send_header("X-Remake-Output-Settings", "1")
            self.send_header("X-Remake-Audio-Edit", "1")
            self.send_header("X-Remake-Worker-Concurrency", str(self.server.concurrency))
        self.end_headers()
        self.wfile.write(body)

    def save_video(self, path, size):
        """Read exactly one bounded file at the current body offset."""
        prefix = self.rfile.read(12)
        if len(prefix) != 12 or prefix[4:8] != b"ftyp":
            raise ValueError("Invalid MP4 container")
        self.save_file(path, size, prefix)

    def save_file(self, path, size, prefix=b""):
        with path.open("wb") as target:
            target.write(prefix)
            remaining = size - len(prefix)
            while remaining:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    raise ValueError("Incomplete upload")
                target.write(chunk)
                remaining -= len(chunk)

    def edit(self, size, directory):
        source_size = int(self.headers.get("X-Remake-Source-Length", str(size)))
        edited_size = size - source_size
        if not 12 <= source_size <= MAX_BYTES or (
                self.path == "/prepare-edit" and edited_size != 0) or (
                self.path == "/merge-edit" and not 12 <= edited_size <= EDIT_LIMIT):
            return self.reply(413, {})
        plan = json.loads(self.headers.get("X-Remake-Ranges", ""))
        output_settings = json.loads(self.headers.get("X-Remake-Output-Settings", "null"))
        source = directory / "source.mp4"
        self.save_video(source, source_size)
        edited = None
        if edited_size:
            edited = directory / "edited.mp4"
            self.save_video(edited, edited_size)
        output = directory / "result.mp4"
        fps, duration = edit_video(command, source, output, plan, edited, output_settings)
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(output.stat().st_size))
        self.send_header("X-Remake-FPS", str(fps))
        self.send_header("X-Remake-Duration", str(duration))
        self.send_header("X-Remake-Output-Settings", "1")
        self.end_headers()
        with output.open("rb") as video:
            shutil.copyfileobj(video, self.wfile, 65536)

    def soundtrack(self, size, directory):
        settings = json.loads(self.headers.get("X-Remake-Music", "null"))
        music = directory / "music"
        if self.path == "/probe-bgm":
            self.save_file(music, size)
            music_range(command, music, settings)
            return self.reply(200, {})
        video_size = int(self.headers.get("X-Remake-Source-Length", "0"))
        if not 12 <= video_size <= EDIT_LIMIT or not 12 <= size - video_size <= MUSIC_LIMIT:
            return self.reply(413, {})
        video = directory / "video.mp4"
        self.save_video(video, video_size)
        self.save_file(music, size - video_size)
        output = directory / "result.mp4"
        mix_music(command, video, music, settings, output)
        if not 0 < output.stat().st_size <= EDIT_LIMIT:
            raise ValueError("Soundtrack result exceeds the size limit")
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(output.stat().st_size))
        self.end_headers()
        with output.open("rb") as result:
            shutil.copyfileobj(result, self.wfile, 65536)

    def captions(self, size, directory):
        """Render a saved caption plan over the composed picture and copy the audio."""
        video_size = int(self.headers.get("X-Remake-Source-Length", "0"))
        setting_size = size - video_size
        if not 12 <= video_size <= EDIT_LIMIT or not 1 <= setting_size <= SETTINGS_LIMIT:
            return self.reply(413, {})
        video = directory / "video.mp4"
        self.save_video(video, video_size)
        settings = self.rfile.read(setting_size)
        if len(settings) != setting_size:
            raise ValueError("Incomplete caption settings")
        output = directory / "captioned.mp4"
        sync_captions(command, video, output, json.loads(settings))
        if not 0 < output.stat().st_size <= EDIT_LIMIT:
            raise ValueError("Captioned video exceeds its size limit")
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(output.stat().st_size))
        self.end_headers()
        with output.open("rb") as result:
            shutil.copyfileobj(result, self.wfile, 65536)

    def do_POST(self):
        if self.path not in {"/analyze", "/probe", "/prepare-source", "/prepare-edit", "/merge-edit",
                             "/transcript", "/probe-bgm", "/mix-bgm", "/probe-captions", "/sync-captions"}:
            return self.reply(404, {})
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400, {})
        limit = MAX_BYTES + EDIT_LIMIT if self.path in {"/merge-edit", "/mix-bgm"} else MAX_BYTES
        if self.path == "/sync-captions":
            limit = EDIT_LIMIT + SETTINGS_LIMIT
        if not 12 <= size <= limit:
            return self.reply(413, {})
        try:
            with tempfile.TemporaryDirectory(prefix="reference-") as work:
                directory = Path(work)
                if self.path in {"/prepare-edit", "/merge-edit"}:
                    return self.edit(size, directory)
                if self.path in {"/probe-bgm", "/mix-bgm"}:
                    return self.soundtrack(size, directory)
                if self.path == "/sync-captions":
                    return self.captions(size, directory)
                video = directory / "reference.mp4"
                self.save_video(video, size)
                if self.path == "/probe-captions":
                    measure(video)
                    return self.reply(200, probe_captions(command, video))
                if self.path == "/transcript":
                    duration = measure(video)
                    cuts = json.loads(self.headers.get("X-Remake-Ranges", "null"))
                    if cuts is None:
                        lines = speech_lines(command, video, duration)
                        return self.reply(200, {"lines": [{k: v for k, v in item.items() if k != "shotNumber"} for item in lines]})
                    if (not isinstance(cuts, list) or not 2 <= len(cuts) <= 121
                            or any(type(t) not in (int, float) or not math.isfinite(t) for t in cuts)
                            or cuts[0] != 0 or abs(cuts[-1] - duration) > .15
                            or any(a >= b for a, b in zip(cuts, cuts[1:])) or cuts[-2] >= duration):
                        raise ValueError("Invalid transcript cut times")
                    return self.reply(200, {"lines": speech_lines(command, video, duration, [*cuts[:-1], min(cuts[-1], duration)])})
                if self.path == "/prepare-source":
                    output = directory / "source-for-upload.mp4"
                    prepare_source(video, output)
                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Content-Length", str(output.stat().st_size))
                    self.end_headers()
                    with output.open("rb") as prepared:
                        shutil.copyfileobj(prepared, self.wfile, 65536)
                    return
                result = {"duration": measure(video)} if self.path == "/probe" else analyze(video, directory)
        except SpeechRecognitionError:
            return self.reply(503, {}, error_code="speech-recognition")
        except (ValueError, KeyError, IndexError, ZeroDivisionError):
            return self.reply(422, {})
        except (subprocess.TimeoutExpired, TimeoutError):
            return self.reply(504, {})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return
        except OSError:
            return self.reply(503, {})
        return self.reply(200, result, full_edit_supported=self.path == "/probe")


if __name__ == "__main__":
    slots, cpus, memory = detect_capacity()
    print(f"video-remake worker slots={slots} cpu_budget={cpus} memory_budget_mib={memory // MIB}", flush=True)
    with WorkerServer(("0.0.0.0", 8090), Handler, slots) as server:
        server.serve_forever()
