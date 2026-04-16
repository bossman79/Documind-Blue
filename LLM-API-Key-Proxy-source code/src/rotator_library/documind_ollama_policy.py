# SPDX-License-Identifier: LGPL-3.0-only
"""Documind-compatible Ollama Cloud quota, locks, and session-reset tracking (proxy-side)."""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .utils.paths import get_data_file

_log = logging.getLogger("rotator_library.documind_ollama_policy")

OLLAMA_QUOTA_KEY_COUNT = 18
OLLAMA_SESSION_QUOTA_WINDOW_MS = 4 * 60 * 60 * 1000
OLLAMA_WEEKLY_QUOTA_WINDOW_MS = 5 * 24 * 60 * 60 * 1000
OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL = 106
OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS = 0.826
OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF = 106

ACCEPT_LANG_VARIANTS = [
    "en-US,en;q=0.9",
    "en-GB,en;q=0.9",
    "en-CA,en;q=0.9",
    "en-AU,en;q=0.9",
    "en-NZ,en;q=0.9",
    "en-IE,en;q=0.9",
    "en;q=0.9",
    "en-US,en;q=0.8,es;q=0.5",
    "en-GB,en;q=0.8,fr;q=0.4",
    "en-US,en;q=0.9,de;q=0.3",
]


def _session_lock_fallback_ms() -> int:
    v = os.getenv("OLLAMA_SESSION_LOCK_FALLBACK_MS", "").strip()
    if v.isdigit() and int(v) > 0:
        return int(v)
    return 20 * 60 * 1000


def parse_ollama_session_reset_at_ms(
    raw_headers: Any, now_ms: Optional[int] = None
) -> Optional[int]:
    """Mirror core/src/ollamaSessionReset.ts — epoch ms for session quota reset, or None."""

    def header_get(name: str) -> Optional[str]:
        if raw_headers is None:
            return None
        if hasattr(raw_headers, "get"):
            for n in (name, name.lower()):
                v = raw_headers.get(n)
                if v is not None and str(v) != "":
                    return str(v)
        if isinstance(raw_headers, dict):
            for k, v in raw_headers.items():
                if k.lower() == name.lower() and v is not None and str(v) != "":
                    return str(v)
        return None

    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)

    for n in (
        "x-ollama-session-reset-after",
        "x-ollama-session-reset-in",
        "x-usage-session-reset-after",
        "x-session-reset-after",
        "x-ollama-reset-after",
    ):
        v = header_get(n)
        if v is not None:
            try:
                sec = float(v)
                if sec >= 0:
                    return int(now_ms + sec * 1000)
            except ValueError:
                pass

    ra = header_get("retry-after")
    if ra is not None:
        s = ra.strip()
        if s.isdigit():
            t = now_ms + int(s) * 1000
            if t > now_ms:
                return t
        try:
            d = int(
                time.mktime(
                    time.strptime(s[:31], "%a, %d %b %Y %H:%M:%S GMT")
                )
                * 1000
            )
        except Exception:
            try:
                from email.utils import parsedate_to_datetime

                dt = parsedate_to_datetime(s)
                d = int(dt.timestamp() * 1000) if dt else 0
            except Exception:
                d = 0
        if d > now_ms:
            return d

    for n in (
        "x-ollama-session-reset",
        "x-usage-session-reset",
        "x-ratelimit-reset",
        "ratelimit-reset",
        "x-ratelimit-reset-requests",
    ):
        v = header_get(n)
        if v is not None:
            try:
                num = float(v)
                ms = int(num * 1000) if num < 1e12 else int(num)
                if ms > now_ms:
                    return ms
            except ValueError:
                pass

    for n in (
        "x-ollama-session-reset-at",
        "x-usage-session-reset-at",
        "x-ollama-session-reset-time",
    ):
        v = header_get(n)
        if v is not None:
            try:
                from email.utils import parsedate_to_datetime

                dt = parsedate_to_datetime(v)
                if dt:
                    t = int(dt.timestamp() * 1000)
                    if t > now_ms:
                        return t
            except Exception:
                t = int(
                    time.mktime(
                        time.strptime(v[:19], "%Y-%m-%dT%H:%M:%S")
                    )
                    * 1000
                )
                if t > now_ms:
                    return t
    return None


def parse_dedicated_ollama_quota_reset_at_ms(
    raw_headers: Any, now_ms: Optional[int] = None
) -> Optional[int]:
    """Session/quota reset from Ollama-specific headers only.

    Excludes ``Retry-After`` and generic ``x-ratelimit-*`` so short throttles
    are not treated as session exhaustion (see ``on_upstream_429``).
    """

    def header_get(name: str) -> Optional[str]:
        if raw_headers is None:
            return None
        if hasattr(raw_headers, "get"):
            for n in (name, name.lower()):
                v = raw_headers.get(n)
                if v is not None and str(v) != "":
                    return str(v)
        if isinstance(raw_headers, dict):
            for k, v in raw_headers.items():
                if k.lower() == name.lower() and v is not None and str(v) != "":
                    return str(v)
        return None

    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)

    for n in (
        "x-ollama-session-reset-after",
        "x-ollama-session-reset-in",
        "x-usage-session-reset-after",
        "x-session-reset-after",
        "x-ollama-reset-after",
    ):
        v = header_get(n)
        if v is not None:
            try:
                sec = float(v)
                if sec >= 0:
                    return int(now_ms + sec * 1000)
            except ValueError:
                pass

    for n in ("x-ollama-session-reset", "x-usage-session-reset"):
        v = header_get(n)
        if v is not None:
            try:
                num = float(v)
                ms = int(num * 1000) if num < 1e12 else int(num)
                if ms > now_ms:
                    return ms
            except ValueError:
                pass

    for n in (
        "x-ollama-session-reset-at",
        "x-usage-session-reset-at",
        "x-ollama-session-reset-time",
    ):
        v = header_get(n)
        if v is not None:
            try:
                from email.utils import parsedate_to_datetime

                dt = parsedate_to_datetime(v)
                if dt:
                    t = int(dt.timestamp() * 1000)
                    if t > now_ms:
                        return t
            except Exception:
                try:
                    t = int(
                        time.mktime(
                            time.strptime(v[:19], "%Y-%m-%dT%H:%M:%S")
                        )
                        * 1000
                    )
                    if t > now_ms:
                        return t
                except Exception:
                    pass
    return None


def _retry_after_seconds_from_headers(headers: Dict[str, str]) -> Optional[int]:
    ra = headers.get("retry-after")
    if ra is None:
        return None
    s = str(ra).strip()
    if s.isdigit():
        v = int(s)
        return v if v > 0 else None
    return None


def transient_429_key_cache_duration_ms(
    retry_after_seconds: Optional[int],
    response_headers: Dict[str, str],
) -> Optional[int]:
    """Milliseconds to hold ``key_cache`` for a transient 429, or None to skip.

    ``OLLAMA_CLOUD_TRANSIENT_429_KEY_CACHE_MS`` (default 0) = do not set ``key_cache``
    for transient throttles; ``usage_manager`` handles short cooldowns.

    When > 0, lock duration is ``min(retry_after_ms, cap_ms)`` with retry from
    ``retry_after_seconds``, ``Retry-After`` header, or 60s default.
    """
    if (os.getenv("OLLAMA_CLOUD_DISABLE_KEY_CACHE_FOR_TRANSIENT_429") or "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        return None
    raw = (os.getenv("OLLAMA_CLOUD_TRANSIENT_429_KEY_CACHE_MS") or "0").strip()
    if not raw.isdigit() or int(raw) <= 0:
        return None
    cap_ms = int(raw)
    sec = retry_after_seconds if retry_after_seconds and retry_after_seconds > 0 else None
    if sec is None:
        sec = _retry_after_seconds_from_headers(response_headers)
    if sec is None:
        sec = 60
    sec = max(1, min(int(sec), 86400))
    return min(sec * 1000, cap_ms)


def headers_from_litellm_response(response: Any) -> Dict[str, str]:
    """Best-effort response headers from a LiteLLM ModelResponse."""
    if response is None:
        return {}
    hp = getattr(response, "_hidden_params", None)
    if isinstance(hp, dict):
        rh = hp.get("response_headers") or hp.get("headers")
        if isinstance(rh, dict):
            return {str(k).lower(): str(v) for k, v in rh.items()}
    raw = getattr(response, "_response_ms", None)
    if raw is not None and hasattr(raw, "headers"):
        try:
            return {k.lower(): v for k, v in raw.headers.items()}
        except Exception:
            pass
    return {}


def headers_from_exception(exc: Any) -> Dict[str, str]:
    if exc is None:
        return {}
    resp = getattr(exc, "response", None)
    if resp is not None and hasattr(resp, "headers"):
        try:
            return {k.lower(): str(v) for k, v in resp.headers.items()}
        except Exception:
            pass
    return {}


@dataclass
class KeyQuotaCounters:
    session: int = 0
    weekly: int = 0
    session_activity_at: Optional[int] = None
    weekly_activity_at: Optional[int] = None
    ollama_session_reset_at: Optional[int] = None


@dataclass
class DocumindOllamaPolicyState:
    avg_session_at_hit: Optional[float] = None
    session_sample_count: int = 0
    avg_weekly_at_hit: Optional[float] = None
    weekly_sample_count: int = 0
    keys: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    tracked_keys: Dict[str, bool] = field(default_factory=dict)
    key_cache: Dict[str, Dict[str, Any]] = field(default_factory=dict)


class DocumindOllamaPolicy:
    """
    Persists documind_ollama_policy.json (locks + quota counters + rolling averages).
    Credential indices match the ordered ollama_cloud API key list on the proxy.
    """

    def __init__(self, file_path: Optional[Path] = None):
        self._path = Path(file_path) if file_path else Path(get_data_file("documind_ollama_policy.json"))
        self._state = self._load()

    def _default_tracked(self) -> Dict[str, bool]:
        return {str(i): True for i in range(OLLAMA_QUOTA_KEY_COUNT)}

    def _load(self) -> DocumindOllamaPolicyState:
        raw: Dict[str, Any] = {}
        try:
            if self._path.is_file():
                raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception as e:
            _log.warning("Could not load %s: %s", self._path, e)
        tk = raw.get("trackedKeys") or raw.get("tracked_keys") or {}
        tracked = self._default_tracked()
        if isinstance(tk, dict):
            for i in range(OLLAMA_QUOTA_KEY_COUNT):
                k = str(i)
                if isinstance(tk.get(k), bool):
                    tracked[k] = tk[k]
        keys_in: Dict[str, Dict[str, Any]] = {}
        if isinstance(raw.get("keys"), dict):
            keys_in = {str(k): dict(v) for k, v in raw["keys"].items()}
        kc: Dict[str, Dict[str, Any]] = {}
        if isinstance(raw.get("keyCache"), dict):
            kc = {str(k): dict(v) for k, v in raw["keyCache"].items()}
        elif isinstance(raw.get("key_cache"), dict):
            kc = {str(k): dict(v) for k, v in raw["key_cache"].items()}
        return DocumindOllamaPolicyState(
            avg_session_at_hit=raw.get("avgSessionAtHit"),
            session_sample_count=int(raw.get("sessionSampleCount") or 0),
            avg_weekly_at_hit=raw.get("avgWeeklyAtHit"),
            weekly_sample_count=int(raw.get("weeklySampleCount") or 0),
            keys=keys_in,
            tracked_keys=tracked,
            key_cache=kc,
        )

    def _persist(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "avgSessionAtHit": self._state.avg_session_at_hit,
                "sessionSampleCount": self._state.session_sample_count,
                "avgWeeklyAtHit": self._state.avg_weekly_at_hit,
                "weeklySampleCount": self._state.weekly_sample_count,
                "keys": self._state.keys,
                "trackedKeys": self._state.tracked_keys,
                "keyCache": self._state.key_cache,
            }
            self._path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except Exception as e:
            _log.error("Failed to persist documind policy: %s", e)

    def import_legacy_files(
        self,
        keys_cache_path: Optional[Path],
        quota_path: Optional[Path],
    ) -> None:
        """One-time merge from Documind client JSON files if present."""
        changed = False
        if keys_cache_path and keys_cache_path.is_file():
            try:
                data = json.loads(keys_cache_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    for k, v in data.items():
                        if isinstance(v, dict) and "exhausted" in v and "expiresAt" in v:
                            self._state.key_cache[str(k)] = {
                                "exhausted": v["exhausted"],
                                "expiresAt": int(v["expiresAt"]),
                            }
                            changed = True
            except Exception as e:
                _log.debug("Legacy key cache import skipped: %s", e)
        if quota_path and quota_path.is_file():
            try:
                q = json.loads(quota_path.read_text(encoding="utf-8"))
                if isinstance(q, dict):
                    if "keys" in q and isinstance(q["keys"], dict):
                        self._state.keys.update(
                            {str(k): dict(v) for k, v in q["keys"].items()}
                        )
                        changed = True
                    if "avgSessionAtHit" in q:
                        self._state.avg_session_at_hit = q["avgSessionAtHit"]
                        changed = True
                    if "sessionSampleCount" in q:
                        self._state.session_sample_count = int(q["sessionSampleCount"])
                        changed = True
                    if "avgWeeklyAtHit" in q:
                        self._state.avg_weekly_at_hit = q["avgWeeklyAtHit"]
                        changed = True
                    if "weeklySampleCount" in q:
                        self._state.weekly_sample_count = int(q["weeklySampleCount"])
                        changed = True
                    if "trackedKeys" in q and isinstance(q["trackedKeys"], dict):
                        for i in range(OLLAMA_QUOTA_KEY_COUNT):
                            k = str(i)
                            if isinstance(q["trackedKeys"].get(k), bool):
                                self._state.tracked_keys[k] = q["trackedKeys"][k]
                        changed = True
            except Exception as e:
                _log.debug("Legacy quota import skipped: %s", e)
        if changed:
            self._persist()

    def set_tracked_keys(self, mask: List[bool]) -> None:
        if len(mask) != OLLAMA_QUOTA_KEY_COUNT:
            raise ValueError(f"trackedKeys must have length {OLLAMA_QUOTA_KEY_COUNT}")
        for i, b in enumerate(mask):
            self._state.tracked_keys[str(i)] = bool(b)
        self._persist()

    def clear_key_cache(self) -> None:
        self._state.key_cache = {}
        self._persist()

    def is_index_locked(self, index: int, now_ms: Optional[int] = None) -> bool:
        now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
        rec = self._state.key_cache.get(str(index))
        if not rec:
            return False
        exp = int(rec.get("expiresAt") or 0)
        return exp > now_ms

    def _ensure_key_row(self, k: str, now_ms: int) -> Dict[str, Any]:
        if k not in self._state.keys:
            self._state.keys[k] = {
                "session": 0,
                "weekly": 0,
                "sessionActivityAt": now_ms,
                "weeklyActivityAt": now_ms,
            }
        return self._state.keys[k]

    def _reconcile_row(self, row: Dict[str, Any], now_ms: int) -> bool:
        dirty = False
        sat = row.get("sessionActivityAt")
        wat = row.get("weeklyActivityAt")
        if sat is None or sat <= 0:
            row["sessionActivityAt"] = now_ms
            dirty = True
        if wat is None or wat <= 0:
            row["weeklyActivityAt"] = now_ms
            dirty = True
        ora = row.get("ollamaSessionResetAt")
        if ora is not None and ora <= now_ms:
            if row.get("session", 0) != 0:
                dirty = True
            row["session"] = 0
            row["sessionActivityAt"] = now_ms
            row.pop("ollamaSessionResetAt", None)
            dirty = True
        has_future = row.get("ollamaSessionResetAt") is not None and row.get(
            "ollamaSessionResetAt"
        ) > now_ms
        if (
            not has_future
            and now_ms - int(row["sessionActivityAt"]) > OLLAMA_SESSION_QUOTA_WINDOW_MS
        ):
            if row.get("session", 0) != 0:
                dirty = True
            row["session"] = 0
            row["sessionActivityAt"] = now_ms
            dirty = True
        if now_ms - int(row["weeklyActivityAt"]) > OLLAMA_WEEKLY_QUOTA_WINDOW_MS:
            if row.get("weekly", 0) != 0:
                dirty = True
            row["weekly"] = 0
            row["weeklyActivityAt"] = now_ms
            dirty = True
        return dirty

    def _reconcile_all(self, now_ms: int) -> None:
        any_d = False
        for k in list(self._state.keys.keys()):
            if self._reconcile_row(self._state.keys[k], now_ms):
                any_d = True
        if any_d:
            self._persist()

    @staticmethod
    def _rolling_avg(avg: Optional[float], n: int, value: float) -> float:
        if avg is None:
            return value
        return (avg * n + value) / (n + 1)

    def on_upstream_success(
        self,
        cred_index: int,
        response_headers: Dict[str, str],
        document_complete: bool,
    ) -> None:
        now_ms = int(time.time() * 1000)
        self._reconcile_all(now_ms)
        ks = str(cred_index)
        row = self._ensure_key_row(ks, now_ms)
        self._reconcile_row(row, now_ms)
        reset_at = parse_ollama_session_reset_at_ms(response_headers, now_ms)
        if reset_at is not None and reset_at > now_ms:
            row["ollamaSessionResetAt"] = reset_at
        if document_complete:
            row["session"] = int(row.get("session", 0)) + 1
            row["weekly"] = int(row.get("weekly", 0)) + 1
            row["sessionActivityAt"] = now_ms
            row["weeklyActivityAt"] = now_ms
        self._persist()

    def on_upstream_429(
        self,
        cred_index: int,
        error_message: str,
        response_headers: Dict[str, str],
        *,
        retry_after_seconds: Optional[int] = None,
        error_type: Optional[str] = None,
    ) -> None:
        now_ms = int(time.time() * 1000)
        self._reconcile_all(now_ms)
        ks = str(cred_index)
        row = self._ensure_key_row(ks, now_ms)
        self._reconcile_row(row, now_ms)

        msg_l = (error_message or "").lower()
        is_weekly = "weekly" in msg_l
        dedicated_reset = parse_dedicated_ollama_quota_reset_at_ms(
            response_headers, now_ms
        )
        is_quota_like = (
            error_type == "quota_exceeded"
            or is_weekly
            or (
                dedicated_reset is not None and dedicated_reset > now_ms + 1000
            )
        )

        if not is_quota_like:
            ttl = transient_429_key_cache_duration_ms(
                retry_after_seconds, response_headers
            )
            if ttl is not None and ttl > 0:
                self._state.key_cache[ks] = {
                    "exhausted": "transient",
                    "expiresAt": now_ms + ttl,
                }
                self._persist()
            return

        tracked = self._state.tracked_keys.get(ks, True) is not False
        if not is_weekly:
            sess = int(row.get("session", 0))
            if tracked and sess > 0:
                self._state.avg_session_at_hit = self._rolling_avg(
                    self._state.avg_session_at_hit,
                    self._state.session_sample_count,
                    float(sess),
                )
                self._state.session_sample_count += 1
            row["session"] = 0
            row["sessionActivityAt"] = now_ms
        else:
            wk = int(row.get("weekly", 0))
            if tracked and wk > 0:
                self._state.avg_weekly_at_hit = self._rolling_avg(
                    self._state.avg_weekly_at_hit,
                    self._state.weekly_sample_count,
                    float(wk),
                )
                self._state.weekly_sample_count += 1
            row["weekly"] = 0
            row["session"] = 0
            row["sessionActivityAt"] = now_ms
            row["weeklyActivityAt"] = now_ms

        if not is_weekly:
            if dedicated_reset is not None and dedicated_reset > now_ms:
                row["ollamaSessionResetAt"] = dedicated_reset

        if is_weekly:
            expires_at = now_ms + OLLAMA_WEEKLY_QUOTA_WINDOW_MS
            exhausted = "weekly"
        elif dedicated_reset is not None and dedicated_reset > now_ms + 1000:
            expires_at = dedicated_reset
            exhausted = "session"
        else:
            fb = min(_session_lock_fallback_ms(), OLLAMA_SESSION_QUOTA_WINDOW_MS)
            expires_at = now_ms + fb
            exhausted = "session"

        self._state.key_cache[ks] = {
            "exhausted": exhausted,
            "expiresAt": expires_at,
        }
        self._persist()

    def all_indices_exhausted(self, n_credentials: int, now_ms: Optional[int] = None) -> bool:
        now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
        if n_credentials <= 0:
            return False
        for i in range(min(n_credentials, OLLAMA_QUOTA_KEY_COUNT)):
            if not self.is_index_locked(i, now_ms):
                return False
        return True

    def snapshot_gui(self, use_cloud_ref: bool = True) -> Dict[str, Any]:
        now_ms = int(time.time() * 1000)
        self._reconcile_all(now_ms)
        ref_weekly = (
            OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF
            / OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS
        )
        avg_s = self._state.avg_session_at_hit
        avg_w = self._state.avg_weekly_at_hit
        if use_cloud_ref:
            if avg_s is None:
                avg_s = float(OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL)
            if avg_w is None:
                avg_w = float(ref_weekly)
        return {
            "avgSessionAtHit": avg_s,
            "sessionSampleCount": self._state.session_sample_count,
            "avgWeeklyAtHit": avg_w,
            "weeklySampleCount": self._state.weekly_sample_count,
            "keys": {k: dict(v) for k, v in self._state.keys.items()},
            "trackedKeys": dict(self._state.tracked_keys),
        }

    def key_cache_snapshot(self) -> Dict[str, Any]:
        return {k: dict(v) for k, v in self._state.key_cache.items()}


def collect_ollama_cloud_keys_ordered(environ: Optional[Dict[str, str]] = None) -> List[str]:
    """
    Same ordering as Documind getOllamaApiKeys for cloud slots:
    primary OLLAMA_CLOUD_API_KEY, then OLLAMA_CLOUD_API_KEYS CSV, else OLLAMA_CLOUD_API_KEY_2..18.
    """
    env = environ if environ is not None else os.environ
    keys: List[str] = []
    primary = (env.get("OLLAMA_CLOUD_API_KEY") or "").strip()
    if primary:
        keys.append(primary)
    from_list = env.get("OLLAMA_CLOUD_API_KEYS") or ""
    if from_list.strip():
        for p in from_list.split(","):
            t = p.strip()
            if t and t not in keys:
                keys.append(t)
    elif len(keys) <= 1:
        for i in range(2, 19):
            extra = (env.get(f"OLLAMA_CLOUD_API_KEY_{i}") or "").strip()
            if extra:
                keys.append(extra)
    return keys[:OLLAMA_QUOTA_KEY_COUNT]


def build_cred_index_maps(
    ordered_keys: List[str],
) -> Tuple[Dict[str, int], List[str]]:
    """Map API key string -> stable index; list preserves order."""
    m: Dict[str, int] = {}
    for i, k in enumerate(ordered_keys):
        m[k] = i
    return m, list(ordered_keys)


def order_credentials_documind(
    credentials: List[str],
    cred_to_index: Dict[str, int],
    policy: DocumindOllamaPolicy,
    preferred_index: Optional[int],
    deprioritize_key_indices: Optional[Set[int]],
    last_success_index: Optional[int],
) -> List[str]:
    """Filter Documind-locked creds; deprioritize indices in ``deprioritize_key_indices`` (busy workers)."""
    import random

    now_ms = int(time.time() * 1000)
    filtered: List[str] = []
    for c in credentials:
        idx = cred_to_index.get(c)
        if idx is None:
            continue
        if policy.is_index_locked(idx, now_ms):
            continue
        filtered.append(c)

    if not filtered:
        return []

    def cred_idx(c: str) -> int:
        return cred_to_index[c]

    busy = deprioritize_key_indices or set()

    if preferred_index is not None and preferred_index >= 0:
        pref_cred = next((c for c in filtered if cred_idx(c) == preferred_index), None)
        if pref_cred:
            rest = [c for c in filtered if c != pref_cred]
            rest_free = [c for c in rest if cred_idx(c) not in busy]
            rest_busy = [c for c in rest if cred_idx(c) in busy]
            random.shuffle(rest_free)
            random.shuffle(rest_busy)
            return [pref_cred, *rest_free, *rest_busy]

    if busy:
        not_busy = [c for c in filtered if cred_idx(c) not in busy]
        in_busy = [c for c in filtered if cred_idx(c) in busy]
        random.shuffle(not_busy)
        random.shuffle(in_busy)
        return not_busy + in_busy

    if last_success_index is not None:
        ls = next((c for c in filtered if cred_idx(c) == last_success_index), None)
        if ls:
            others = [c for c in filtered if c != ls]
            return [ls, *others]

    out = list(filtered)
    random.shuffle(out)
    return out


def parse_documind_request_headers(headers: Any) -> Tuple[Optional[int], Optional[Set[int]], bool]:
    """Returns (preferred_key_index, deprioritize_key_indices, document_complete)."""
    if headers is None:
        return None, None, False

    def get(name: str) -> Optional[str]:
        if hasattr(headers, "get"):
            v = headers.get(name)
            if v is None:
                v = headers.get(name.lower())
            return str(v) if v is not None else None
        return None

    pref_raw = get("x-documind-preferred-key-index")
    pref: Optional[int] = None
    if pref_raw is not None and pref_raw.strip().isdigit():
        pref = int(pref_raw.strip())

    keys_raw = get("x-documind-keys-in-use")
    keys_set: Optional[Set[int]] = None
    if keys_raw:
        keys_set = set()
        for part in keys_raw.split(","):
            p = part.strip()
            if p.isdigit():
                keys_set.add(int(p))
        if not keys_set:
            keys_set = None

    dc_raw = (get("x-documind-document-complete") or "").strip().lower()
    document_complete = dc_raw in ("1", "true", "yes")
    return pref, keys_set, document_complete


def ollama_cloud_extra_headers_for_index(index: int) -> Dict[str, str]:
    """Optional per-index User-Agent / Accept-Language from server env."""
    out: Dict[str, str] = {}
    ua = (os.getenv(f"OLLAMA_CLOUD_USER_AGENT_{index}") or "").strip()
    if ua:
        out["User-Agent"] = ua
    al = (os.getenv(f"OLLAMA_CLOUD_ACCEPT_LANGUAGE_{index}") or "").strip()
    if not al:
        al = ACCEPT_LANG_VARIANTS[index % len(ACCEPT_LANG_VARIANTS)]
    out["Accept-Language"] = al
    return out
