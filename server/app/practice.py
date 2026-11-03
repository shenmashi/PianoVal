"""Local integration test using the user-provided practice page's public assets."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

import mido
from pydantic import BaseModel, ConfigDict, Field

from .config import ROOT
from .dataset import NoteLabel, onset_metrics
from .model import midi_name

SCORES = ROOT / "static/scores"


@lru_cache(maxsize=1)
def score_catalog():
    import json
    return json.loads((SCORES / "catalog.json").read_text())


def catalog_summary():
    return [{**{key: piece[key] for key in ("id", "title", "artist", "source")},
             "versions": [{"id": version["id"], "name": version["name"], "tempo": version["tempo"],
                           "hasAudio": bool(version["assets"].get("accompaniment"))}
                          for version in piece["versions"]]} for piece in score_catalog()]


def measure_quarters(path):
    """Measure lengths include pickups, multiple voices and changing meters."""
    from fractions import Fraction
    import xml.etree.ElementTree as ET
    parts = []
    for part in ET.parse(path).getroot().findall("part"):
        divisions, nominal, lengths = 1, Fraction(4), []
        for measure in part.findall("measure"):
            cursor = maximum = last = Fraction(0)
            for element in measure:
                if element.tag == "attributes":
                    divisions = int(element.findtext("divisions", str(divisions)))
                    meter = element.find("time")
                    if meter is not None:
                        nominal = Fraction(meter.findtext("beats")) * 4 / Fraction(meter.findtext("beat-type"))
                elif element.tag in ("backup", "forward"):
                    duration = Fraction(element.findtext("duration", "0")) / divisions
                    cursor += duration if element.tag == "forward" else -duration
                    maximum = max(maximum, cursor)
                elif element.tag == "note" and element.find("grace") is None:
                    duration = Fraction(element.findtext("duration", "0")) / divisions
                    if element.find("chord") is None:
                        last = cursor
                        cursor += duration
                    maximum = max(maximum, last + duration)
            lengths.append(float(maximum or nominal))
        parts.append(lengths)
    return [max(part[index] for part in parts if index < len(part)) for index in range(max(map(len, parts)))]


@lru_cache(maxsize=32)
def score_data(difficulty: str, piece_id: str = "listen-to-mom"):
    from bisect import bisect_right
    piece = next((item for item in score_catalog() if item["id"] == piece_id), None)
    if piece is None:
        raise ValueError("曲目不存在")
    version = next((item for item in piece["versions"] if item["id"] == difficulty), None)
    if version is None:
        raise ValueError("曲谱版本不存在")
    directory = SCORES / piece_id
    notes, maximum, midi_tempo = [], 0.0, None
    for hand in ("left", "right"):
        midi = mido.MidiFile(directory / version["assets"][hand + "Midi"])
        clock, active = 0.0, {}
        for message in midi:
            clock += message.time
            if message.type == "set_tempo" and midi_tempo is None:
                midi_tempo = message.tempo
            if message.type == "note_on" and message.velocity > 0:
                note = {"midi": message.note, "note": midi_name(message.note),
                        "onsetSeconds": round(clock, 6), "velocity": message.velocity, "hand": hand}
                active[(message.channel, message.note)] = note
                notes.append(note)
            elif message.type == "note_off" or (message.type == "note_on" and message.velocity == 0):
                note = active.pop((message.channel, message.note), None)
                if note is not None:
                    note["durationSeconds"] = round(max(0.01, clock - note["onsetSeconds"]), 6)
        maximum = max(maximum, clock)
    lengths = version.get("uniformQuarterLengths") or measure_quarters(directory / version["assets"]["musicXml"])
    order = version.get("measureOrder", list(range(len(lengths))))
    source_quarters = [0.0]
    for length in lengths:
        source_quarters.append(source_quarters[-1] + length)
    quarters, starts = [0.0], [0.0]
    seconds_per_quarter = 60 / version["tempo"] if "uniformQuarterLengths" in version else midi_tempo / 1_000_000
    onsets = sorted({note["onsetSeconds"] for note in notes})
    for index in order:
        quarters.append(quarters[-1] + lengths[index])
        ideal = quarters[-1] * seconds_per_quarter
        # Source MIDI exporters round note durations to ticks. Align boundaries
        # to a nearby actual attack so a rounding error cannot move it one bar.
        near = min(onsets, key=lambda onset: abs(onset - ideal), default=ideal)
        starts.append(near if piece_id != "listen-to-mom" and abs(near - ideal) < .024 else ideal)
    for note in notes:
        note.setdefault("durationSeconds", 0.2)
        note["measure"] = min(len(order), max(1, bisect_right(starts, note["onsetSeconds"] + .001)))
    return {"id": piece_id, "title": piece["title"], "artist": piece["artist"], "difficulty": difficulty,
            "difficultyName": version["name"], "tempo": version["tempo"], "bars": len(order),
            "sourceBars": version["sourceBars"], "measureStartsSeconds": starts, "measureQuarters": quarters,
            "sourceMeasureQuarters": source_quarters,
            "sourceMeasures": [index + 1 for index in order],
            "durationSeconds": max(maximum, starts[-1], version["durationSeconds"]),
            "notes": sorted(notes, key=lambda note: (note["onsetSeconds"], note["midi"])),
            "assetsBase": f"/static/scores/{piece_id}/", "assets": version["assets"], "source": piece["source"]}


class ComparisonRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    pieceId: str = Field(default="listen-to-mom", pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    difficulty: str = Field(default="easy", pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    hand: Literal["both", "left", "right"] = "both"
    startMeasure: int = Field(default=1, ge=1, le=2048)
    endMeasure: int = Field(default=8, ge=1, le=2048)
    speed: float = Field(default=1.0, ge=0.5, le=1.5)
    offsetSeconds: float = Field(default=0.0, ge=-600, le=600)
    toleranceSeconds: float = Field(default=0.15, ge=0.05, le=0.5)
    throughSeconds: float | None = Field(default=None, ge=0, le=600)
    notes: list[NoteLabel] = Field(default_factory=list, max_length=50000)
    jobId: str | None = None


def compare_score(body: ComparisonRequest, actual: list[dict]):
    score = score_data(body.difficulty, body.pieceId)
    if not body.startMeasure <= body.endMeasure <= score["bars"]:
        raise ValueError("小节范围无效")
    start = score["measureStartsSeconds"][body.startMeasure - 1]
    end = score["measureStartsSeconds"][body.endMeasure]
    expected = []
    seen = set()
    for note in score["notes"]:
        if not body.startMeasure <= note["measure"] <= body.endMeasure or (body.hand != "both" and note["hand"] != body.hand):
            continue
        time = max(0, note["onsetSeconds"] - start) / body.speed + body.offsetSeconds
        if time < 0 or (body.throughSeconds is not None and time + body.toleranceSeconds > body.throughSeconds):
            continue
        # Both hands can share one physical piano key; count that key onset once.
        identity = (note["midi"], round(time, 5))
        if identity in seen:
            continue
        seen.add(identity)
        expected.append({**note, "onsetSeconds": time})
    predicted = sorted((note for note in actual if body.throughSeconds is None
                        or note["onsetSeconds"] + body.toleranceSeconds <= body.throughSeconds),
                       key=lambda note: (note["onsetSeconds"], note["midi"]))
    metrics = onset_metrics(expected, predicted, body.toleranceSeconds)
    # Show actual discrepancies. Do not infer whether the student or recognizer caused them.
    matched_expected, matched_actual = set(), set()
    for pitch in range(21, 109):
        reference = sorted((i for i, note in enumerate(expected) if note["midi"] == pitch), key=lambda i: expected[i]["onsetSeconds"])
        observed = [i for i, note in enumerate(predicted) if note["midi"] == pitch]
        i = j = 0
        while i < len(reference) and j < len(observed):
            delta = predicted[observed[j]]["onsetSeconds"] - expected[reference[i]]["onsetSeconds"]
            if delta < -body.toleranceSeconds - 1e-9:
                j += 1
            elif delta > body.toleranceSeconds + 1e-9:
                i += 1
            else:
                matched_expected.add(reference[i]); matched_actual.add(observed[j]); i += 1; j += 1
    differences = []
    for index, note in enumerate(expected):
        if index not in matched_expected:
            differences.append({"kind": "missing", "meaning": "谱面有，识别结果未匹配", **note})
    for index, note in enumerate(predicted):
        if index not in matched_actual:
            differences.append({"kind": "extra", "meaning": "识别结果有，谱面未匹配", "note": midi_name(note["midi"]), **note})
    differences.sort(key=lambda note: note["onsetSeconds"])
    return {"metrics": metrics, "expectedCount": len(expected), "observedCount": len(predicted),
            "differences": differences, "comparedThroughSeconds": body.throughSeconds,
            "observedNotes": predicted,
            "interpretation": "Score agreement at fixed tempo/offset; not acoustic model accuracy or teacher grading"}
