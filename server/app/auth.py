"""Browser and WebSocket authentication share a revocable, HttpOnly cookie."""

import asyncio
from collections import defaultdict, deque
import hashlib
from html import escape
import secrets
import sqlite3
import time
from urllib.parse import quote, urlsplit
from urllib.parse import unquote
import posixpath

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from .config import ROOT

COOKIE_NAME = "pianoval_session"
PASSWORD_ITERATIONS = 600_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PASSWORD_ITERATIONS).hex()
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt}${digest}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt, expected = encoded.split("$")
        if algorithm != "pbkdf2_sha256" or not 100_000 <= int(iterations) <= 2_000_000:
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
        return secrets.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def cookie_path(scope) -> str:
    return scope.get("root_path", "").rstrip("/") + "/"


def local_destination(value: str, prefix: str) -> str:
    """Keep redirects inside this application, including subpath deployments."""
    parsed = urlsplit(value)
    normalized = posixpath.normpath(unquote(parsed.path)) + "/"
    if (not value.startswith(prefix) or value.startswith("//") or parsed.scheme or parsed.netloc
            or not normalized.startswith(prefix) or "\\" in unquote(value)
            or any(ord(char) < 32 for char in unquote(value))):
        return prefix
    return value


class BrowserAuth:
    def __init__(self, settings):
        self.settings = settings
        self.accounts = dict(settings.login_accounts)
        if settings.login_username and settings.password_hash:
            self.accounts[settings.login_username] = settings.password_hash
        if any(not isinstance(name, str) or not name or len(name) > 128 or not isinstance(encoded, str)
               or not encoded.startswith("pbkdf2_sha256$") for name, encoded in self.accounts.items()):
            raise ValueError("Invalid login account configuration")
        self.enabled = bool(self.accounts)
        self.database = settings.studio_dir / "auth" / "sessions.sqlite3"
        self.attempts = defaultdict(deque)
        self.sockets = defaultdict(set)

    def initialize(self):
        if not self.enabled:
            return
        self.database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with sqlite3.connect(self.database) as database:
            database.execute("CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, username TEXT, expires REAL)")
            database.execute("DELETE FROM sessions WHERE expires <= ?", (time.time(),))
        self.database.chmod(0o600)

    def user(self, token):
        if not self.enabled or not token or len(token) > 128:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        with sqlite3.connect(self.database) as database:
            row = database.execute("SELECT username FROM sessions WHERE digest = ? AND expires > ?",
                                   (digest, time.time())).fetchone()
        return row[0] if row and row[0] in self.accounts else None

    def issue(self, username):
        token = secrets.token_urlsafe(32)
        with sqlite3.connect(self.database) as database:
            database.execute("DELETE FROM sessions WHERE expires <= ?", (time.time(),))
            database.execute("INSERT INTO sessions VALUES (?, ?, ?)", (
                hashlib.sha256(token.encode()).hexdigest(), username,
                time.time() + self.settings.session_hours * 3600,
            ))
        return token

    async def revoke(self, token):
        if not token or not self.enabled:
            return
        digest = hashlib.sha256(token.encode()).hexdigest()
        def remove():
            with sqlite3.connect(self.database) as database:
                database.execute("DELETE FROM sessions WHERE digest = ?", (digest,))
        await asyncio.to_thread(remove)
        for socket in list(self.sockets.pop(digest, set())):
            try:
                await socket.close(code=1008, reason="Signed out")
            except (RuntimeError, OSError):
                pass

    def track(self, socket, token):
        if self.enabled and token:
            self.sockets[hashlib.sha256(token.encode()).hexdigest()].add(socket)

    def untrack(self, socket, token):
        if self.enabled and token:
            digest = hashlib.sha256(token.encode()).hexdigest()
            connections = self.sockets.get(digest)
            if connections is not None:
                connections.discard(socket)
                if not connections:
                    self.sockets.pop(digest, None)

    def allow_attempt(self, address):
        now = time.monotonic()
        for key in list(self.attempts):
            if not self.attempts[key] or self.attempts[key][-1] <= now - 60:
                self.attempts.pop(key, None)
        attempts = self.attempts[address]
        while attempts and attempts[0] <= now - 60:
            attempts.popleft()
        if len(attempts) >= 10:
            return False
        attempts.append(now)
        return True


def same_origin(request):
    origin = request.headers.get("origin")
    return not origin or origin == f"{request.url.scheme}://{request.url.netloc}"


def install_browser_auth(app, settings):
    auth = BrowserAuth(settings)
    app.state.browser_auth = auth
    router = APIRouter(prefix="/auth")

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        path = request.scope["path"]
        prefix = request.scope.get("root_path", "").rstrip("/")
        if prefix and path.startswith(prefix + "/"):
            path = path[len(prefix):]
        if auth.enabled and path not in {"/auth/login", "/auth/logout", "/auth/session", "/health", "/ready"}:
            user = await asyncio.to_thread(auth.user, request.cookies.get(COOKIE_NAME))
            if user is None:
                if path.startswith("/api/") or request.method != "GET":
                    return JSONResponse({"detail": "登录已失效，请重新登录", "code": "login_required"}, status_code=401)
                destination = str(request.url.path)
                if request.url.query:
                    destination += "?" + request.url.query
                return RedirectResponse(cookie_path(request.scope) + "auth/login?next=" + quote(destination, safe=""), status_code=303)
        response = await call_next(request)
        if auth.enabled and (path.startswith("/auth/") or path.startswith("/api/") or path == "/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def login_page(request, error="", status=200, destination=None):
        prefix = cookie_path(request.scope)
        destination = local_destination(destination or request.query_params.get("next", prefix), prefix)
        html = (ROOT / "static/login.html").read_text()
        for key, value in {"ACTION": prefix + "auth/login", "NEXT": destination, "ERROR": error}.items():
            html = html.replace("{{" + key + "}}", escape(value, quote=True))
        return HTMLResponse(html, status_code=status, headers={"Cache-Control": "no-store"})

    @router.get("/login")
    async def login_form(request: Request):
        if not auth.enabled:
            return RedirectResponse(cookie_path(request.scope), status_code=303)
        if await asyncio.to_thread(auth.user, request.cookies.get(COOKIE_NAME)):
            return RedirectResponse(local_destination(request.query_params.get("next", ""), cookie_path(request.scope)), status_code=303)
        return login_page(request)

    @router.post("/login")
    async def login(request: Request):
        if not same_origin(request):
            return JSONResponse({"detail": "请从本站登录"}, status_code=403)
        if not auth.enabled:
            return RedirectResponse(cookie_path(request.scope), status_code=303)
        if not auth.allow_attempt(request.client.host if request.client else "unknown"):
            return login_page(request, "尝试次数过多，请一分钟后再试", 429)
        if int(request.headers.get("content-length", "0")) > 8192:
            return login_page(request, "登录信息过长", 400)
        form = await request.form(max_fields=3, max_files=0)
        username, password = form.get("username", ""), form.get("password", "")
        if not isinstance(username, str) or not isinstance(password, str) or len(username) > 128 or len(password) > 1024:
            return login_page(request, "账号或密码不正确", 401)
        encoded = auth.accounts.get(username, next(iter(auth.accounts.values())))
        password_ok = await asyncio.to_thread(verify_password, password, encoded)
        if username not in auth.accounts or not password_ok:
            return login_page(request, "账号或密码不正确", 401, str(form.get("next", "")))
        token = await asyncio.to_thread(auth.issue, username)
        response = RedirectResponse(local_destination(str(form.get("next", "")), cookie_path(request.scope)), status_code=303)
        response.set_cookie(COOKIE_NAME, token, max_age=settings.session_hours * 3600,
                            path=cookie_path(request.scope), secure=request.url.scheme == "https",
                            httponly=True, samesite="lax")
        return response

    @router.get("/session")
    async def session(request: Request):
        user = await asyncio.to_thread(auth.user, request.cookies.get(COOKIE_NAME)) if auth.enabled else None
        return {"required": auth.enabled, "authenticated": bool(user), "username": user}

    @router.post("/logout")
    async def logout(request: Request):
        if not same_origin(request):
            return JSONResponse({"detail": "请从本站退出登录"}, status_code=403)
        await auth.revoke(request.cookies.get(COOKIE_NAME))
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE_NAME, path=cookie_path(request.scope),
                               secure=request.url.scheme == "https", httponly=True, samesite="lax")
        return response

    app.include_router(router)
    return auth
