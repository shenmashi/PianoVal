"""Reproducible sampled-audio holdout; never provides score answers to the model.

This validates a local synthetic instrument, not classroom / microphone accuracy.
The calibration recordings (bars 1-12) are intentionally excluded from holdout.
"""
import argparse
from dataclasses import replace
import json
from pathlib import Path
import random
import sys
import time

import numpy as np
import soundfile as sf
import soxr
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import ROOT, Settings
from app.dataset import onset_metrics
from app.model import PianoModel, SAMPLE_RATE
from app.practice import score_data
from app.session import AudioSession


def score_groups(hand, start_bar, end_bar, speed=1.0):
    start, end = (start_bar - 1) * 240 / 93, end_bar * 240 / 93
    groups = []
    for note in sorted(score_data("easy")["notes"], key=lambda n: (n["onsetSeconds"], n["midi"])):
        if not start - .001 <= note["onsetSeconds"] < end - .001 or hand != "both" and note["hand"] != hand:
            continue
        onset = max(0, note["onsetSeconds"] - start) / speed + .237
        if not groups or onset - groups[-1]["onsetSeconds"] > .002:
            groups.append({"onsetSeconds": onset, "expected": [], "pitches": [], "durations": {}})
        group = groups[-1]
        if note["midi"] not in group["pitches"]:
            group["expected"].append(note["midi"])
            group["pitches"].append(note["midi"])
        group["durations"][note["midi"]] = max(.08, min(end - note["onsetSeconds"], note["durationSeconds"]) * .9 / speed)
    return groups, (end - start) / speed + 1.5


class SampleRenderer:
    def __init__(self):
        manifest = json.loads((ROOT / "static/piano-samples/manifest.json").read_text())
        self.samples = {}
        for asset in manifest["assets"]:
            audio, rate = sf.read(ROOT / "static/piano-samples" / asset["file"], dtype="float32", always_2d=True)
            self.samples[asset["midi"]] = (audio.mean(axis=1), rate)
        self.cache = {}

    def render(self, groups, duration, velocity=80, pedal=False):
        output = np.zeros(int(duration * SAMPLE_RATE), dtype=np.float32)
        for group in groups:
            begin = round(group["onsetSeconds"] * SAMPLE_RATE)
            for midi in group["pitches"]:
                if midi not in self.cache:
                    sampled = min(self.samples, key=lambda pitch: abs(pitch - midi))
                    audio, rate = self.samples[sampled]
                    self.cache[midi] = soxr.resample(audio, rate * 2 ** ((midi - sampled) / 12), SAMPLE_RATE)
                signal = self.cache[midi]
                length = group["durations"].get(midi, max(group["durations"].values()))
                held = round(length * SAMPLE_RATE)
                count = min(len(signal), len(output) - begin, len(signal) if pedal else held + 3840)
                envelope = np.ones(count, dtype=np.float32)
                if not pedal and count > held:
                    envelope[held:] = np.exp(-np.arange(count - held) / (.045 * SAMPLE_RATE))
                output[begin:begin + count] += signal[:count] * envelope * velocity / 127 * .85 * .65
        if abs(output).max(initial=0) >= 1:
            raise ValueError("Synthetic benchmark clipped; fix fixture rather than clipping the audio")
        # Same PCM16 quantization as the browser transport.
        return (np.round(output * 32767).astype("<i2").astype(np.float32) / 32768)


def evaluate(model, groups, audio):
    session = AudioSession(SAMPLE_RATE, model.settings)
    session._append_resampled(audio)
    session.finish()
    events, timings = [], []
    while (window := session.pop_window()) is not None:
        detected, ms = model.infer(*window)
        events.extend(session.unique_events(detected))
        timings.append(ms)
    rows = []
    for group in groups:
        heard = sorted({event["midi"] for event in events if abs(event["onsetSeconds"] - group["onsetSeconds"]) <= .12})
        expected, played = sorted(group["expected"]), sorted(group["pitches"])
        correct_input = expected == played
        accepts = expected == heard
        rows.append({**group, "heard": heard, "inputCorrect": correct_input,
                     "decisionCorrect": correct_input == accepts, "exactRecognition": played == heard})
    correct = [row for row in rows if row["inputCorrect"]]
    wrong = [row for row in rows if not row["inputCorrect"]]
    truth = [{"midi": pitch, "onsetSeconds": group["onsetSeconds"]} for group in groups for pitch in group["pitches"]]
    return {"groups": len(rows), "correctDecisions": sum(row["decisionCorrect"] for row in rows),
            "decisionAccuracy": sum(row["decisionCorrect"] for row in rows) / len(rows),
            "exactGroupAccuracy": sum(row["exactRecognition"] for row in rows) / len(rows),
            "correctInputs": len(correct), "falseBlocks": sum(not row["decisionCorrect"] for row in correct),
            "wrongInputs": len(wrong), "falsePasses": sum(not row["decisionCorrect"] for row in wrong),
            "noteMetrics": onset_metrics(truth, events), "inferenceMsP50": float(np.percentile(timings, 50)),
            "inferenceMsP95": float(np.percentile(timings, 95)),
            "realTimeFactor": sum(timings) / 1000 / (len(audio) / SAMPLE_RATE),
            "differences": [row for row in rows if not row["exactRecognition"]], "events": events}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=float, default=-22)
    parser.add_argument("--left", type=int, default=100)
    parser.add_argument("--step", type=int, default=8)
    parser.add_argument("--right", type=int, default=12)
    parser.add_argument("--output", type=Path, default=ROOT / "test-evidence/accuracy-holdout.json")
    args = parser.parse_args()
    torch.set_num_threads(2)
    settings = replace(Settings(), mel_offset_db=args.db, left_frames=args.left, step_frames=args.step, right_frames=args.right)
    model, renderer = PianoModel(settings), SampleRenderer()
    rng, results = random.Random(83471), []
    # Freeze this corpus before evaluating the calibrated profile. Unseen bars,
    # velocity, tempo, true octaves, extra octaves, missing notes and substitutions.
    cases = [(f"{hand}-bars13-37", hand, 13, 37, 80, False, 1., False) for hand in ("left", "right", "both")]
    cases += [("soft-bars13-20", "both", 13, 20, 50, False, .85, False),
              ("loud-bars21-28", "both", 21, 28, 110, False, 1.15, False),
              ("pedal-bars29-37", "both", 29, 37, 80, True, 1., False),
              ("random-errors-bars13-37", "both", 13, 37, 80, False, 1., True)]
    for label, hand, start, end, velocity, pedal, speed, errors in cases:
        groups, duration = score_groups(hand, start, end, speed)
        if errors:
            for index, group in enumerate(groups):
                pitches = group["pitches"]
                if index % 2 == 0:
                    if index % 6 == 0 and len(pitches) > 1:
                        pitches.pop()
                    elif index % 6 == 2:
                        candidates = [pitch + 12 for pitch in pitches if pitch + 12 <= 108 and pitch + 12 not in pitches]
                        if candidates:
                            pitches.append(rng.choice(candidates))
                        else:
                            pitches.append(next(p for p in range(48, 84) if p not in pitches))
                    else:
                        pitch = pitches[0]
                        pitches[0] = next(p for p in (pitch + 1, pitch - 1, pitch + 2) if p not in pitches)
        audio = renderer.render(groups, duration, velocity, pedal)
        began = time.perf_counter()
        result = {"case": label, "hand": hand, "velocity": velocity, "pedal": pedal, "speed": speed,
                  "audioSeconds": len(audio) / SAMPLE_RATE, **evaluate(model, groups, audio),
                  "elapsedSeconds": time.perf_counter() - began}
        results.append(result)
        print(json.dumps({k: v for k, v in result.items() if k not in ("differences", "events")}), flush=True)
        args.output.write_text(json.dumps({"scope": "Synthetic Salamander holdout, not real microphone/production accuracy",
            "model": model.metadata(), "seed": 83471, "target": .95, "cases": results,
            "aggregate": {"correctDecisions": sum(case["correctDecisions"] for case in results),
                          "groups": sum(case["groups"] for case in results),
                          "decisionAccuracy": sum(case["correctDecisions"] for case in results) / sum(case["groups"] for case in results)},
            "allCasesAtLeast95": all(case["decisionAccuracy"] >= .95 for case in results),
            "complete": len(results) == len(cases)}, indent=2))


if __name__ == "__main__":
    main()
