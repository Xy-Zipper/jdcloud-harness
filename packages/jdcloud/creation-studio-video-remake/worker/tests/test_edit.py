"""Check assembled picture ranges and audio data against generated local fixtures."""
import json
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

from audio import mix_music, speech_lines
from edit import edit_video
from server import command, prepare_source
from speech import lines_at_cuts


def ffmpeg(*args):
    return subprocess.check_output(["ffmpeg", "-nostdin", "-v", "error", *map(str, args)], timeout=20)


def probe(path, *args):
    return json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", *args, "-of", "json", str(path),
    ], timeout=10))


def audio_packets(path):
    return probe(path, "-select_streams", "a", "-show_packets", "-show_data_hash", "sha256",
                 "-show_entries", "packet=stream_index,pts,duration,data_hash")["packets"]


def frame_count(path):
    return probe(path, "-select_streams", "v:0", "-show_entries", "stream=nb_frames")["streams"][0]["nb_frames"]


def frame_size(path):
    stream = probe(path, "-select_streams", "v:0", "-show_entries", "stream=width,height")["streams"][0]
    return stream["width"], stream["height"]


def brightness(path, seconds):
    return ffmpeg("-ss", seconds, "-i", path, "-frames:v", 1, "-vf", "scale=1:1,format=gray",
                  "-f", "rawvideo", "-")[0]


def tone_at(path, second):
    data = ffmpeg("-ss", second, "-i", path, "-t", 0.2, "-vn", "-ac", 1, "-ar", 8000, "-f", "s16le", "-")
    samples = struct.unpack(f"<{len(data) // 2}h", data)
    return sum(a < 0 <= b for a, b in zip(samples, samples[1:])) / 0.2


class EditTimelineTest(unittest.TestCase):
    def test_transcript_uses_audio_timeline_and_skips_silent_videos(self):
        with tempfile.TemporaryDirectory(prefix="studio-transcript-test-") as tmp:
            source = Path(tmp) / "source.mp4"
            picture = ["-f", "lavfi", "-i", "color=white:s=160x96:r=24:d=5"]
            ffmpeg(*picture, "-c:v", "libx264", "-threads", 2, source)
            self.assertEqual(speech_lines(command, source, 5), [])
            ffmpeg("-y", *picture, "-itsoffset", "1.5", "-f", "lavfi", "-i", "sine=f=440:d=3.5",
                   "-c:v", "libx264", "-threads", 2, "-c:a", "aac", source)

            def recognize(args, timeout):
                if args[-3] != "speech":
                    return command(args, timeout)
                self.assertLess(tone_at(args[-2], 0.8), 1)
                self.assertAlmostEqual(tone_at(args[-2], 2.0), 440, delta=15)
                self.assertEqual(json.loads(args[-1]), [0, 2, 5])
                return b'[{"start": 1.5, "end": 2, "original": "Hi.", "shotNumber": 1}]'

            self.assertEqual(speech_lines(recognize, source, 5, [0, 2, 5]),
                             [{"start": 1.5, "end": 2, "original": "Hi.", "shotNumber": 1}])

    def test_recognized_words_are_not_split_or_copied_at_cuts(self):
        tokens = [" In", "ter", "view", " cuts", " phrase", ".", "欢", "迎", "来", "吧", "。"]
        stamps = [0, .1, .2, .6, 1, 1.1, 1.3, 1.4, 1.6, 1.7, 1.8]
        shots = lines_at_cuts(tokens, stamps, 0, 2, [0, .15, 1, 1.5, 2])
        self.assertEqual([row["shotNumber"] for row in shots], [1, 2, 3, 3, 4])
        self.assertEqual([row["original"] for row in shots], ["Interview", "cuts", "phrase.", "欢迎", "来吧。"])
        self.assertEqual(shots[0]["end"], .15)
        with self.assertRaises(ValueError):
            lines_at_cuts(tokens, stamps[:-1], 0, 2, [0, .15, 1, 1.5, 2])

    def test_prepares_quicktime_for_mp4_upload_with_the_original_timeline_and_audio(self):
        with tempfile.TemporaryDirectory(prefix="studio-source-test-") as tmp:
            root = Path(tmp)
            source = root / "source.mov"
            output = root / "prepared.mp4"
            ffmpeg("-f", "lavfi", "-i", "color=white:s=160x96:r=24:d=5",
                   "-f", "lavfi", "-i", "sine=f=440:d=5",
                   "-c:v", "libx264", "-threads", 2, "-c:a", "pcm_s16le", source)
            self.assertEqual(source.read_bytes()[8:12], b"qt  ")

            prepare_source(source, output)

            self.assertEqual(output.read_bytes()[4:8], b"ftyp")
            self.assertNotEqual(output.read_bytes()[8:12], b"qt  ")
            self.assertEqual(frame_count(output), frame_count(source))
            self.assertGreater(brightness(output, 2.5), 200)
            result = probe(output, "-show_entries", "format=duration:stream=codec_type,codec_name")
            self.assertAlmostEqual(float(result["format"]["duration"]), 5, delta=0.08)
            self.assertEqual([(stream["codec_type"], stream["codec_name"]) for stream in result["streams"]],
                             [("video", "h264"), ("audio", "aac")])

    def test_original_audio_and_unselected_shots_survive_assembly(self):
        with tempfile.TemporaryDirectory(prefix="studio-edit-test-") as tmp:
            root = Path(tmp)
            source = root / "source.mp4"
            ffmpeg("-f", "lavfi", "-i", "color=white:s=160x96:r=24:d=5",
                   "-f", "lavfi", "-i", "sine=f=440:d=5",
                   "-itsoffset", "0.15", "-f", "lavfi", "-i", "sine=f=660:d=4.84",
                   "-map", "0:v", "-map", "1:a", "-map", "2:a",
                   "-c:v", "libx264", "-threads", 2, "-c:a", "aac", source)
            original_audio = audio_packets(source)
            self.assertEqual({packet["stream_index"] for packet in original_audio}, {1, 2})

            for plan, seconds, matches_source in ((None, 5, ()), ([[1, 2], [3, 4]], 4.042, (0.5, 2.5, 4.5))):
                with self.subTest(plan=plan):
                    candidate = root / "edited.mp4"
                    output = root / "merged.mp4"
                    ffmpeg("-y", "-f", "lavfi", "-i", f"color=black:s=160x96:r=24:d={seconds}",
                           "-c:v", "libx264", "-threads", 2, candidate)
                    edit_video(command, source, output, plan, candidate)
                    self.assertEqual(audio_packets(output), original_audio)
                    self.assertEqual(frame_count(output), frame_count(source))
                    for time in (0.5, 1.5, 2.5, 3.5, 4.5):
                        self.assertEqual(brightness(output, time) > 200, time in matches_source)

            # An integer model render is expanded back to the 4.25-second edit reel.
            ffmpeg("-y", "-f", "lavfi", "-i", "color=black:s=320x192:r=24:d=4",
                   "-c:v", "libx264", "-threads", 2, candidate)
            edit_video(command, source, output, [[0.25, 2.25], [2.75, 5]], candidate, {"seconds": 4})
            self.assertEqual(frame_size(output), (320, 192))
            self.assertEqual(frame_count(output), frame_count(source))
            self.assertEqual(audio_packets(output), original_audio)
            self.assertGreater(brightness(output, 2.5), 200)
            self.assertLess(brightness(output, 4.9), 32)

    def test_whole_edit_retimes_a_shorter_render_with_original_audio(self):
        with tempfile.TemporaryDirectory(prefix="studio-whole-edit-test-") as tmp:
            root = Path(tmp)
            source, edited, output = (root / f"{name}.mp4" for name in ("source", "edited", "merged"))
            ffmpeg("-f", "lavfi", "-i", "color=white:s=160x96:r=24:d=5",
                   "-f", "lavfi", "-i", "sine=f=440:d=5", "-c:v", "libx264", "-threads", 2, "-c:a", "aac", source)
            ffmpeg("-f", "lavfi", "-i", "color=black:s=160x96:r=24:d=4.75",
                   "-vf", "drawbox=0:0:iw:ih:white:fill:enable='gte(t,2.375)'",
                   "-c:v", "libx264", "-threads", 2, edited)

            edit_video(command, source, output, None, edited, {})

            self.assertEqual(frame_count(output), frame_count(source))
            self.assertEqual(audio_packets(output), audio_packets(source))
            self.assertLess(brightness(output, 2.42), 32)
            self.assertGreater(brightness(output, 2.58), 200)

            ffmpeg("-y", "-i", edited, "-t", 4.5, "-c:v", "libx264", "-threads", 2, edited.with_name("too-short.mp4"))
            with self.assertRaisesRegex(ValueError, "does not match the selected shot timeline"):
                edit_video(command, source, output, None, edited.with_name("too-short.mp4"), {})

    def test_generated_dialogue_is_kept_on_the_source_timeline(self):
        with tempfile.TemporaryDirectory(prefix="studio-dialogue-test-") as tmp:
            root = Path(tmp)
            source, edited, output = (root / name for name in ("source.mp4", "edited.mp4", "final.mp4"))
            for file, tone, color, duration in ((source, 440, "white", 5), (edited, 880, "black", 4.8)):
                ffmpeg("-f", "lavfi", "-i", f"color={color}:s=160x96:r=24:d={duration}",
                       "-f", "lavfi", "-i", f"sine=f={tone}:d={duration}",
                       "-c:v", "libx264", "-threads", 2, "-c:a", "aac", file)
            edit_video(command, source, output, None, edited, {"audio": "generated"})
            self.assertEqual(frame_count(output), frame_count(source))
            self.assertGreater(tone_at(output, 4.4), 830)

    def test_uploaded_music_repeats_only_the_selected_span_and_keeps_the_picture(self):
        with tempfile.TemporaryDirectory(prefix="studio-music-test-") as tmp:
            root = Path(tmp)
            video, music, output = (root / name for name in ("video.mp4", "music.wav", "final.mp4"))
            ffmpeg("-f", "lavfi", "-i", "color=white:s=160x96:r=24:d=5", "-c:v", "libx264", "-threads", 2, video)
            ffmpeg("-f", "lavfi", "-i", "sine=f=440:d=1", "-f", "lavfi", "-i", "sine=f=880:d=1",
                   "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1", music)
            with self.assertRaises(ValueError):
                mix_music(command, video, music, {"format": "wav", "start": 1.2, "end": 3}, output)
            mix_music(command, video, music, {"format": "wav", "start": 1.2, "end": 1.8}, output)
            self.assertEqual(frame_count(video), frame_count(output))
            self.assertEqual(brightness(video, 4.5), brightness(output, 4.5))
            self.assertAlmostEqual(float(probe(output, "-show_entries", "format=duration")["format"]["duration"]), 5, delta=0.06)
            self.assertAlmostEqual(tone_at(output, 4.3), 880, delta=25)
