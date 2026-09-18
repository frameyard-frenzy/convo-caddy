#!/usr/bin/env python3
"""Isolated, fake-transport proof of Hermes API prompt construction."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

MARKERS = {
    "soul": "Synthetic Caddy Identity Sentinel",
    "memory": "Synthetic remembered preference sentinel",
    "user": "Synthetic user context sentinel",
    "caddy": "on-demand customer-interview reasoning assistant",
}


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def parent(source: Path, expected: str) -> int:
    source = source.resolve()
    # HOME can be redirected to a Hermes profile home by the invoking agent.
    # This source-only harness has no valid reason to import from any .hermes tree.
    live = (Path.home() / ".hermes" / "hermes-agent").resolve()
    if source == live or live in source.parents or ".hermes" in source.parts:
        raise SystemExit("Refusing the live Hermes checkout")
    if git(source, "rev-parse", "HEAD") != expected:
        raise SystemExit("Hermes source commit does not match --expected-commit")
    if git(source, "status", "--porcelain", "--untracked-files=no"):
        raise SystemExit("Hermes source checkout is dirty")
    if (source / ".env").exists() or (source / ".env").is_symlink():
        raise SystemExit("Refusing source-local environment file")
    overlays = git(source, "ls-files", "--others").splitlines()
    # Tagged __pycache__ files are ignored via a fresh PYTHONPYCACHEPREFIX;
    # legacy sourceless .pyc modules outside those folders remain forbidden.
    if any(Path(p).parts[0] != ".venv" and (
        Path(p).suffix in (".py", ".yaml", ".yml", ".toml") or
        (Path(p).suffix == ".pyc" and "__pycache__" not in Path(p).parts)
    ) for p in overlays):
        raise SystemExit("Refusing untracked source configuration or executable overlays")
    isolated_python = source / ".venv" / "bin" / "python"
    if Path(sys.prefix).resolve() != (source / ".venv").resolve():
        raise SystemExit(f"Run with the isolated interpreter: {isolated_python}")

    results = []
    for mode in ("enabled", "missing", "disabled"):
        with tempfile.TemporaryDirectory(prefix="caddy-hermes-proof-") as home:
            hermes_home = Path(home) / "hermes"
            memories = hermes_home / "memories"
            memories.mkdir(parents=True)
            (hermes_home / "SOUL.md").write_text(MARKERS["soul"] + "\n", encoding="utf-8")
            if mode != "missing":
                (memories / "MEMORY.md").write_text(MARKERS["memory"] + "\n", encoding="utf-8")
                (memories / "USER.md").write_text(MARKERS["user"] + "\n", encoding="utf-8")
            enabled = mode != "disabled"
            (hermes_home / ".env").write_text("API_SERVER_KEY=synthetic-root-token-only\nOPENROUTER_API_KEY=synthetic-not-a-credential\n", encoding="utf-8")
            (hermes_home / "config.yaml").write_text(
                "model:\n  default: synthetic-model\n  provider: openrouter\n  base_url: http://127.0.0.1:9/v1\n"
                "memory:\n"
                f"  memory_enabled: {str(enabled).lower()}\n"
                f"  user_profile_enabled: {str(enabled).lower()}\n"
                "platform_toolsets:\n  api_server: []\n",
                encoding="utf-8",
            )
            worker = hermes_home / "profiles" / "worker"
            (worker / "memories").mkdir(parents=True)
            (worker / "config.yaml").write_text((hermes_home / "config.yaml").read_text().replace("synthetic-model", "synthetic-worker-model"))
            (worker / ".env").write_text("API_SERVER_KEY=synthetic-worker-token-only\nOPENROUTER_API_KEY=synthetic-worker-provider-token\n")
            (worker / "SOUL.md").write_text("Worker-only identity sentinel")
            if mode != "missing":
                (worker / "memories/MEMORY.md").write_text("Worker-only remembered preference sentinel")
                (worker / "memories/USER.md").write_text("Worker-only user context sentinel")
            env = {
                "PATH": os.environ.get("PATH", ""),
                "LANG": "C.UTF-8",
                "HOME": home,
                "HERMES_HOME": str(hermes_home),
                "OPENROUTER_API_KEY": "synthetic-not-a-credential",
                "HERMES_PROOF_CHILD": "1",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONPYCACHEPREFIX": str(Path(home) / "fresh-bytecode"),
                "HERMES_PROOF_SOURCE": str(source),
                "HERMES_PROOF_MODE": mode,
            }
            if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
                raise SystemExit("This proof requires macOS sandbox-exec network containment")
            sandbox = '(version 1)(allow default)(deny network*)'
            completed = subprocess.run(["/usr/bin/sandbox-exec", "-p", sandbox, str(isolated_python), str(Path(__file__).resolve()), "--child"], env=env, text=True, capture_output=True, timeout=120)
            if completed.returncode:
                raise SystemExit(completed.stderr.strip() or "Hermes proof child failed")
            results.append(json.loads(completed.stdout))
    print(json.dumps({"commit": expected, "source": str(source), "results": results}, sort_keys=True))
    return 0


def child() -> int:
    if os.environ.get("HERMES_PROOF_CHILD") != "1" or sys.platform != "darwin":
        raise SystemExit("Refusing uncontained proof child")
    # Verify actual inherited OS containment, not only a caller-supplied flag.
    import ctypes
    sandbox_check = ctypes.CDLL("/usr/lib/libsandbox.dylib").sandbox_check
    if sandbox_check(os.getpid(), b"network-outbound", 0) == 0:
        raise SystemExit("Refusing uncontained proof child")
    home = Path(os.environ["HOME"]).resolve()
    if not home.name.startswith("caddy-hermes-proof-") or Path(os.environ["HERMES_HOME"]).resolve() != home / "hermes":
        raise SystemExit("Refusing non-synthetic proof home")
    # Deny networking before Hermes imports. Parent also denies network to the
    # entire subprocess tree using the macOS sandbox, including native clients.
    import socket
    import asyncio
    from copy import deepcopy
    from unittest.mock import Mock, AsyncMock, patch
    source = Path(os.environ["HERMES_PROOF_SOURCE"])

    def denied(*args, **kwargs):
        raise RuntimeError("Networking denied in synthetic Hermes proof")

    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied
    sys.path.insert(0, str(source))
    os.chdir(Path(os.environ["HERMES_HOME"]).parent)
    from aiohttp import web
    from aiohttp.test_utils import make_mocked_request
    from openai.types.chat import ChatCompletion
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter
    from run_agent import AIAgent

    for cls, relative in ((AIAgent, "run_agent.py"), (APIServerAdapter, "gateway/platforms/api_server.py")):
        assert Path(sys.modules[cls.__module__].__file__).resolve() == source / relative
    captures = []
    def fake_client_factory(agent, client_kwargs, *, reason, shared):
        # Returning Mock selects the upstream's supported non-streaming test
        # transport; all normal conversation/prompt/request assembly still runs.
        client = Mock(spec=["chat", "close"])
        client.chat = Mock(spec=["completions"])
        client.chat.completions = Mock(spec=["create"])
        def create(**kwargs):
            captures.append({"request": deepcopy(kwargs), "session_id": agent.session_id})
            # Simulate the effective-ID change at the transport seam. Normal
            # handler/agent result propagation is real; compression itself is
            # not exercised (that would need an auxiliary provider request).
            if "synthetic-rotation-action" in json.dumps(kwargs["messages"]):
                agent.session_id = "synthetic-rotated-session-opaque"

            return ChatCompletion(
                id="chatcmpl-proof", object="chat.completion", created=1,
                model=kwargs["model"],
                choices=[{"index": 0, "finish_reason": "stop", "message": {
                    "role": "assistant", "content": '{"text":"synthetic-model-answer","citationTurnIds":[]}'}}],
                usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            )
        client.chat.completions.create.side_effect = create
        return client

    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={"key": "synthetic-root-token-only"}))
    # Use the actual Caddy instructions, not a simplified surrogate.
    prompt_source = (Path(__file__).resolve().parents[1] / "src/server/marty/prompts.ts").read_text()
    caddy_instruction = prompt_source.split("export const MARTY_SYSTEM_PROMPT = `", 1)[1].split("`;", 1)[0]

    named_supported = hasattr(adapter, "_make_profile_prefix_middleware")
    middleware = None
    if named_supported:
        from types import SimpleNamespace
        from gateway.config import GatewayConfig
        import gateway.run
        from agent import secret_scope
        adapter.gateway_runner = SimpleNamespace(config=GatewayConfig(
            multiplex_profiles=True, multiplex_profile_allowlist=["worker"]))
        secret_scope.set_multiplex_active(True)
        middleware = adapter._make_profile_prefix_middleware()

    async def exercise():
        app = web.Application()
        if named_supported:
            for method, path, handler in adapter._http_route_table():
                app.router.add_route(method, path, handler)
                app.router.add_route(method, f"/p/{{profile}}{path}", handler)
        else:
            app.router.add_post("/v1/chat/completions", adapter._handle_chat_completions)
        app.freeze()
        async def post(action, key="synthetic-root-token-only", path="/v1/chat/completions"):

            payload = json.dumps({"task": {"kind": "answer", "question": "Synthetic question"},
                "context": {"transcript": []}, "requestMetadata": {"actionId": action}})
            request = make_mocked_request("POST", path, app=app,
                headers={"Authorization": "Bearer " + key})
            request.json = AsyncMock(return_value={"model": "hermes-agent", "stream": False,
                "messages": [{"role": "system", "content": caddy_instruction}, {"role": "user", "content": payload}]})
            request._match_info = await app.router.resolve(request)
            if middleware:
                return await middleware(request, request.match_info.handler)
            return await request.match_info.handler(request)

        bad = await post("unauthorized-action", "wrong-synthetic-token")
        assert bad.status == 401 and not captures, "Auth must fail before model dispatch"
        responses = []
        for action in ("synthetic-first-action", "synthetic-second-action"):
            before = len(captures)
            response = await post(action)
            assert response.status == 200, (response.status, response.text)
            assert len(captures) == before + 1, "Expected exactly one fake model call"
            assert "synthetic-model-answer" in response.text, response.text
            session = response.headers.get("X-Hermes-Session-Id")
            assert session and len(session) <= 256
            responses.append(session)
            messages = captures[-1]["request"]["messages"]
            system = json.dumps([m for m in messages if m["role"] in ("system", "developer")])
            users = json.dumps([m for m in messages if m["role"] == "user"])
            assert MARKERS["soul"] in system and caddy_instruction in json.loads(system)[-1]["content"]
            assert "Worker-only" not in system

            for name in ("memory", "user"):
                assert (MARKERS[name] in system) == (os.environ["HERMES_PROOF_MODE"] == "enabled")
            assert action in users
            if action == "synthetic-second-action":
                assert "synthetic-first-action" not in users, "Unrelated transcript reused"
                assert "synthetic-model-answer" not in json.dumps(messages), "Prior answer reused"
        assert responses[0] != responses[1], "Independent action fingerprints collided"
        # Replay identical synthetic input to the handler to check that persisted
        # history is not imported. This is a proof request, not a Caddy retry.
        before = len(captures)
        repeated = await post("synthetic-first-action")
        assert repeated.status == 200 and len(captures) == before + 1
        assert captures[-1]["request"]["messages"] == captures[0]["request"]["messages"]
        rotated = await post("synthetic-rotation-action")
        assert rotated.status == 200 and len(captures) == before + 2
        assert rotated.headers["X-Hermes-Session-Id"] == "synthetic-rotated-session-opaque"
        assert captures[-1]["session_id"] != rotated.headers["X-Hermes-Session-Id"]

        if named_supported:
            before = len(captures)
            for path, key, status in (
                ("/p/worker/v1/chat/completions", "synthetic-root-token-only", 401),
                ("/v1/chat/completions", "synthetic-worker-token-only", 401),
                ("/p/unknown/v1/chat/completions", "synthetic-root-token-only", 404),
            ):
                rejected = await post("rejected-action", key, path)
                assert rejected.status == status, (path, rejected.status)
                assert len(captures) == before
            response = await post("synthetic-worker-action", "synthetic-worker-token-only", "/p/worker/v1/chat/completions")
            assert response.status == 200 and "synthetic-model-answer" in response.text, response.text
            assert len(captures) == before + 1
            capture = captures[-1]["request"]
            assert capture["model"] == "synthetic-worker-model", capture["model"]
            system = "\n".join(m["content"] for m in capture["messages"] if m["role"] in ("system", "developer"))
            assert "Worker-only identity sentinel" in system and caddy_instruction in system
            for name in ("memory", "user"):
                marker = {"memory": "Worker-only remembered preference sentinel", "user": "Worker-only user context sentinel"}[name]
                assert (marker in system) == (os.environ["HERMES_PROOF_MODE"] == "enabled")
            assert all(MARKERS[name] not in system for name in ("soul", "memory", "user"))
            assert "synthetic-first-action" not in json.dumps(capture)
            assert "synthetic-second-action" not in json.dumps(capture)
        return {"mode": os.environ["HERMES_PROOF_MODE"], "fake_model_calls": len(captures),
            "path": "real-api-handler/real-agent/fake-client", "request_owned_history": True,
            "rotation": "simulated-agent-id-change/real-response-propagation",
            "named_profile": "verified" if named_supported else "unsupported-by-pinned-source"}

    with patch.object(AIAgent, "_create_openai_client", fake_client_factory):
        result = asyncio.run(exercise())
    print(json.dumps(result))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root")
    parser.add_argument("--expected-commit")
    parser.add_argument("--child", action="store_true")
    args = parser.parse_args()
    if args.child:
        return child()
    if not args.source_root or not args.expected_commit:
        parser.error("--source-root and --expected-commit are required")
    return parent(Path(args.source_root), args.expected_commit)


if __name__ == "__main__":
    raise SystemExit(main())
