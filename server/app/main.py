import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import json
import logging
import secrets
import time
import uuid
from html import escape
import numpy as np

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
import torch

from .config import ROOT, Settings
from .model import HOP, SAMPLE_RATE, PianoModel
from .protocol import ProtocolError, StartMessage
from .session import AudioSession
from .studio import Studio, studio_router
from .dataset import atomic_json
from .auth import COOKIE_NAME, install_browser_auth
from .diagnostics import SessionTrace, client_timing

logger = logging.getLogger("pianoval")


def create_app(settings: Settings | None = None, model_factory=PianoModel) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await asyncio.to_thread(app.state.browser_auth.initialize)
        app.state.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="piano-inference")
        app.state.model = None
        app.state.model_error = None
        app.state.active_sessions = 0
        app.state.model_switching = False
        app.state.audit_tasks = set()
        torch.set_num_threads(2)
        try:
            app.state.model = await asyncio.get_running_loop().run_in_executor(
                app.state.pool, model_factory, settings,
            )
            logger.info("Piano model loaded on %s", settings.device)
        except Exception as error:
            app.state.model_error = str(error)
            logger.exception("Piano model failed to load")
        app.state.studio = Studio(app, settings)
        await app.state.studio.restore()
        try:
            yield
        finally:
            if app.state.audit_tasks:
                await asyncio.gather(*app.state.audit_tasks, return_exceptions=True)
            await app.state.studio.close()
            app.state.pool.shutdown(wait=True, cancel_futures=True)

    app = FastAPI(title="PianoVal piano transcription", version="0.1.0", lifespan=lifespan)
    auth = install_browser_auth(app, settings)
    app.include_router(studio_router(settings))

    @app.exception_handler(ValueError)
    async def value_error(request: Request, error: ValueError):
        return JSONResponse({"detail": str(error)}, status_code=400)

    @app.exception_handler(FileNotFoundError)
    async def missing_file(request: Request, error: FileNotFoundError):
        return JSONResponse({"detail": "记录或任务不存在"}, status_code=404)

    @app.get("/health")
    def health():
        return {
            "status": "ok", "modelReady": app.state.model is not None,
            "activeSessions": app.state.active_sessions,
            "maxSessions": settings.max_sessions,
        }

    @app.get("/ready")
    def ready():
        if app.state.model is None:
            return JSONResponse({"ready": False, "error": app.state.model_error}, status_code=503)
        return {"ready": True}

    @app.get("/api/model")
    def model_info():
        if app.state.model is None:
            return JSONResponse({"ready": False, "error": app.state.model_error}, status_code=503)
        return {"ready": True, **app.state.model.metadata()}

    @app.get("/", include_in_schema=False)
    def diagnostic_page(request: Request):
        prefix = request.scope.get("root_path", "").rstrip("/")
        html = (ROOT / "static/index.html").read_text()
        html = html.replace('<head>', '<head><base href="' + escape(prefix + '/', quote=True) + '">', 1)
        # Local URLs resolve against the configured base for subpath deployments.
        html = html.replace('="/static/', '="static/').replace('href="/"', 'href="./"')
        return HTMLResponse(html)

    app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

    @app.websocket("/ws/transcribe")
    async def transcribe(socket: WebSocket):
        browser_token = socket.cookies.get(COOKIE_NAME)
        browser_username = await asyncio.to_thread(auth.user, browser_token) if auth.enabled else None
        if auth.enabled and browser_username is None:
            await socket.close(code=1008, reason="Login required")
            return
        origin = socket.headers.get("origin")
        if settings.allowed_origins and origin and origin not in settings.allowed_origins:
            await socket.close(code=1008)
            return
        await socket.accept()
        auth.track(socket, browser_token)
        registered = False
        audit = None
        audit_task = None
        recording = None
        recording_chunks = None
        trace = None
        try:
            if app.state.model is None or app.state.model_switching:
                await socket.send_json({"type": "error", "code": "model_unavailable", "message": app.state.model_error})
                await socket.close(code=1013)
                return
            if app.state.active_sessions >= settings.max_sessions:
                await socket.send_json({"type": "error", "code": "server_busy", "message": "No free transcription slots"})
                await socket.close(code=1013)
                return
            # Reserve before waiting for start, including clients which never send audio.
            app.state.active_sessions += 1
            registered = True
            initial = await asyncio.wait_for(socket.receive(), timeout=10)
            if initial["type"] == "websocket.disconnect":
                return
            text = initial.get("text")
            if text is None or len(text) > 16384:
                raise ProtocolError("First message must be a small JSON start message")
            try:
                start = StartMessage.model_validate_json(text)
            except ValidationError:
                raise ProtocolError("Invalid start: use type=start, sampleRate, channels=1, format=pcm_s16le") from None
            if settings.token and not secrets.compare_digest(settings.token, start.token):
                await socket.send_json({"type": "error", "code": "unauthorized", "message": "Invalid token"})
                await socket.close(code=1008)
                return
            session = AudioSession(start.sampleRate, settings)
            try:
                model = await app.state.studio.checkpoint_model(start.modelId)
            except (ValueError, FileNotFoundError):
                raise ProtocolError("Requested model version is unavailable") from None
            session_id = str(uuid.uuid4())
            recording_chunks = [] if start.saveRecording else None
            audit = {"sessionId": session_id, "testId": start.testId, "context": start.testContext,
                     "username": browser_username,
                     "startedAt": time.time(), "status": "running", "model": model.metadata(),
                     "inputSampleRate": start.sampleRate, "recordingKind": start.recordingKind,
                     "windows": [], "recordingId": None}
            audit_path = app.state.studio.store.root / "stream-runs" / (uuid.UUID(session_id).hex + ".json")
            trace = SessionTrace(app.state.studio.store.root, session_id)
            trace.record("session_start", sessionId=session_id, username=browser_username, recordingKind=start.recordingKind,
                         inputSampleRate=start.sampleRate, stepMs=settings.step_frames * HOP / SAMPLE_RATE * 1000,
                         rightContextMs=settings.right_frames * HOP / SAMPLE_RATE * 1000)
            audit["latencyTrace"] = str(trace.path.name)
            last_packet_received_ms = None
            next_packet_log = 0

            def persist_audit():
                nonlocal recording
                if recording is None and recording_chunks is not None and session.total_samples >= SAMPLE_RATE // 4:
                    prefix = "中断测试录音 " if audit["status"] != "completed" else (
                        "虚拟钢琴模拟 " if start.recordingKind == "simulated" else "跟弹录音 ")
                    recording = app.state.studio.store.create_record(
                        prefix + time.strftime("%Y-%m-%d %H-%M-%S"), np.concatenate(recording_chunks),
                        "synthetic-simulator" if start.recordingKind == "simulated" else "uploaded",
                    )
                audit.update(endedAt=time.time(), recordingId=recording["id"] if recording else None,
                             receivedSamples=session.reader.samples, receivedPackets=session.reader.sequence,
                             audioSeconds=session.reader.samples / start.sampleRate)
                atomic_json(audit_path, audit)

            await asyncio.to_thread(atomic_json, audit_path, audit)
            await socket.send_json({
                "type": "ready", "version": 1, "sessionId": session_id,
                "inputSampleRate": start.sampleRate, "model": model.metadata(),
                "maxAudioSeconds": settings.max_audio_seconds,
                "binaryHeader": "uint32LE sequence + uint64LE sampleOffset + PCM16LE samples",
            })

            async def drain() -> None:
                while (window := session.pop_window()) is not None:
                    audio, first_frame, frame_count = window
                    began = time.perf_counter()
                    queued_at_ms = time.time() * 1000
                    events, inference_ms = await asyncio.get_running_loop().run_in_executor(
                        app.state.pool, model.infer, audio, first_frame, frame_count,
                    )
                    events = session.unique_events(events)
                    total_ms = (time.perf_counter() - began) * 1000
                    payload = {
                        "type": "notes", "sessionId": session_id, "windowId": first_frame, "events": events,
                        "processedThroughSeconds": round(min(
                            session.total_samples / SAMPLE_RATE,
                            (first_frame + frame_count) * HOP / SAMPLE_RATE,
                        ), 6),
                        "receivedAudioSeconds": round(session.reader.samples / start.sampleRate, 6),
                        "inferenceMs": round(inference_ms, 2),
                        "queueAndInferenceMs": round(total_ms, 2),
                        "serverTiming": {
                            "lastPacketSequence": session.reader.sequence - 1,
                            "applicationReceivedAtUnixMs": last_packet_received_ms,
                            "inferenceQueuedAtUnixMs": round(queued_at_ms, 3),
                            "resultReadyAtUnixMs": round(time.time() * 1000, 3),
                            "executorWaitAndOverheadMs": round(max(0, total_ms - inference_ms), 2),
                            "stepAudioMs": round(frame_count * HOP / SAMPLE_RATE * 1000, 2),
                            "computeToAudioRatio": round(total_ms / (frame_count * HOP / SAMPLE_RATE * 1000), 3),
                        },
                        "tailPadded": session.finished,
                    }
                    audit["windows"].append(payload)
                    trace.record("model_window", **payload)
                    send_began = time.perf_counter()
                    await socket.send_json(payload)
                    trace.record("websocket_send", windowId=first_frame,
                                 sendAwaitMs=round((time.perf_counter() - send_began) * 1000, 3))

            while True:
                message = await asyncio.wait_for(socket.receive(), timeout=settings.idle_timeout_seconds)
                if message["type"] == "websocket.disconnect":
                    return
                if message.get("bytes") is not None:
                    last_packet_received_ms = round(time.time() * 1000, 3)
                    chunk = session.append(message["bytes"])
                    if session.reader.samples >= next_packet_log:
                        trace.record("pcm_receive", sequence=session.reader.sequence - 1,
                                     audioSeconds=round(session.reader.samples / start.sampleRate, 6),
                                     applicationReceivedAtUnixMs=last_packet_received_ms,
                                     activeSessions=app.state.active_sessions)
                        next_packet_log = session.reader.samples + start.sampleRate
                    if recording_chunks is not None:
                        recording_chunks.append(chunk)
                    await drain()
                elif message.get("text") is not None:
                    text = message["text"]
                    if len(text) > 16384:
                        raise ProtocolError("Control message too large")
                    try:
                        control = json.loads(text)
                    except json.JSONDecodeError:
                        raise ProtocolError("Control message must be JSON") from None
                    if not isinstance(control, dict):
                        raise ProtocolError("Control message must be a JSON object")
                    if control.get("type") == "ping":
                        pong = {"type": "pong", "receivedSamples": session.reader.samples}
                        if isinstance(control.get("clientSentAt"), (int, float)) and np.isfinite(control["clientSentAt"]):
                            pong["clientSentAt"] = control["clientSentAt"]
                        await socket.send_json(pong)
                    elif control.get("type") == "telemetry":
                        if len(json.dumps(control)) > 4096:
                            raise ProtocolError("Telemetry message too large")
                        fields = client_timing(control)
                        trace.record("browser_window", **fields)
                    elif control.get("type") == "stop":
                        # End counters make dropped final packets detectable.
                        if control.get("packets") != session.reader.sequence or control.get("samples") != session.reader.samples:
                            raise ProtocolError("Stop counters must match all transmitted packets and samples")
                        tail = session.finish()
                        if recording_chunks is not None:
                            recording_chunks.append(tail)
                        await drain()
                        audit["status"] = "completed"
                        audit_task = asyncio.create_task(asyncio.to_thread(persist_audit))
                        await asyncio.shield(audit_task)
                        await socket.send_json({
                            "type": "complete", "sessionId": session_id,
                            "receivedPackets": session.reader.sequence,
                            "receivedSamples": session.reader.samples,
                            "audioSeconds": session.reader.samples / start.sampleRate,
                            "noteCount": session.note_count,
                            "recordingId": recording["id"] if recording else None,
                        })
                        await socket.close(code=1000)
                        return
                    else:
                        raise ProtocolError("Expected binary PCM, ping or stop")
        except (ProtocolError, asyncio.TimeoutError) as error:
            if audit is not None:
                audit.update(status="failed", error=str(error) or "Audio stream timed out")
            try:
                await socket.send_json({"type": "error", "code": "invalid_stream", "message": str(error) or "Audio stream timed out"})
                await socket.close(code=1008)
            except (WebSocketDisconnect, RuntimeError, OSError):
                pass
        except WebSocketDisconnect:
            pass
        except Exception:
            if audit is not None:
                audit.update(status="failed", error="Inference or transport failure; see application log")
            logger.exception("Transcription failed")
            try:
                await socket.send_json({"type": "error", "code": "inference_failed", "message": "Inference failed; check server logs"})
                await socket.close(code=1011)
            except (WebSocketDisconnect, RuntimeError, OSError):
                pass
        finally:
            auth.untrack(socket, browser_token)
            if registered:
                app.state.active_sessions -= 1
            if audit is not None:
                if audit["status"] == "running":
                    audit["status"] = "interrupted"
                # Start finalization before any cancellable await. A disconnected
                # request must not cancel the recording or trace writer.
                async def finalize():
                    try:
                        if trace is not None:
                            trace.record("session_end", status=audit["status"], receivedPackets=session.reader.sequence,
                                         audioSeconds=round(session.reader.samples / start.sampleRate, 6),
                                         droppedLogEntries=trace.dropped, traceError=trace.error)
                            await trace.close()
                            audit["latencyTraceDroppedEntries"] = trace.dropped
                            audit["latencyTraceError"] = trace.error
                        if audit_task is None:
                            await asyncio.to_thread(persist_audit)
                        else:
                            await audit_task
                            await asyncio.to_thread(atomic_json, audit_path, audit)
                    except Exception:
                        logger.exception("Failed to persist transcription session %s", session_id)
                final_task = asyncio.create_task(finalize())
                app.state.audit_tasks.add(final_task)
                final_task.add_done_callback(app.state.audit_tasks.discard)
                await asyncio.shield(final_task)

    return app


app = create_app()
