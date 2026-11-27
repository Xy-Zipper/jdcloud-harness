"""Recognize source dialogue captions and render the saved replacements on the final timeline."""
import json
import math
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

from audio import input_args

SETTINGS_LIMIT = 256 * 1024
MAX_CUES = 120
FONTS = (
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    Path("/System/Library/Fonts/Hiragino Sans GB.ttc"),
)
TIMECODE = r"(\d{2}):(\d{2}):(\d{2}),(\d{3})"
CUE_TIME = re.compile(rf"^{TIMECODE}\s+-->\s+{TIMECODE}(?:\s+.*)?$")


def font_path():
    for font in FONTS:
        if font.is_file():
            return font
    raise ValueError("A Chinese subtitle font is not installed")


def parse_srt(text):
    """Read plain text cues produced by ffmpeg from the source's first text track."""
    def seconds(parts):
        h, m, s, ms = map(int, parts)
        return h * 3600 + m * 60 + s + ms / 1000

    cues = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.splitlines()
        if len(lines) < 3 or not (timing := CUE_TIME.fullmatch(lines[1])):
            continue
        caption = re.sub(r"</?(?:b|i|u|font)(?:\s+[^>]*)?>", "", "\n".join(lines[2:]), flags=re.I).strip()
        if caption:
            cues.append({"start": seconds(timing.groups()[:4]), "end": seconds(timing.groups()[4:]), "text": caption})
    return cues


def ocr(command, video, operation):
    """Keep OCR models and temporary frames in a bounded subprocess."""
    return json.loads(command([sys.executable, str(Path(__file__).resolve()), operation, str(video)], 90))


def valid_cues(rows, *, boxes=False):
    """Validate the normalized cues carried in an assembly receipt."""
    if not isinstance(rows, list) or len(rows) > MAX_CUES:
        raise ValueError("Too many subtitle cues")
    for row in rows:
        if (not isinstance(row, dict) or type(row.get("start")) not in (float, int) or type(row.get("end")) not in (float, int)
                or not 0 <= row["start"] < row["end"] <= 31 or not isinstance(row.get("text"), str)
                or not row["text"].strip() or len(row["text"]) > 500 or "\0" in row["text"]):
            raise ValueError("Invalid subtitle cue")
        if boxes:
            box = row.get("box")
            if (not isinstance(box, list) or len(box) != 4 or any(type(n) not in (float, int) or not 0 <= n <= 1 for n in box)
                    or not 0 < box[2] <= 1.001 - box[0] or not 0 < box[3] <= 1.001 - box[1]):
                raise ValueError("Invalid subtitle box")
    return rows


def probe_captions(command, source):
    """Prefer an embedded text track. Detect burned dialogue captions when the track is absent."""
    tracks = json.loads(command([
        "ffprobe", "-v", "error", "-f", "mov", "-protocol_whitelist", "file", "-select_streams", "s:0",
        "-show_entries", "stream=codec_name", "-of", "json", str(source),
    ], 12))["streams"]
    if tracks:
        text = command(["ffmpeg", "-nostdin", "-v", "error", *input_args(source), "-map", "0:s:0", "-f", "srt", "-"], 15).decode()
        mode, cues = "track", valid_cues(parse_srt(text))
    else:
        mode, cues = "burned", valid_cues(ocr(command, source, "detect"), boxes=True)
    if not cues:
        return {"mode": "none", "cues": []}
    font_path()
    return {"mode": mode, "cues": cues}


def overlaps(left, right):
    return min(left["end"], right["end"]) - max(left["start"], right["start"])


def caption_text(text):
    return "".join(c for c in text.casefold() if c.isalnum())


def old_boxes(hits, original, duration):
    """Erase only text still present in the generated video and matching a source caption."""
    boxes = {}
    for hit in hits:
        text = caption_text(hit["text"])
        if len(text) < 2:
            continue
        x, y, w, h = hit["bbox"]
        for index, cue in enumerate(original):
            if not cue["start"] - 0.25 <= hit["t"] < cue["end"] + 0.25:
                continue
            cx, cy, cw, ch = cue["box"]
            if abs(y + h / 2 - cy - ch / 2) > 0.045 or min(x + w, cx + cw) <= max(x, cx):
                continue
            expected = caption_text(cue["text"])
            if text != expected and (len(text) < 4 or (text not in expected and SequenceMatcher(None, text, expected).ratio() < 0.68)):
                continue
            if index not in boxes:
                boxes[index] = (x, y, x + w, y + h)
            else:
                left, top, right, bottom = boxes[index]
                boxes[index] = (min(left, x), min(top, y), max(right, x + w), max(bottom, y + h))
            break
    return [(max(0, original[index]["start"] - .12), min(duration, original[index]["end"] + .12), left, top, right - left, bottom - top)
            for index, (left, top, right, bottom) in boxes.items()]


def wrap(text, font, width):
    """Wrap CJK at character boundaries and Latin speech at word boundaries."""
    lines = []
    for paragraph in text.splitlines():
        line = ""
        for token in re.findall(r"[\u3000-\u9fff]|[^\s\u3000-\u9fff]+|\s+", paragraph):
            if line and font.getlength(line + token) > width:
                lines.append(line.rstrip())
                line = ""
            for char in token.lstrip() if not line else token:
                if line and font.getlength(line + char) > width:
                    lines.append(line.rstrip())
                    line = ""
                line += char
        if line.strip():
            lines.append(line.rstrip())
    return lines


def draw_filters(cues, directory, width, height):
    """Load the dialogue as literal text files, never as filter expressions."""
    from PIL import ImageFont

    font_file = font_path()
    size = max(16, round(min(width, height) * .052))
    font = ImageFont.truetype(str(font_file), size)
    filters = []
    for index, cue in enumerate(cues):
        rows = wrap(cue["text"], font, width * .88)
        groups = [rows[i:i + 2] for i in range(0, len(rows), 2)]
        for offset, group in enumerate(groups):
            start, end = cue["start"], cue["end"]
            window = (end - start) / len(groups)
            path = directory / f"caption-{index}-{offset}.txt"
            path.write_text("\n".join(group), encoding="utf-8")
            y = cue.get("y", .88)
            filters.append(f"drawtext=fontfile='{font_file}':textfile='{path}':expansion=none:fontcolor=white:"
                           f"fontsize={size}:borderw={max(2, round(size * .12))}:bordercolor=black:line_spacing=5:"
                           f"x=(w-tw)/2:y='max(8,min(h-th-8,h*{y:.4f}-th/2))':"
                           f"enable='gte(t,{start + window * offset:.6f})*lt(t,{start + window * (offset + 1):.6f})'")
    return filters


def keep_track_cues(original, updates):
    """Clip original track cues around the edited time windows."""
    for cue in original:
        remaining = [(cue["start"], cue["end"])]
        for edit in updates:
            remaining = [(a, b) for start, end in remaining for a, b in ((start, min(end, edit["start"])),
                                                                        (max(start, edit["end"]), end)) if a < b]
        yield from ({**cue, "start": a, "end": b} for a, b in remaining)


def caption_windows(cues):
    """Give simultaneous lines a shared layout so two speakers never paint on top of each other."""
    ordered = sorted(cues, key=lambda cue: cue["start"])
    times = sorted({t for cue in cues for t in (cue["start"], cue["end"])})
    for start, end in zip(times, times[1:]):
        lines = [cue for cue in ordered if cue["start"] < end and cue["end"] > start]
        if lines:
            yield {**lines[0], "start": start, "end": end, "text": "\n".join(line["text"] for line in lines)}


def sync_captions(command, video, output, settings):
    """Keep untouched captions and render exactly the saved dialogue for edited intervals."""
    if not isinstance(settings, dict) or settings.get("mode") not in ("burned", "track"):
        raise ValueError("Invalid caption settings")
    original = valid_cues(settings.get("cues"), boxes=settings["mode"] == "burned")
    updates = valid_cues(settings.get("lines"))
    scale = settings.get("scale")
    if not original or not updates or type(scale) not in (int, float) or not 0 < scale <= 8 or type(settings.get("originalEdit")) is not bool:
        raise ValueError("Invalid caption timing")
    info = json.loads(command([
        "ffprobe", "-v", "error", "-f", "mov", "-protocol_whitelist", "file", "-select_streams", "V:0",
        "-show_entries", "stream=width,height,duration:format=duration", "-of", "json", str(video),
    ], 12))
    stream = info["streams"][0]
    duration = float(stream.get("duration", info["format"]["duration"]))
    width, height = stream["width"], stream["height"]
    if not 3.5 <= duration <= 30.5 or width < 2 or height < 2:
        raise ValueError("Invalid caption video")

    def scale_cue(row):
        return {**row, "start": row["start"] * scale, "end": min(duration, row["end"] * scale)}

    original = [scale_cue(row) for row in original if row["start"] * scale < duration]
    updated = [scale_cue(row) for row in updates if row["start"] * scale < duration]
    if not updated:
        raise ValueError("Updated dialogue is outside the generated video")
    filters = []
    if settings["mode"] == "burned":
        for row in updated:
            cue = max(original, key=lambda c: overlaps(c, row), default=None)
            if cue and overlaps(cue, row) > 0:
                row["y"] = cue["box"][1] + cue["box"][3] / 2
        affected = [cue for cue in original if any(overlaps(cue, row) >= min(.15, (cue["end"] - cue["start"]) / 2,
                                                                         (row["end"] - row["start"]) / 2) for row in updated)]
        if settings["originalEdit"] and affected:
            for start, end, x, y, w, h in old_boxes(ocr(command, video, "scan"), affected, duration):
                x0, y0 = max(2, int(x * width) - 4), max(2, int(y * height) - 4)
                x1, y1 = min(width - 2, math.ceil((x + w) * width) + 4), min(height - 2, math.ceil((y + h) * height) + 4)
                if x1 > x0 + 2 and y1 > y0 + 2:
                    filters.append(f"delogo=x={x0}:y={y0}:w={x1 - x0}:h={y1 - y0}:enable='gte(t,{start:.6f})*lt(t,{end:.6f})'")
    elif settings["originalEdit"]:
        updated = [*updated, *keep_track_cues(original, updated)]

    filters.extend(draw_filters(caption_windows(updated), output.parent, width, height))
    graph = output.with_suffix(".filter")
    graph.write_text(",\n".join(filters), encoding="utf-8")
    command(["ffmpeg", "-nostdin", "-v", "error", "-y", "-filter_threads", "2", *input_args(video),
             "-filter_script:v", str(graph), "-map", "0:V:0", "-map", "0:a?", "-c:v", "libx264", "-threads", "2",
             "-preset", "veryfast", "-crf", "17", "-maxrate", "12M", "-bufsize", "12M", "-pix_fmt", "yuv420p",
             "-c:a", "copy", "-movflags", "+faststart", str(output)], 100)


if __name__ == "__main__":
    from rea_video.media import video_info
    from rea_video.overlay import get_ocr
    from rea_video.packaging import build_cues, classify_cues, merge_style, ocr_pass

    operation, media = sys.argv[1:]
    if get_ocr() is None:
        raise ValueError("Subtitle OCR is not installed")
    info = video_info(media)
    items, step = ocr_pass(media, info)
    if operation == "detect":
        cues = build_cues(items, step)
        for cue in cues:
            cue["style"] = merge_style(cue.pop("style_obs"))
        classify_cues(cues, info.duration)
        items = [{"start": max(0, cue["t0"]), "end": min(info.duration, cue["t1"]), "text": cue["text"], "box": cue["bbox"]}
                 for cue in cues if cue["kind"] == "subtitle" and max(0, cue["t0"]) < min(info.duration, cue["t1"])]
    else:
        items = [{"t": float(item["t"]), "text": item["text"], "bbox": [float(n) for n in item["bbox"]]} for item in items]
    print(json.dumps(items, ensure_ascii=False, allow_nan=False))
