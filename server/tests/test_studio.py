import io
import json

from fastapi.testclient import TestClient
import mido
import numpy as np
import pytest
import soundfile as sf

from app.config import Settings
from app.dataset import Annotation, StudioStore, onset_metrics, parse_midi
from app.demo import install_demo
from app.main import create_app
from app.practice import ComparisonRequest, compare_score, score_data
from app.training import target_roll, training_window


def note(time=0.5, pitch=60):
    return {"onsetSeconds": time, "midi": pitch, "velocity": 80}


class TestModel:
    __test__ = False
    version = "base"

    def __init__(self, settings):
        self.settings = settings

    def metadata(self):
        return {"version": self.version, "name": "transport-test-only"}


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(studio_dir=tmp_path / "studio"), TestModel)) as client:
        yield client


def wav_bytes():
    buffer = io.BytesIO()
    sf.write(buffer, np.zeros(16000), 16000, format="WAV")
    return buffer.getvalue()


def upload(client):
    response = client.post("/api/studio/recordings", files={"audio": ("student.wav", wav_bytes(), "audio/wav")})
    assert response.status_code == 200
    return response.json()


def test_metrics_keep_wrong_pitches_extras_duplicates_and_boundary():
    metrics = onset_metrics([note(0, 60), note(0.09, 60), note(0, 64)],
                            [note(0.05, 60), note(0.14, 60), note(0, 65), note(0.05, 60)])
    assert (metrics["tp"], metrics["fp"], metrics["fn"]) == (2, 2, 1)


def test_simulator_comparison_keeps_extra_and_missing_pitches(client):
    response = client.post("/api/studio/recognition/compare", json={
        "expected": [note(.2, 60), note(.2, 64)],
        "observed": [note(.23, 60), note(.2, 65)],
    })
    assert response.status_code == 200
    metrics = response.json()
    assert (metrics["tp"], metrics["fp"], metrics["fn"]) == (1, 1, 1)


def test_score_excerpt_retains_first_chord_despite_integer_midi_tempo():
    body = ComparisonRequest(startMeasure=5, endMeasure=5)
    result = compare_score(body, [note(0, 60), note(0, 76)])
    assert result["metrics"]["tp"] == 2
    assert not any(n["onsetSeconds"] < 0 for n in result["differences"])
    assert all(n["measure"] == 5 for n in score_data("easy")["notes"] if abs(n["onsetSeconds"]-10.322576)<.001)


def test_midi_tempo_changes_and_offset_are_real_seconds():
    midi = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack(); midi.tracks.append(track)
    track.extend([mido.MetaMessage("set_tempo", tempo=500000),
                  mido.Message("note_on", note=60, velocity=80, time=480),
                  mido.MetaMessage("set_tempo", tempo=1000000, time=480),
                  mido.Message("note_on", note=64, velocity=90, time=480)])
    output = io.BytesIO(); midi.save(file=output)
    notes = parse_midi(output.getvalue(), offset=0.2, duration=3)
    assert [note["onsetSeconds"] for note in notes] == [0.7, 2.2]
    with pytest.raises(ValueError, match="时长"):
        parse_midi(output.getvalue(), offset=0.2, duration=1)


def test_upload_labels_review_and_missing_dataset_guard(client):
    record = upload(client)
    path = f"/api/studio/recordings/{record['id']}"
    assert client.get(path + "/audio").headers["content-type"] == "audio/wav"
    assert client.post("/api/studio/training", json={"steps": 2}).status_code == 400
    body = {"notes": [note()], "reviewed": True, "split": "train", "group": "  student-take-1  "}
    response = client.put(path + "/labels", json=body)
    assert response.status_code == 200
    assert response.json()["group"] == "student-take-1"
    assert response.json()["revision"] == 2
    assert client.get("/api/studio/state").json()["records"][0]["noteCount"] == 1
    body["notes"] = [note(1.1)]
    assert client.put(path + "/labels", json=body).status_code == 400
    body["notes"] = [note(), note()]
    assert client.put(path + "/labels", json=body).status_code == 400


def test_unconfirmed_labels_cannot_train(client):
    record = upload(client)
    client.put(f"/api/studio/recordings/{record['id']}/labels", json={
        "notes": [note()], "reviewed": False, "split": "train", "group": "take-1",
    })
    assert client.post("/api/studio/training", json={}).status_code == 400


def test_dataset_blocks_group_and_duplicate_audio_leakage(tmp_path):
    store = StudioStore(tmp_path)
    first = store.create_record("one", np.ones(16000, dtype=np.float32) * 0.01)
    second = store.create_record("two", np.ones(16000, dtype=np.float32) * 0.02)
    for record, split, group in [(first, "train", "Same Song"), (second, "validation", "same song")]:
        store.annotate(record["id"], Annotation(notes=[note()], reviewed=True, split=split, group=group))
    with pytest.raises(ValueError, match="同一分组"):
        store.snapshot()
    store.annotate(second["id"], Annotation(notes=[note()], reviewed=True, split="unassigned", group="other"))
    duplicate = store.create_record("copy", np.ones(16000, dtype=np.float32) * 0.01)
    store.annotate(duplicate["id"], Annotation(notes=[note()], reviewed=True, split="validation", group="different-name"))
    with pytest.raises(ValueError, match="重复音频"):
        store.snapshot()


def test_demo_real_data_mixture_is_rejected_and_can_be_excluded(tmp_path):
    store = StudioStore(tmp_path)
    assert len(install_demo(store)) == 4
    assert len(install_demo(store)) == 4
    assert len(store.snapshot()) == 4
    record = store.create_record("real", np.zeros(16000, dtype=np.float32))
    store.annotate(record["id"], Annotation(notes=[note()], reviewed=True, split="train", group="real"))
    with pytest.raises(ValueError, match="混合"):
        store.snapshot()


def test_rest_auth_and_bad_inputs(tmp_path):
    with TestClient(create_app(Settings(studio_dir=tmp_path, token="secret"), TestModel)) as client:
        assert client.get("/api/studio/state").status_code == 401
        headers = {"X-Pianoval-Token": "secret"}
        assert client.get("/api/studio/state", headers=headers).status_code == 200
        assert client.get("/api/studio/recordings/not-an-id", headers=headers).status_code == 400
        assert client.post("/api/studio/recordings", headers=headers, files={"audio": ("bad.wav", b"", "audio/wav")}).status_code == 400
        assert client.post("/api/studio/training", headers=headers, json={"steps": 0}).status_code == 422
        assert client.post("/api/studio/models/not-an-id/activate", headers=headers).status_code == 400


@pytest.mark.parametrize("step,right,width", [(8, 12, 120), (30, 100, 230)])
def test_training_quantization_matches_model_diff_and_stream_window(step, right, width):
    settings = Settings(step_frames=step, right_frames=right)
    # A source onset at absolute frame 100 becomes model output index 99 after x.diff.
    labels = target_roll([note(100 * 384 / 16000)], first_frame=100, settings=settings)
    assert labels.shape == (88, width)
    assert labels[39, 99:102].tolist() == [1, 1, 1]
    assert labels.sum().item() == 3
    audio = np.ones(16000, dtype=np.float32)
    window = training_window(audio, 0, settings)
    assert len(window) == width * 384
    assert np.all(window[:100 * 384] == 0)


def test_real_score_data_hands_and_expanded_repeats():
    easy, normal = score_data("easy"), score_data("normal")
    assert easy["bars"] == 37 and normal["bars"] == 69
    assert len(easy["notes"]) == 130 and len(normal["notes"]) == 627
    assert normal["notes"][-1]["onsetSeconds"] > 170
    assert {note["hand"] for note in normal["notes"]} == {"left", "right"}


def test_score_comparison_keeps_wrong_notes_and_uses_tempo_offset():
    score = score_data("easy")
    expected = [note for note in score["notes"] if note["hand"] == "right" and note["onsetSeconds"] < 4 * 60 / 93]
    actual = [{"midi": note["midi"], "onsetSeconds": note["onsetSeconds"] / 0.8 + 1,
               "velocity": note["velocity"]} for note in expected]
    body = ComparisonRequest(hand="right", endMeasure=1, speed=0.8, offsetSeconds=1)
    assert compare_score(body, actual)["metrics"]["f1"] == 1
    actual.append(note(0.1, 22))
    result = compare_score(body, actual)
    assert result["metrics"]["fp"] == 1
    assert result["differences"][0]["kind"] == "extra"


def test_live_comparison_does_not_mark_future_notes_missing():
    result = compare_score(ComparisonRequest(endMeasure=8, throughSeconds=0.1), [])
    assert result["expectedCount"] == 0
    assert result["metrics"]["fn"] == 0
