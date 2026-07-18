"""Optional browser-use sidecar. Reads one JSON task from stdin and writes JSON."""

import asyncio
import json
import os
import re
import sys
import tempfile
from urllib.parse import parse_qsl, urlsplit, urlunsplit


URL_PATTERN = re.compile(r"https?://[^\s<>'\"]+", re.I)
SENSITIVE_QUERY_NAME = re.compile(
    r"(?:^|[_-])(?:api[_-]?key|auth|authorization|code|credential|jwt|pass(?:word)?|secret|session|sig(?:nature)?|token)(?:$|[_-])",
    re.I,
)


async def main() -> None:
    request = json.loads(sys.stdin.readline())
    task = str(request.get("task", "")).strip()
    if not task:
        raise ValueError("task is required")
    if len(task) > 12_000:
        raise ValueError("task exceeds 12,000 characters")
    validate_task_urls(task)

    max_steps = min(100, max(1, int(request.get("max_steps", 60))))
    max_failures = min(10, max(1, int(request.get("max_failures", 3))))
    max_history_items = min(100, max(1, int(request.get("max_history_items", 20))))
    raw_domains = request.get("allowed_domains", [])
    if not isinstance(raw_domains, list) or not raw_domains or len(raw_domains) > 100:
        raise ValueError("allowed_domains must contain 1-100 domains")
    domain_pattern = re.compile(r"^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", re.I)
    allowed_domains = [str(domain).strip().lower() for domain in raw_domains]
    if any(not domain_pattern.fullmatch(domain) for domain in allowed_domains):
        raise ValueError("allowed_domains contains an invalid domain")

    from browser_use import Agent, BrowserProfile, BrowserSession, ChatBrowserUse, ChatOpenAI

    if os.getenv("BROWSER_USE_API_KEY"):
        llm = ChatBrowserUse()
    elif os.getenv("OPENAI_API_KEY"):
        llm = ChatOpenAI(model=os.getenv("SUPERAI_BROWSER_MODEL", "gpt-4.1-mini"))
    else:
        raise RuntimeError("Set BROWSER_USE_API_KEY or OPENAI_API_KEY for the browser-use sidecar")

    with tempfile.TemporaryDirectory(prefix="axiomux-browser-profile-", ignore_cleanup_errors=True) as profile_dir:
        with tempfile.TemporaryDirectory(prefix="axiomux-browser-downloads-", ignore_cleanup_errors=True) as downloads_dir:
            profile = BrowserProfile(
                headless=True,
                user_data_dir=profile_dir,
                downloads_path=downloads_dir,
                allowed_domains=allowed_domains,
                block_ip_addresses=True,
                keep_alive=False,
                chromium_sandbox=True,
                enable_default_extensions=False,
            )
            browser = BrowserSession(browser_profile=profile)
            agent = Agent(
                task=task,
                llm=llm,
                browser_session=browser,
                use_vision="auto",
                max_failures=max_failures,
                max_history_items=max_history_items,
                calculate_cost=True,
            )
            try:
                history = await agent.run(max_steps=max_steps)
                urls = [safe_url(url) for url in history.urls() if safe_url(url)]
                print(
                    json.dumps(
                        {
                            "success": history.is_successful(),
                            "done": history.is_done(),
                            "result": sanitize_text(history.final_result()),
                            "urls": urls,
                            "actions": history.action_names(),
                            "errors": [sanitize_text(str(error))[:500] for error in history.errors() if error],
                            "steps": history.number_of_steps(),
                            "duration_seconds": history.total_duration_seconds(),
                            "downloads_discarded": True,
                            "profile_persisted": False,
                        },
                        ensure_ascii=False,
                    )
                )
            finally:
                await browser.stop()


def safe_url(value: object) -> str:
    try:
        parsed = urlsplit(str(value))
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return ""
        host = parsed.hostname
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        netloc = f"{host}:{parsed.port}" if parsed.port else host
        # Never echo URL userinfo, query parameters or fragments into the tool
        # result; all three commonly contain credentials or session state.
        return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))[:2000]
    except ValueError:
        return ""


def validate_task_urls(task: str) -> None:
    for match in URL_PATTERN.finditer(task):
        candidate = match.group(0).rstrip(".,);]}")
        try:
            parsed = urlsplit(candidate)
        except ValueError as exc:
            raise ValueError("task contains an invalid HTTP(S) URL") from exc
        if parsed.username or parsed.password:
            raise ValueError("task URLs must not contain embedded credentials")
        if any(SENSITIVE_QUERY_NAME.search(name) for name, _value in parse_qsl(parsed.query, keep_blank_values=True)):
            raise ValueError("task URLs must not contain credential-like or signed query parameters")


def sanitize_text(value: object) -> str:
    text = str(value or "")
    return URL_PATTERN.sub(lambda match: safe_url(match.group(0).rstrip(".,);]}")), text)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise
