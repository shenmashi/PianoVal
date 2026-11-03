"""Deterministic labeled synthetic tones for exercising training, not piano validation."""

import numpy as np

from .dataset import Annotation
from .model import SAMPLE_RATE


def make_demo(seed):
    rng = np.random.default_rng(seed)
    audio = np.zeros(SAMPLE_RATE * 9, dtype=np.float32)
    notes = []
    scale = [48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 72, 76]
    for onset in np.arange(0.6, 7.8, 0.6):
        pitches = rng.choice(scale, size=int(rng.integers(1, 4)), replace=False)
        for pitch in pitches:
            duration = float(rng.uniform(0.45, 1.1))
            time = np.arange(int(SAMPLE_RATE * duration)) / SAMPLE_RATE
            frequency = 440 * 2 ** ((int(pitch) - 69) / 12)
            tone = np.zeros_like(time)
            for harmonic in range(1, 9):
                if frequency * harmonic < SAMPLE_RATE / 2:
                    tone += np.sin(2 * np.pi * frequency * harmonic * time) / harmonic ** 1.4
            envelope = (1 - np.exp(-time * 600)) * np.exp(-time * (4 + seed % 3))
            tone = tone * envelope * 0.12
            start = int(round(onset * SAMPLE_RATE))
            audio[start:start + len(tone)] += tone.astype(np.float32)
            notes.append({"midi": int(pitch), "onsetSeconds": round(float(onset), 6), "velocity": 80})
    return audio, notes


def install_demo(store):
    existing = [record for record in store.list_records() if record.get("provenance") == "synthetic-demo"]
    if existing:
        return existing
    records = []
    for index, seed in enumerate((31, 47, 83, 97)):
        split = "train" if index < 2 else "validation"
        audio, notes = make_demo(seed)
        record = store.create_record(f"演示合成音 {index + 1} · {'训练' if split == 'train' else '验证'}", audio,
                                     provenance="synthetic-demo")
        records.append(store.annotate(record["id"], Annotation(
            notes=notes, reviewed=True, split=split, group=f"synthetic-seed-{seed}",
        ), source="synthetic-known-onsets"))
    return records
