"""Fetch the exact public upstream checkpoint, verifying SHA256 before use."""

import hashlib
import os
from pathlib import Path
import urllib.request
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "629ff11aceadf01ecc456b1c7f26a104f7e1e571"
FILE = "assets/OnsetsAndVelocities_2023_03_04_09_53_53.289step=43500_f1=0.9675__0.9480.torch"
SHA256 = "90901ff8c7cb15c76a4da2f4aca643a10295c834ac9e549ee16097d4bbce642d"


def download() -> None:
    destination = Path(os.getenv("PIANOVAL_MODEL_PATH", str(ROOT / "models/onsets-velocities.torch")))
    if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() == SHA256:
        print(f"Model already verified: {destination}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".part")
    url = f"https://raw.githubusercontent.com/andres-fr/iamusica_training/{COMMIT}/{quote(FILE, safe='/')}"
    try:
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != SHA256:
            raise ValueError("Downloaded model checksum mismatch")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Model downloaded and verified: {destination}")


if __name__ == "__main__":
    download()
