"""Start the local workbench with its saved test-account configuration."""

import json
import os
from pathlib import Path
import sys

import uvicorn

root = Path(__file__).resolve().parents[1]
os.chdir(root)
sys.path.insert(0, str(root))
accounts = root / "data/local-login.json"
if accounts.is_file():
    os.environ["PIANOVAL_LOGIN_ACCOUNTS_JSON"] = json.dumps(json.loads(accounts.read_text()))
uvicorn.run("app.main:app", host="0.0.0.0", port=8765)
