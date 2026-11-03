"""One resampler and bounded PCM history per WebSocket connection."""

import math

import numpy as np
import soxr

from .config import Settings
from .model import HOP, SAMPLE_RATE
from .protocol import PacketReader


class AudioSession:
    def __init__(self, sample_rate: int, settings: Settings):
        self.settings = settings
        self.reader = PacketReader(sample_rate, settings.max_audio_seconds)
        self.resampler = None if sample_rate == SAMPLE_RATE else soxr.ResampleStream(
            sample_rate, SAMPLE_RATE, 1, dtype="float32", quality="HQ",
        )
        self.audio = np.empty(0, dtype=np.float32)
        self.audio_start = 0
        self.total_samples = 0
        self.next_frame = 0
        self.finished = False
        self.last_onsets: dict[int, float] = {}
        self.note_count = 0

    def append(self, packet: bytes) -> np.ndarray:
        audio = self.reader.decode(packet)
        if self.resampler is not None:
            audio = self.resampler.resample_chunk(audio)
        self._append_resampled(audio)
        return audio

    def _append_resampled(self, audio: np.ndarray) -> None:
        self.audio = np.concatenate((self.audio, audio))
        self.total_samples += len(audio)

    def finish(self) -> np.ndarray:
        tail = np.empty(0, dtype=np.float32)
        if self.resampler is not None:
            tail = self.resampler.resample_chunk(np.empty(0, dtype=np.float32), last=True)
            self._append_resampled(tail)
        self.finished = True
        return tail

    def pop_window(self) -> tuple[np.ndarray, int, int] | None:
        settings = self.settings
        end_frame = math.ceil(self.total_samples / HOP)
        if self.next_frame >= end_frame:
            return None
        count = settings.step_frames
        if self.finished:
            count = min(count, end_frame - self.next_frame)
        required = (self.next_frame + count + settings.right_frames) * HOP
        if not self.finished and self.total_samples < required:
            return None
        start = (self.next_frame - settings.left_frames) * HOP
        # Fixed model window, even for a partial final center interval.
        stop = (self.next_frame + settings.step_frames + settings.right_frames) * HOP
        left = max(0, -start)
        right = max(0, stop - self.total_samples)
        window = self.audio[max(0, start) - self.audio_start:min(stop, self.total_samples) - self.audio_start]
        window = np.pad(window, (left, right)).astype(np.float32, copy=False)
        first_frame = self.next_frame
        self.next_frame += count
        keep_from = max(0, (self.next_frame - settings.left_frames) * HOP)
        discard = keep_from - self.audio_start
        if discard > 0:
            self.audio = self.audio[discard:].copy()
            self.audio_start = keep_from
        return window, first_frame, count

    def unique_events(self, events: list[dict]) -> list[dict]:
        result = []
        duration = self.total_samples / SAMPLE_RATE
        for event in events:
            midi, onset = event["midi"], event["onsetSeconds"]
            if onset >= duration or onset <= self.last_onsets.get(midi, -1.0):
                continue
            self.last_onsets[midi] = onset
            self.note_count += 1
            result.append({"id": self.note_count, **event})
        return result
