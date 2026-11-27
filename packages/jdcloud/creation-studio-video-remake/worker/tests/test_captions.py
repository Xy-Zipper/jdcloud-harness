"""Exercise subtitle work on local video and audio streams without a generation provider."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from captions import FONTS, caption_windows, probe_captions, sync_captions
from server import command, prepare_source
from test_edit import audio_packets, ffmpeg, frame_count


def bright_pixels(video, second, crop):
    frame = ffmpeg("-ss", second, "-i", video, "-frames:v", 1, "-vf", f"crop={crop},format=gray", "-f", "rawvideo", "-")
    return sum(value > 200 for value in frame)


def make_video(path, filters=()):
    ffmpeg("-f", "lavfi", "-i", "color=black:s=240x384:r=24:d=5", "-f", "lavfi", "-i", "sine=f=440:d=5",
           *filters, "-c:v", "libx264", "-threads", 2, "-c:a", "aac", path)


class CaptionsTest(unittest.TestCase):
    def test_source_without_dialogue_subtitles_has_no_caption_plan(self):
        with tempfile.TemporaryDirectory(prefix="studio-captions-test-") as tmp:
            source = Path(tmp) / "source.mp4"
            make_video(source)
            with patch("captions.ocr", return_value=[]):
                self.assertEqual(probe_captions(command, source), {"mode": "none", "cues": []})

    def test_simultaneous_lines_get_a_single_visible_window(self):
        cues = [{"start": 0, "end": 2, "text": "第一句"}, {"start": 1, "end": 3, "text": "第二句"}]
        self.assertEqual(list(caption_windows(cues)), [
            {"start": 0, "end": 1, "text": "第一句"}, {"start": 1, "end": 2, "text": "第一句\n第二句"},
            {"start": 2, "end": 3, "text": "第二句"},
        ])

    @unittest.skipUnless(any(font.is_file() for font in FONTS), "requires the worker's Chinese font")
    def test_applies_confirmed_text_and_preserves_untouched_track_cues_and_audio(self):
        with tempfile.TemporaryDirectory(prefix="studio-captions-test-") as tmp:
            root = Path(tmp)
            source, track, movie, prepared, result = (root / name for name in ("source.mp4", "source.srt", "text.mov", "text.mp4", "result.mp4"))
            make_video(source)
            track.write_text("1\n00:00:00,500 --> 00:00:01,750\nOld dialogue.\n\n2\n00:00:02,500 --> 00:00:03,500\nKeep this.\n", encoding="utf-8")
            ffmpeg("-i", source, "-i", track, "-map", "0", "-map", "1:s", "-c", "copy", "-c:s", "mov_text", movie)
            prepare_source(movie, prepared)
            plan = probe_captions(command, prepared)
            self.assertEqual(plan["mode"], "track")
            self.assertEqual([cue["text"] for cue in plan["cues"]], ["Old dialogue.", "Keep this."])
            edited = "你好，{原话} 90%"
            sync_captions(command, source, result, {**plan, "originalEdit": True, "scale": 1,
                                                   "lines": [{"start": .5, "end": 1.75, "text": edited}]})
            rendered = [path.read_text(encoding="utf-8") for path in sorted(root.glob("caption-*.txt"))]
            self.assertEqual(rendered, [edited, "Keep this."])
            self.assertGreater(bright_pixels(result, 1, "220:80:10:288"), 100)
            self.assertGreater(bright_pixels(result, 3, "220:80:10:288"), 100)
            self.assertEqual(bright_pixels(result, 4, "220:80:10:288"), 0)
            self.assertEqual(frame_count(result), frame_count(source))
            self.assertEqual(audio_packets(result), audio_packets(source))

    @unittest.skipUnless(any(font.is_file() for font in FONTS), "requires the worker's Chinese font")
    def test_erases_matching_burned_subtitles_only_in_edited_part(self):
        with tempfile.TemporaryDirectory(prefix="studio-captions-test-") as tmp:
            root = Path(tmp)
            source, result = root / "source.mp4", root / "result.mp4"
            filters = ("-vf", "drawbox=x=45:y=174:w=150:h=18:color=white:t=fill,drawbox=x=12:y=70:w=45:h=11:color=white:t=fill")
            make_video(source, filters)
            box = [45 / 240, 174 / 384, 150 / 240, 18 / 384]
            logo = [12 / 240, 70 / 384, 45 / 240, 11 / 384]
            old = {"start": .5, "end": 2, "text": "OLD SUBTITLE", "box": box}
            hits = [{"t": 1, "text": "OLD SUBTITLE", "bbox": box}, {"t": 1, "text": "BRAND", "bbox": logo}]
            with patch("captions.ocr", return_value=hits):
                sync_captions(command, source, result, {"mode": "burned", "cues": [old], "originalEdit": True, "scale": 1,
                                                       "lines": [{"start": .5, "end": 2, "text": "中文"}]})
            self.assertLess(bright_pixels(result, 1, "170:30:35:165"), 700)
            self.assertGreater(bright_pixels(result, 1, "170:30:35:165"), 60)
            self.assertEqual(bright_pixels(result, 1, "56:20:6:64"), bright_pixels(source, 1, "56:20:6:64"))
            self.assertEqual(bright_pixels(result, 3, "170:30:35:165"), bright_pixels(source, 3, "170:30:35:165"))
