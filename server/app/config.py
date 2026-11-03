from dataclasses import dataclass
import os
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    model_path: Path = ROOT / "models/onsets-velocities.torch"
    device: str = "cpu"
    threshold: float = 0.74
    mel_offset_db: float = -22.0
    left_frames: int = 100
    step_frames: int = 8
    right_frames: int = 12
    max_sessions: int = 2
    max_audio_seconds: int = 600
    idle_timeout_seconds: int = 60
    token: str = ""
    allowed_origins: tuple[str, ...] = ()
    studio_dir: Path = ROOT / "data/studio"
    login_username: str = ""
    password_hash: str = ""
    session_hours: int = 12
    login_accounts: tuple[tuple[str, str], ...] = ()

    @classmethod
    def from_env(cls) -> "Settings":
        settings = cls(
            model_path=Path(os.getenv("PIANOVAL_MODEL_PATH", str(cls.model_path))),
            device=os.getenv("PIANOVAL_DEVICE", "cpu"),
            threshold=float(os.getenv("PIANOVAL_THRESHOLD", "0.74")),
            mel_offset_db=float(os.getenv("PIANOVAL_MEL_OFFSET_DB", str(cls.mel_offset_db))),
            left_frames=int(os.getenv("PIANOVAL_LEFT_FRAMES", "100")),
            step_frames=int(os.getenv("PIANOVAL_STEP_FRAMES", str(cls.step_frames))),
            right_frames=int(os.getenv("PIANOVAL_RIGHT_FRAMES", str(cls.right_frames))),
            max_sessions=int(os.getenv("PIANOVAL_MAX_SESSIONS", str(cls.max_sessions))),
            max_audio_seconds=int(os.getenv("PIANOVAL_MAX_AUDIO_SECONDS", "600")),
            token=os.getenv("PIANOVAL_TOKEN", ""),
            studio_dir=Path(os.getenv("PIANOVAL_STUDIO_DIR", str(cls.studio_dir))),
            login_username=os.getenv("PIANOVAL_LOGIN_USERNAME", ""),
            password_hash=os.getenv("PIANOVAL_PASSWORD_HASH", ""),
            session_hours=int(os.getenv("PIANOVAL_SESSION_HOURS", "12")),
            login_accounts=tuple(json.loads(os.getenv("PIANOVAL_LOGIN_ACCOUNTS_JSON", "{}")).items()),
            allowed_origins=tuple(filter(None, (
                value.strip() for value in os.getenv("PIANOVAL_ALLOWED_ORIGINS", "").split(",")
            ))),
        )
        if not 0 < settings.threshold <= 1:
            raise ValueError("PIANOVAL_THRESHOLD must be in (0, 1]")
        if not -60 <= settings.mel_offset_db <= 24:
            raise ValueError("PIANOVAL_MEL_OFFSET_DB must be finite and in [-60, 24]")
        if min(settings.left_frames, settings.right_frames) < 6:
            raise ValueError("Context must include at least 6 frames on either side")
        if settings.step_frames < 1 or settings.max_sessions < 1 or settings.max_audio_seconds < 1:
            raise ValueError("Step, session and duration limits must be positive")
        if max(settings.left_frames, settings.right_frames, settings.step_frames) > 1000:
            raise ValueError("Model window settings must be <= 1000 frames")
        if bool(settings.login_username) != bool(settings.password_hash):
            raise ValueError("Login username and password hash must be configured together")
        if not 1 <= settings.session_hours <= 168:
            raise ValueError("Session lifetime must be between 1 and 168 hours")
        return settings
