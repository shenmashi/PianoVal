import struct
import time
import uuid
from dataclasses import replace

from fastapi.testclient import TestClient
import numpy as np
import pytest
import soxr

from app.config import Settings
from app.main import create_app
from app.protocol import PacketReader, ProtocolError
from app.session import AudioSession


@pytest.fixture(autouse=True)
def isolated_studio(tmp_path, monkeypatch):
    original = create_app
    monkeypatch.setitem(globals(), "create_app", lambda settings=None, *args: original(
        replace(settings or Settings.from_env(), studio_dir=tmp_path / "studio"), *args,
    ))


def packet(sequence=0, offset=0, count=640):
    return struct.pack("<IQ", sequence, offset) + np.zeros(count, dtype="<i2").tobytes()


class DummyModel:
    """Transport tests only. Production always loads the real model."""
    def __init__(self, settings):
        self.settings = settings

    def metadata(self):
        return {"name": "test-double", "sampleRate": 16000}

    def infer(self, audio, first_frame, frame_count):
        return [], 0.0


def start(socket, rate=16000, token=""):
    socket.send_json({"type": "start", "sampleRate": rate, "token": token})
    return socket.receive_json()


def stop(socket, packets, samples):
    socket.send_json({"type": "stop", "packets": packets, "samples": samples})
    messages = []
    while True:
        message = socket.receive_json()
        messages.append(message)
        if message["type"] in ("complete", "error"):
            return messages


def test_packet_rejects_discontinuity_before_mutating_counters():
    reader = PacketReader(16000, 10)
    reader.decode(packet())
    with pytest.raises(ProtocolError, match="Discontinuous"):
        reader.decode(packet(2, 640))
    assert (reader.sequence, reader.samples) == (1, 640)


def test_ping_echoes_only_a_finite_client_timestamp(tmp_path):
    with TestClient(create_app(Settings(studio_dir=tmp_path), DummyModel)) as client:
        with client.websocket_connect("/ws/transcribe") as socket:
            assert start(socket)["type"] == "ready"
            socket.send_json({"type": "ping", "clientSentAt": 123.5, "ignored": "do not echo"})
            assert socket.receive_json() == {"type": "pong", "receivedSamples": 0, "clientSentAt": 123.5}
            socket.send_json({"type": "ping", "clientSentAt": "invalid"})
            assert socket.receive_json() == {"type": "pong", "receivedSamples": 0}
            assert stop(socket, 0, 0)[-1]["type"] == "complete"


@pytest.mark.parametrize("data", [b"", b"0" * 12, b"0" * 13, packet(count=4001)])
def test_malformed_and_oversized_packets(data):
    with pytest.raises(ProtocolError):
        PacketReader(16000, 10).decode(data)


def test_duration_limit():
    reader = PacketReader(16000, 1)
    for index in range(4):
        reader.decode(packet(index, index * 4000, 4000))
    with pytest.raises(ProtocolError, match="duration"):
        reader.decode(packet(4, 16000))


def test_resampling_preserves_continuity_and_flushes_tail():
    rate = 44100
    wave = np.sin(np.arange(rate) * 2 * np.pi * 440 / rate).astype(np.float32) * 0.5
    pcm = (wave * 32767).astype("<i2")
    session = AudioSession(rate, Settings())
    sequence = 0
    for offset in range(0, len(pcm), 1764):
        chunk = pcm[offset:offset + 1764]
        session.append(struct.pack("<IQ", sequence, offset) + chunk.tobytes())
        sequence += 1
    session.finish()
    expected = soxr.resample(pcm.astype(np.float32) / 32768, rate, 16000, quality="HQ")
    np.testing.assert_allclose(session.audio, expected, atol=1e-6)
    assert session.total_samples == 16000


@pytest.mark.parametrize("step,right,width", [(8, 12, 120), (30, 100, 230)])
def test_windows_are_bounded_nonoverlapping_and_flush_short_final_audio(step, right, width):
    session = AudioSession(16000, Settings(step_frames=step, right_frames=right))
    decoded_frames = []
    for index in range(250):  # Ten seconds, fragmented as a browser stream.
        session.append(packet(index, index * 640))
        while (window := session.pop_window()) is not None:
            audio, first, count = window
            assert len(audio) == width * 384
            decoded_frames.extend(range(first, first + count))
        assert len(session.audio) <= width * 384 + 640
    session.finish()
    while (window := session.pop_window()) is not None:
        _, first, count = window
        decoded_frames.extend(range(first, first + count))
    assert decoded_frames == list(range(417))


def test_two_websockets_have_independent_counters_and_cleanup():
    with TestClient(create_app(Settings(), DummyModel)) as client:
        with client.websocket_connect("/ws/transcribe") as first, client.websocket_connect("/ws/transcribe") as second:
            one, two = start(first), start(second)
            assert one["sessionId"] != two["sessionId"]
            first.send_bytes(packet())
            second.send_bytes(packet())
            assert client.get("/health").json()["activeSessions"] == 2
            assert stop(first, 1, 640)[-1]["receivedSamples"] == 640
            assert stop(second, 1, 640)[-1]["receivedSamples"] == 640
        assert client.get("/health").json()["activeSessions"] == 0


def test_stop_detects_missing_final_packet():
    with TestClient(create_app(Settings(), DummyModel)) as client:
        with client.websocket_connect("/ws/transcribe") as socket:
            assert start(socket)["type"] == "ready"
            socket.send_bytes(packet())
            assert stop(socket, 2, 1280)[-1]["type"] == "error"


@pytest.mark.parametrize("save,kind,provenance", [
    (False, "microphone", None), (True, "microphone", "uploaded"),
    (True, "simulated", "synthetic-simulator"),
])
def test_complete_saves_only_requested_audio_with_source_provenance(save, kind, provenance):
    with TestClient(create_app(Settings(), DummyModel)) as client:
        with client.websocket_connect("/ws/transcribe") as socket:
            socket.send_json({"type": "start", "sampleRate": 48000,
                              "saveRecording": save, "recordingKind": kind})
            assert socket.receive_json()["type"] == "ready"
            for index in range(10):
                socket.send_bytes(packet(index, index * 1920, 1920))
            completed = stop(socket, 10, 19200)[-1]
            assert completed["type"] == "complete"
        records = client.get("/api/studio/state").json()["records"]
        assert len(records) == int(save)
        if save:
            assert records[0]["id"] == completed["recordingId"]
            assert records[0]["provenance"] == provenance
            assert records[0]["duration"] == pytest.approx(.4)
        else:
            assert completed["recordingId"] is None


@pytest.mark.parametrize("disconnect", [False, True])
def test_server_logs_completed_and_disconnected_microphone_sessions(disconnect):
    application = create_app(Settings(token="private-token"), DummyModel)
    with TestClient(application) as client:
        test_id = str(uuid.uuid4())
        context = {"pieceId": "listen-to-mom", "difficulty": "easy", "hand": "left", "startMeasure": 1, "endMeasure": 2}
        with client.websocket_connect("/ws/transcribe") as socket:
            socket.send_json({"type": "start", "sampleRate": 16000, "token": "private-token",
                              "testId": test_id, "testContext": context, "saveRecording": True})
            ready = socket.receive_json()
            for index in range(20):
                socket.send_bytes(packet(index, index * 640))
            if disconnect:
                # Confirm the server has received every packet before disconnecting without stop.
                socket.send_json({"type": "ping"})
                while socket.receive_json()["type"] != "pong":
                    pass
            else:
                assert stop(socket, 20, 12800)[-1]["recordingId"]
        headers = {"X-Pianoval-Token": "private-token"}
        for _ in range(100):
            report = client.get("/api/studio/test-runs/" + ready["sessionId"], headers=headers).json()
            if report.get("status") != "running":
                break
            time.sleep(.01)
        assert report["status"] == ("interrupted" if disconnect else "completed")
        assert report["testId"] == test_id and report["context"] == context
        assert report["audioSeconds"] == .8 and report["windows"]
        assert report["recordingId"]
        assert report["model"]["name"] == "test-double"
        assert "private-token" not in str(report)
        state = client.get("/api/studio/state", headers=headers).json()
        assert state["records"][0]["duration"] >= .75
        assert state["jobs"] == []
        assert client.get("/health").json()["activeSessions"] == 0


def test_invalid_format_is_rejected():
    with TestClient(create_app(Settings(), DummyModel)) as client:
        with client.websocket_connect("/ws/transcribe") as socket:
            socket.send_json({"type": "start", "sampleRate": 16000, "format": "webm"})
            assert socket.receive_json()["type"] == "error"


def test_invalid_control_and_rate_are_rejected():
    with TestClient(create_app(Settings(), DummyModel)) as client:
        with client.websocket_connect("/ws/transcribe") as socket:
            assert start(socket, rate=12345)["type"] == "error"
        with client.websocket_connect("/ws/transcribe") as socket:
            assert start(socket)["type"] == "ready"
            socket.send_json([])
            assert socket.receive_json()["type"] == "error"


def test_token_and_connection_capacity():
    settings = Settings(token="test-token", max_sessions=1)
    with TestClient(create_app(settings, DummyModel)) as client:
        with client.websocket_connect("/ws/transcribe") as socket:
            assert start(socket)["code"] == "unauthorized"
        with client.websocket_connect("/ws/transcribe") as first:
            assert start(first, token="test-token")["type"] == "ready"
            with client.websocket_connect("/ws/transcribe") as second:
                assert second.receive_json()["code"] == "server_busy"
            assert stop(first, 0, 0)[-1]["type"] == "complete"


def test_missing_model_never_returns_fake_notes(tmp_path):
    with TestClient(create_app(Settings(model_path=tmp_path / "missing.torch"))) as client:
        assert client.get("/ready").status_code == 503
        assert not client.get("/health").json()["modelReady"]
        with client.websocket_connect("/ws/transcribe") as socket:
            assert socket.receive_json()["code"] == "model_unavailable"


@pytest.mark.model
def test_real_model_silence_and_final_tail():
    with TestClient(create_app()) as client:
        assert client.get("/ready").status_code == 200
        with client.websocket_connect("/ws/transcribe") as socket:
            ready = start(socket, rate=48000)
            assert ready["model"]["name"] == "onsets-and-velocities"
            for index in range(100):
                socket.send_bytes(packet(index, index * 1920, 1920))
            messages = stop(socket, 100, 192000)
            assert messages[-1]["type"] == "complete"
            assert messages[-1]["noteCount"] == 0
            assert messages[-1]["audioSeconds"] == 4
            assert any(message["type"] == "notes" and message["tailPadded"] for message in messages)
