"""Recording upload, reviewed labels, async inference and supervised fine-tuning."""

import asyncio
from dataclasses import asdict
import json
from pathlib import Path
import secrets
import sys
import tempfile

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from .config import ROOT, Settings
from .dataset import Annotation, NoteLabel, StudioStore, atomic_json, decode_audio, onset_metrics, parse_midi, read_json
from .demo import install_demo
from .model import SAMPLE_RATE, PianoModel
from .session import AudioSession
from .practice import ComparisonRequest, compare_score, score_data, catalog_summary
from .test_runs import TestRunReport, save_report, summaries, load_report


class TrainingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    steps: int = Field(default=50, ge=1, le=500, strict=True)
    learningRate: float = Field(default=0.0001, ge=0.000001, le=0.001)
    seed: int = Field(default=42, ge=0, le=2147483647, strict=True)


class InferenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    modelId: str = "active"


class RecognitionComparison(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected: list[NoteLabel] = Field(max_length=50000)
    observed: list[NoteLabel] = Field(max_length=50000)


class Studio:
    def __init__(self, app, settings: Settings):
        self.app, self.settings = app, settings
        self.store = StudioStore(settings.studio_dir)
        self.tasks = {}
        self.processes = {}
        for job in self.store.list_jobs():
            if job["status"] in ("queued", "running"):
                self.store.update_job(job["id"], status="interrupted", error="服务上次已停止；请重新创建任务")

    async def checkpoint_model(self, version: str):
        current = self.app.state.model
        if version == "active" or version == getattr(current, "version", "base"):
            if current is None:
                raise ValueError("模型尚未就绪")
            return current
        if version == "base":
            return await asyncio.get_running_loop().run_in_executor(self.app.state.pool, PianoModel, self.settings)
        job = self.store.get_job(version)
        if job["kind"] != "training" or job["status"] != "completed":
            raise ValueError("候选模型尚未训练完成")
        return await asyncio.get_running_loop().run_in_executor(
            self.app.state.pool, PianoModel, self.settings,
            self.store.job_path(version) / "candidate.torch", job["result"]["checkpointSha256"], version,
        )

    async def restore(self):
        path = self.store.root / "active.json"
        if path.is_file() and self.app.state.model is not None:
            try:
                self.app.state.model = await self.checkpoint_model(read_json(path)["modelId"])
            except Exception as error:
                self.app.state.model_error = f"候选模型恢复失败，已保留基础模型：{error}"

    def track(self, job, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks[job["id"]] = task
        task.add_done_callback(lambda _: self.tasks.pop(job["id"], None))

    async def close(self):
        for process in self.processes.values():
            if process.returncode is None:
                process.terminate()
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def busy(self, kind):
        return any(job["kind"] == kind and job["status"] in ("queued", "running") for job in self.store.list_jobs())

    async def infer_job(self, job, record, version):
        identifier = job["id"]
        try:
            self.store.update_job(identifier, status="running", phase="transcribing")
            model = await self.checkpoint_model(version)
            audio = np.load(self.store.directory(record["id"]) / "audio.npy", allow_pickle=False)
            session = AudioSession(SAMPLE_RATE, self.settings)
            session._append_resampled(audio)
            session.finish()
            events = []
            while (window := session.pop_window()) is not None:
                predicted, _ = await asyncio.get_running_loop().run_in_executor(self.app.state.pool, model.infer, *window)
                events.extend(session.unique_events(predicted))
                self.store.update_job(identifier, progress=min(0.99, session.next_frame * 384 / len(audio)))
                await asyncio.sleep(0)
            result = {"events": events, "model": model.metadata(), "recordRevision": record["revision"],
                      "metrics": onset_metrics(record["notes"], events) if record["reviewed"] else None}
            atomic_json(self.store.job_path(identifier) / "result.json", result)
            self.store.update_job(identifier, status="completed", progress=1, noteCount=len(events),
                                  modelId=model.version, metrics=result["metrics"])
        except asyncio.CancelledError:
            self.store.update_job(identifier, status="cancelled")
            raise
        except Exception as error:
            self.store.update_job(identifier, status="failed", error=str(error))

    async def training_job(self, job):
        identifier = job["id"]
        path = self.store.job_path(identifier)
        process = None
        try:
            self.store.update_job(identifier, status="running", phase="starting")
            with (path / "worker.log").open("wb") as log:
                process = await asyncio.create_subprocess_exec(
                    sys.executable, "-m", "app.training", str(path / "config.json"),
                    cwd=ROOT, stdout=log, stderr=log,
                )
                self.processes[identifier] = process
                while process.returncode is None:
                    try:
                        await asyncio.wait_for(process.wait(), timeout=0.75)
                    except asyncio.TimeoutError:
                        pass
                    if (path / "progress.json").exists():
                        report = read_json(path / "progress.json")
                        self.store.update_job(identifier, phase=report["phase"],
                                              progress=report["step"] / report["steps"], report=report)
            if process.returncode != 0:
                message = read_json(path / "worker-error.json")["message"] if (path / "worker-error.json").exists() else "训练进程失败，请检查任务日志"
                raise ValueError(message)
            result = read_json(path / "result.json")
            self.store.update_job(identifier, status="completed", phase="complete", progress=1, result=result)
        except asyncio.CancelledError:
            if process is not None and process.returncode is None:
                process.terminate()
                await process.wait()
            self.store.update_job(identifier, status="cancelled")
            raise
        except Exception as error:
            self.store.update_job(identifier, status="failed", error=str(error))
        finally:
            self.processes.pop(identifier, None)


def studio_router(settings):
    async def authorize(request: Request, x_pianoval_token: str = Header(default="")):
        if settings.token and not secrets.compare_digest(settings.token, x_pianoval_token):
            raise HTTPException(401, "访问令牌无效")
        origin = request.headers.get("origin")
        if settings.allowed_origins and origin and origin not in settings.allowed_origins:
            raise HTTPException(403, "此页面来源未获允许")

    router = APIRouter(prefix="/api/studio", dependencies=[Depends(authorize)])

    def studio(request: Request) -> Studio:
        return request.app.state.studio

    async def limited_upload(file: UploadFile, limit):
        data = bytearray()
        while chunk := await file.read(65536):
            data.extend(chunk)
            if len(data) > limit:
                raise HTTPException(413, "上传文件过大")
        if not data:
            raise HTTPException(400, "上传文件为空")
        return bytes(data)

    @router.get("/state")
    def state(request: Request):
        work = studio(request)
        return {"records": work.store.list_records(), "jobs": work.store.list_jobs(),
                "model": request.app.state.model.metadata() if request.app.state.model else None,
                "modelError": request.app.state.model_error,
                "limits": {"audioSeconds": settings.max_audio_seconds, "uploadBytes": 50 * 1024 * 1024}}

    @router.get("/practice/catalog")
    def practice_catalog():
        return {"pieces": catalog_summary()}

    @router.get("/practice/{difficulty}")
    def practice(difficulty: str, pieceId: str = "listen-to-mom"):
        return score_data(difficulty, pieceId)

    @router.post("/recognition/compare")
    def compare_recognition(body: RecognitionComparison):
        return onset_metrics([note.model_dump() for note in body.expected],
                             [note.model_dump() for note in body.observed])

    @router.post("/test-runs")
    def save_test_run(request: Request, body: TestRunReport):
        report = save_report(studio(request).store, body)
        return {"id": report["id"], "diagnostics": report["diagnostics"]}

    @router.get("/test-runs")
    def test_run_history(request: Request):
        return {"runs": summaries(studio(request).store)}

    @router.get("/test-runs/{identifier}")
    def test_run_report(request: Request, identifier: str):
        return load_report(studio(request).store, identifier)

    @router.post("/practice/compare")
    def compare(request: Request, body: ComparisonRequest):
        if body.jobId:
            job = studio(request).store.get_job(body.jobId)
            if job["kind"] != "inference" or job["status"] != "completed":
                raise HTTPException(409, "请等待录音识别完成")
            notes = read_json(studio(request).store.job_path(body.jobId) / "result.json")["events"]
        else:
            notes = [note.model_dump() for note in body.notes]
        return compare_score(body, notes)

    @router.post("/demo")
    def demo(request: Request):
        return install_demo(studio(request).store)

    @router.post("/demo/exclude")
    def exclude_demo(request: Request):
        work = studio(request)
        for record in work.store.list_records():
            if record.get("provenance", "").startswith("synthetic"):
                detail = work.store.get_record(record["id"])
                work.store.annotate(record["id"], Annotation(notes=detail["notes"], reviewed=detail["reviewed"],
                                                           group=detail["group"], split="unassigned"), detail["labelSource"])
        return {"ok": True}

    @router.post("/recordings")
    async def upload(request: Request, audio: UploadFile = File()):
        suffix = Path(audio.filename or "recording.wav").suffix.lower()
        if suffix not in (".wav", ".flac", ".mp3", ".m4a", ".ogg", ".webm", ".aac"):
            raise HTTPException(400, "支持 WAV / FLAC / MP3 / M4A / OGG / WebM / AAC")
        data = await limited_upload(audio, 50 * 1024 * 1024)
        with tempfile.TemporaryDirectory(prefix="pianoval-upload-") as directory:
            path = Path(directory) / f"input{suffix}"
            path.write_bytes(data)
            try:
                decoded = await asyncio.to_thread(decode_audio, path, settings.max_audio_seconds)
            except ValueError as error:
                raise HTTPException(400, str(error)) from None
        return studio(request).store.create_record(Path(audio.filename).name, decoded)

    @router.get("/recordings/{identifier}")
    def recording(request: Request, identifier: str):
        return studio(request).store.get_record(identifier)

    @router.get("/recordings/{identifier}/audio")
    def recording_audio(request: Request, identifier: str):
        return FileResponse(studio(request).store.directory(identifier) / "audio.wav", media_type="audio/wav")

    @router.put("/recordings/{identifier}/labels")
    def labels(request: Request, identifier: str, annotation: Annotation):
        return studio(request).store.annotate(identifier, annotation)

    @router.post("/recordings/{identifier}/midi")
    async def midi_labels(request: Request, identifier: str, midi: UploadFile = File(), offset: float = Form(default=0)):
        data = await limited_upload(midi, 2 * 1024 * 1024)
        store = studio(request).store
        record = store.get_record(identifier)
        notes = parse_midi(data, offset, record["duration"])
        return store.annotate(identifier, Annotation(notes=notes, group=record["group"], split=record["split"], reviewed=False), "midi")

    @router.post("/recordings/{identifier}/transcribe")
    async def inference(request: Request, identifier: str, body: InferenceRequest):
        work = studio(request)
        if work.busy("inference"):
            raise HTTPException(409, "已有上传识别任务，请等待完成")
        if request.app.state.model is None:
            raise HTTPException(503, "模型尚未就绪")
        # Validate candidate identifiers before creating a task.
        if body.modelId not in ("base", "active"):
            candidate = work.store.get_job(body.modelId)
            if candidate["kind"] != "training" or candidate["status"] != "completed":
                raise HTTPException(400, "候选模型不可用")
        record = work.store.get_record(identifier)
        job = work.store.new_job("inference", recordId=identifier, title=record["title"])
        work.track(job, work.infer_job(job, record, body.modelId))
        return job

    @router.post("/training")
    async def training(request: Request, body: TrainingRequest):
        work = studio(request)
        if work.busy("training"):
            raise HTTPException(409, "已有训练任务正在运行")
        if request.app.state.model is None:
            raise HTTPException(503, "模型尚未就绪")
        records = work.store.snapshot()
        job = work.store.new_job("training", parameters=body.model_dump(),
                                 dataset=[{key: record[key] for key in ("id", "title", "revision", "split", "group", "audioSha256")} for record in records])
        settings_data = asdict(settings)
        for key in ("model_path", "studio_dir"):
            settings_data[key] = str(settings_data[key])
        # Authentication material does not belong in training snapshots.
        settings_data["token"] = ""
        atomic_json(work.store.job_path(job["id"]) / "config.json", {
            "root": str(work.store.root.resolve()), "settings": settings_data,
            "parameters": body.model_dump(), "records": records,
        })
        work.track(job, work.training_job(job))
        return job

    @router.get("/jobs/{identifier}/result")
    def result(request: Request, identifier: str):
        work = studio(request)
        job = work.store.get_job(identifier)
        if job["status"] != "completed":
            raise HTTPException(409, "任务尚未完成")
        return read_json(work.store.job_path(identifier) / "result.json")

    @router.post("/jobs/{identifier}/cancel")
    async def cancel(request: Request, identifier: str):
        work = studio(request)
        if identifier not in work.tasks:
            raise HTTPException(409, "任务未在运行")
        work.tasks[identifier].cancel()
        await asyncio.gather(work.tasks[identifier], return_exceptions=True)
        return work.store.get_job(identifier)

    @router.post("/models/{identifier}/activate")
    async def activate(request: Request, identifier: str):
        work = studio(request)
        if identifier != "base":
            job = work.store.get_job(identifier)
            if job["kind"] != "training" or job["status"] != "completed" or not job["result"]["eligible"]:
                raise HTTPException(409, "候选模型未通过独立验证或使用演示合成数据；仍可用于上传识别对比")
        if request.app.state.active_sessions or request.app.state.model_switching:
            raise HTTPException(409, "录音会话运行中，请停止录音后再切换模型")
        request.app.state.model_switching = True
        try:
            replacement = await work.checkpoint_model(identifier)
            atomic_json(work.store.root / "active.json", {"modelId": identifier})
            request.app.state.model = replacement
            return replacement.metadata()
        finally:
            request.app.state.model_switching = False

    return router
