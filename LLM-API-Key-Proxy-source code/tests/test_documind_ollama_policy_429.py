"""Tests for Documind Ollama 429 handling (transient vs quota-like)."""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "src"
_RL = _SRC / "rotator_library"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))


def _load_documind_policy_module():
    """Load documind_ollama_policy without importing rotator_library.client (litellm)."""
    rl_pkg = types.ModuleType("rotator_library")
    rl_pkg.__path__ = [str(_RL)]
    sys.modules["rotator_library"] = rl_pkg
    utils_pkg = types.ModuleType("rotator_library.utils")
    utils_pkg.__path__ = [str(_RL / "utils")]
    sys.modules["rotator_library.utils"] = utils_pkg
    paths_spec = importlib.util.spec_from_file_location(
        "rotator_library.utils.paths",
        _RL / "utils" / "paths.py",
    )
    paths_mod = importlib.util.module_from_spec(paths_spec)
    sys.modules["rotator_library.utils.paths"] = paths_mod
    assert paths_spec.loader
    paths_spec.loader.exec_module(paths_mod)
    pol_spec = importlib.util.spec_from_file_location(
        "rotator_library.documind_ollama_policy",
        _RL / "documind_ollama_policy.py",
    )
    pol_mod = importlib.util.module_from_spec(pol_spec)
    sys.modules["rotator_library.documind_ollama_policy"] = pol_mod
    assert pol_spec.loader
    pol_spec.loader.exec_module(pol_mod)
    return pol_mod


_pol = _load_documind_policy_module()
DocumindOllamaPolicy = _pol.DocumindOllamaPolicy
OLLAMA_WEEKLY_QUOTA_WINDOW_MS = _pol.OLLAMA_WEEKLY_QUOTA_WINDOW_MS
parse_dedicated_ollama_quota_reset_at_ms = _pol.parse_dedicated_ollama_quota_reset_at_ms
transient_429_key_cache_duration_ms = _pol.transient_429_key_cache_duration_ms


class TestParseDedicatedQuotaReset(unittest.TestCase):
    def test_retry_after_alone_does_not_count(self) -> None:
        now_ms = 1_700_000_000_000
        h = {"retry-after": "120"}
        self.assertIsNone(parse_dedicated_ollama_quota_reset_at_ms(h, now_ms))

    def test_ollama_session_reset_after_counts(self) -> None:
        now_ms = 1_700_000_000_000
        h = {"x-ollama-session-reset-after": "300"}
        t = parse_dedicated_ollama_quota_reset_at_ms(h, now_ms)
        self.assertIsNotNone(t)
        assert t is not None
        self.assertEqual(t, now_ms + 300_000)


class TestTransientKeyCacheDuration(unittest.TestCase):
    def setUp(self) -> None:
        self._env: dict[str, str | None] = {}
        for k in (
            "OLLAMA_CLOUD_TRANSIENT_429_KEY_CACHE_MS",
            "OLLAMA_CLOUD_DISABLE_KEY_CACHE_FOR_TRANSIENT_429",
        ):
            self._env[k] = os.environ.get(k)

    def tearDown(self) -> None:
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_default_no_key_cache(self) -> None:
        os.environ.pop("OLLAMA_CLOUD_TRANSIENT_429_KEY_CACHE_MS", None)
        os.environ.pop("OLLAMA_CLOUD_DISABLE_KEY_CACHE_FOR_TRANSIENT_429", None)
        self.assertIsNone(
            transient_429_key_cache_duration_ms(30, {"retry-after": "60"})
        )

    def test_cap_with_retry_after(self) -> None:
        os.environ["OLLAMA_CLOUD_TRANSIENT_429_KEY_CACHE_MS"] = "5000"
        os.environ.pop("OLLAMA_CLOUD_DISABLE_KEY_CACHE_FOR_TRANSIENT_429", None)
        d = transient_429_key_cache_duration_ms(30, {})
        self.assertEqual(d, 5000)

    def test_disable_env(self) -> None:
        os.environ["OLLAMA_CLOUD_TRANSIENT_429_KEY_CACHE_MS"] = "60000"
        os.environ["OLLAMA_CLOUD_DISABLE_KEY_CACHE_FOR_TRANSIENT_429"] = "1"
        self.assertIsNone(transient_429_key_cache_duration_ms(30, {}))


class TestOnUpstream429Policy(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.NamedTemporaryFile(
            delete=False, suffix=".json", mode="w", encoding="utf-8"
        )
        self._tmp.write("{}")
        self._tmp.close()
        self.path = Path(self._tmp.name)

    def tearDown(self) -> None:
        if self.path.exists():
            self.path.unlink()

    def test_transient_preserves_session_and_skips_key_cache(self) -> None:
        p = DocumindOllamaPolicy(file_path=self.path)
        p.on_upstream_success(0, {}, document_complete=True)
        row = p._state.keys["0"]
        self.assertEqual(int(row["session"]), 1)

        p.on_upstream_429(
            0,
            "rate limited",
            {},
            retry_after_seconds=60,
            error_type="rate_limit",
        )
        row = p._state.keys["0"]
        self.assertEqual(int(row["session"]), 1)
        self.assertNotIn("0", p._state.key_cache)

    def test_weekly_resets_and_long_lock(self) -> None:
        p = DocumindOllamaPolicy(file_path=self.path)
        p.on_upstream_success(0, {}, document_complete=True)
        now_before = int(__import__("time").time() * 1000)
        p.on_upstream_429(
            0,
            "weekly quota exceeded",
            {},
            error_type="rate_limit",
        )
        row = p._state.keys["0"]
        self.assertEqual(int(row["session"]), 0)
        self.assertEqual(int(row["weekly"]), 0)
        rec = p._state.key_cache.get("0")
        self.assertIsNotNone(rec)
        assert rec is not None
        exp = int(rec["expiresAt"])
        self.assertGreaterEqual(exp - now_before, OLLAMA_WEEKLY_QUOTA_WINDOW_MS - 2000)

    def test_dedicated_header_quota_like_lock(self) -> None:
        p = DocumindOllamaPolicy(file_path=self.path)
        now_ms = int(__import__("time").time() * 1000)
        p.on_upstream_429(
            0,
            "throttled",
            {"x-ollama-session-reset-after": "90"},
            error_type="rate_limit",
        )
        rec = p._state.key_cache.get("0")
        self.assertIsNotNone(rec)
        assert rec is not None
        exp = int(rec["expiresAt"])
        self.assertGreater(exp, now_ms + 80_000)
        self.assertLess(exp, now_ms + 120_000)


if __name__ == "__main__":
    unittest.main()
