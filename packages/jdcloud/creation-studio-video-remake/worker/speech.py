"""Transcribe uninterrupted speech and place each recognized word on the cut timeline."""
import math
import re
from bisect import bisect_right

CJK = r"\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af"
LETTER = rf"[^\W_{CJK}]"
WORD = re.compile(rf"[{CJK}]|{LETTER}+(?:['’\-]{LETTER}+)*")
SENTENCE_END = re.compile(r"[.!?。！？…][\s\"'’”」』)]*$")


def words_at(tokens, timestamps):
    """Join word pieces before assigning a time so a cut cannot split the spelling of a word."""
    text = "".join(tokens)
    offsets = [0]
    for token in tokens:
        offsets.append(offsets[-1] + len(token))
    words = list(WORD.finditer(text))
    for index, word in enumerate(words):
        first = bisect_right(offsets, word.start()) - 1
        last = bisect_right(offsets, word.end() - 1) - 1
        begin = word.start() if index else 0
        end = words[index + 1].start() if index + 1 < len(words) else len(text)
        yield text[begin:end], timestamps[first], timestamps[last]


def lines_at_cuts(tokens, timestamps, start, end, cuts):
    """Keep each word in one shot and clip each displayed interval to that shot."""
    if len(tokens) != len(timestamps) or any(not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0 for t in timestamps):
        raise ValueError("Speech model did not return usable token times")
    if any(a > b for a, b in zip(timestamps, timestamps[1:])):
        raise ValueError("Speech model returned unordered token times")
    words = list(words_at(tokens, timestamps))
    lines = []
    fragments = []
    shot, first, stop = 0, start, end
    previous_token_end = start
    for i, (part, word_start, word_end) in enumerate(words):
        at = min(start + word_start, end)
        shot_index = min(bisect_right(cuts, at) - 1, len(cuts) - 2)
        token_end = min(start + word_end, end)
        if fragments and (shot_index != shot or SENTENCE_END.search(fragments[-1].strip()) or at - previous_token_end >= .55):
            lines.append(line(cuts, shot, fragments, first, stop))
            fragments = []
        if not fragments:
            shot, first = shot_index, at
        fragments.append(part)
        previous_token_end = token_end
        next_word = start + words[i + 1][1] if i + 1 < len(words) else end
        stop = min(end, next_word, token_end + .12)
    if fragments:
        lines.append(line(cuts, shot, fragments, first, stop))
    return [item for item in lines if item["end"] > item["start"]]


def line(cuts, shot, fragments, start, end):
    first = max(cuts[shot], round(start, 3))
    stop = min(cuts[shot + 1], max(first + .001, round(end, 3)))
    return {"shotNumber": shot + 1, "start": first, "end": stop, "original": "".join(fragments).strip()}


def transcribe(path, cuts):
    """Reuse the local SenseVoice and VAD models with the recognizer's native token times."""
    from rea_video.media import extract_audio
    from rea_video.speech import SR, _stretches, ensure_models
    from sherpa_onnx import OfflineRecognizer

    audio = extract_audio(path, SR)
    if audio is None:
        return []
    model, tokens, vad = ensure_models()
    recognizer = OfflineRecognizer.from_sense_voice(model=str(model), tokens=str(tokens), num_threads=2, use_itn=True)
    lines = []
    for start, samples in _stretches(audio, vad):
        stream = recognizer.create_stream()
        stream.accept_waveform(SR, samples)
        recognizer.decode_stream(stream)
        raw = stream.result
        if raw.text.strip() and not raw.tokens:
            raise ValueError("Speech model did not return word pieces")
        lines.extend(lines_at_cuts(raw.tokens, raw.timestamps, start, min(cuts[-1], start + len(samples) / SR), cuts))
    return lines
