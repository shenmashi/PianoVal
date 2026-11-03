from dataclasses import replace
import sqlite3

from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

from app.auth import COOKIE_NAME, hash_password, local_destination, verify_password
from app.config import Settings
from app.main import create_app


class TransportModel:
    def __init__(self, settings):
        self.settings = settings

    def metadata(self):
        return {"name": "auth-transport-test-only", "version": "base"}

    def infer(self, *_):
        return [], 0.0


@pytest.fixture(scope="module")
def password_hash():
    return hash_password("owner-fixture")


@pytest.fixture
def settings(tmp_path, password_hash):
    return Settings(studio_dir=tmp_path, login_username="owner-fixture", password_hash=password_hash)


def login(client, **extra):
    return client.post("/auth/login", data={"username": "owner-fixture", "password": "owner-fixture", **extra}, follow_redirects=False)


def ready(socket):
    socket.send_json({"type": "start", "sampleRate": 16000})
    message = socket.receive_json()
    assert message["type"] == "ready"
    return message


def test_password_verification_does_not_accept_bad_or_malformed_credentials(password_hash):
    assert verify_password("owner-fixture", password_hash)
    assert not verify_password("wrong", password_hash)
    assert not verify_password("owner-fixture", "malformed")


def test_login_protects_page_api_and_websocket_without_basic_auth(settings):
    with TestClient(create_app(settings, TransportModel)) as client:
        assert client.get("/auth/session").json() == {"required": True, "authenticated": False, "username": None}
        assert client.get("/", follow_redirects=False).status_code == 303
        assert client.get("/api/studio/state").status_code == 401
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/transcribe"):
                pass
        assert client.get("/health").json()["activeSessions"] == 0
        response = login(client)
        assert response.status_code == 303
        assert "HttpOnly" in response.headers["set-cookie"]
        assert "SameSite=lax" in response.headers["set-cookie"]
        assert client.get("/auth/session").json()["username"] == "owner-fixture"
        assert client.get("/").status_code == 200
        assert client.get("/api/studio/state").status_code == 200
        # Cookie alone authenticates the connection; no HTTP Authorization header.
        with client.websocket_connect("/ws/transcribe") as socket:
            session = ready(socket)
            assert client.get("/health").json()["activeSessions"] == 1
            socket.send_json({"type": "stop", "packets": 0, "samples": 0})
            assert socket.receive_json()["type"] == "complete"
        report = client.get('/api/studio/test-runs/' + session['sessionId']).json()
        assert report['username'] == 'owner-fixture'


def test_logout_revokes_only_this_browser_and_closes_its_open_socket(settings):
    application = create_app(settings, TransportModel)
    with TestClient(application) as client:
        login(client)
        first = client.cookies.get(COOKIE_NAME)
        login(client)
        second = client.cookies.get(COOKIE_NAME)
        assert first != second
        with client.websocket_connect("/ws/transcribe") as socket:
            ready(socket)
            assert client.post("/auth/logout").json() == {"ok": True}
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
        assert not client.get("/auth/session").json()["authenticated"]
        client.cookies.set(COOKIE_NAME, second)
        assert client.get("/api/studio/state").status_code == 401
        client.cookies.set(COOKIE_NAME, first)
        assert client.get("/auth/session").json()["authenticated"]
        assert client.get("/api/studio/state").status_code == 200


def test_cookie_lives_at_https_subpath_and_cannot_redirect_outside_it(settings):
    with TestClient(create_app(settings, TransportModel), base_url="https://testserver", root_path="/pianoval") as client:
        page = client.get("/pianoval/", follow_redirects=False)
        assert page.headers["location"].startswith("/pianoval/auth/login?")
        response = client.post("/pianoval/auth/login", data={"username": "owner-fixture", "password": "owner-fixture", "next": "/pianoval/#practice"}, follow_redirects=False)
        assert response.headers["location"] == "/pianoval/#practice"
        assert "Path=/pianoval/" in response.headers["set-cookie"]
        assert "Secure" in response.headers["set-cookie"]
        assert client.get("/pianoval/api/studio/state").status_code == 200
        with client.websocket_connect("wss://testserver/pianoval/ws/transcribe") as socket:
            ready(socket)
        response = client.post("/pianoval/auth/logout")
        assert "Path=/pianoval/" in response.headers["set-cookie"]
        assert client.get("/pianoval/api/studio/state").status_code == 401


@pytest.mark.parametrize("target", ["https://other.example/", "//other.example/", "/outside/", "/pianoval/../outside/", "/pianoval/%2e%2e/outside/", "/pianoval/\\other", "/pianoval/%0d%0aInjected"])
def test_login_redirect_remains_inside_deployment(target):
    assert local_destination(target, "/pianoval/") == "/pianoval/"


def test_bad_password_and_cross_site_login_logout_are_rejected(settings):
    with TestClient(create_app(settings, TransportModel)) as client:
        response = client.post("/auth/login", data={"username": "owner-fixture", "password": "wrong"})
        assert response.status_code == 401
        assert COOKIE_NAME not in client.cookies
        response = client.post("/auth/login", data={"username": "owner-fixture", "password": "owner-fixture"}, headers={"Origin": "https://other.example"})
        assert response.status_code == 403
        login(client)
        assert client.post("/auth/logout", headers={"Origin": "https://other.example"}).status_code == 403
        assert client.get("/auth/session").json()["authenticated"]


def test_session_survives_restart_but_expired_sessions_are_denied(settings):
    with TestClient(create_app(settings, TransportModel)) as client:
        login(client)
        cookie = client.cookies.get(COOKIE_NAME)
    with TestClient(create_app(settings, TransportModel)) as client:
        client.cookies.set(COOKIE_NAME, cookie)
        assert client.get("/auth/session").json()["authenticated"]
        with sqlite3.connect(settings.studio_dir / "auth/sessions.sqlite3") as database:
            database.execute("UPDATE sessions SET expires = 0")
        assert client.get("/api/studio/state").status_code == 401
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/transcribe"):
                pass


def test_same_account_can_have_two_streams_and_login_does_not_consume_capacity(settings):
    with TestClient(create_app(settings, TransportModel)) as client:
        login(client)
        assert client.get("/health").json()["activeSessions"] == 0
        with client.websocket_connect("/ws/transcribe") as first, client.websocket_connect("/ws/transcribe") as second:
            ready(first)
            ready(second)
            with client.websocket_connect("/ws/transcribe") as third:
                assert third.receive_json()["code"] == "server_busy"
        assert client.get("/health").json()["activeSessions"] == 0


def test_local_development_keeps_optional_authentication(tmp_path):
    with TestClient(create_app(Settings(studio_dir=tmp_path), TransportModel)) as client:
        assert not client.get("/auth/session").json()["required"]
        assert client.get("/").status_code == 200


def test_two_fixture_accounts_have_independent_logins(settings, password_hash):
    settings = replace(settings, login_accounts=(("learner-fixture", hash_password("learner-fixture")),))
    with TestClient(create_app(settings, TransportModel)) as client:
        login(client)
        owner_cookie = client.cookies.get(COOKIE_NAME)
        response = client.post('/auth/login', data={'username':'learner-fixture', 'password':'learner-fixture'}, follow_redirects=False)
        assert response.status_code == 303
        assert client.get('/auth/session').json()['username'] == 'learner-fixture'
        client.post('/auth/logout')
        client.cookies.set(COOKIE_NAME, owner_cookie)
        assert client.get('/auth/session').json()['username'] == 'owner-fixture'
