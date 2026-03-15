#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path
from urllib.request import Request, urlopen


RAW_BASE = "https://raw.githubusercontent.com/solovmm/fin_calc/main/data"
MACRO_URL = f"{RAW_BASE}/macro_monthly.json"
FX_URL = f"{RAW_BASE}/fx_daily.json"
INFL_ANNUAL_URL = f"{RAW_BASE}/inflation_ru_full_1991_2024.json"
ROSSTAT_CPI_URL = "https://github.com/solovmm/rosstat/raw/refs/heads/main/ipc_mes.xlsx"

EXPECTED_WORKFLOWS = {
    "Update daily FX",
    "Update monthly rates",
    "Update monthly CPI",
}

SEO_PAGES = [
    "index.html",
    "inflation_monthly.html",
    "inflation.html",
    "nds.html",
    "ndfl.html",
    "deposit_yield.html",
    "loan.html",
    "mortgage.html",
    "currency_converter.html",
    "macro.html",
    "calendar_2026.html",
    "randomizers.html",
]


def _curl_get(url, timeout=30):
    result = subprocess.run(
        [
            "curl",
            "-L",
            "-f",
            "--retry",
            "3",
            "--retry-delay",
            "1",
            "--max-time",
            str(timeout),
            "-s",
            url,
        ],
        check=True,
        capture_output=True,
    )
    return result.stdout


def _curl_head(url, timeout=30):
    result = subprocess.run(
        [
            "curl",
            "-I",
            "-L",
            "--retry",
            "3",
            "--retry-delay",
            "1",
            "--max-time",
            str(timeout),
            "-s",
            url,
        ],
        check=True,
        capture_output=True,
    )
    text = result.stdout.decode("utf-8", errors="ignore")
    status = None
    content_type = ""
    for line in text.splitlines():
        if line.startswith("HTTP/"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                status = int(parts[1])
        if line.lower().startswith("content-type:"):
            content_type = line.split(":", 1)[1].strip()
    return status or 0, content_type


def fetch_json(url, timeout=30):
    try:
        req = Request(url, headers={"User-Agent": "fin_calc-health-check"})
        with urlopen(req, timeout=timeout) as resp:
            data = resp.read()
    except Exception:
        data = _curl_get(url, timeout=timeout)
    return json.loads(data.decode("utf-8"))


def fetch_bytes(url, timeout=30):
    try:
        req = Request(url, headers={"User-Agent": "fin_calc-health-check"})
        with urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except Exception:
        return _curl_get(url, timeout=timeout)


def fetch_head(url, timeout=30):
    try:
        req = Request(url, method="HEAD", headers={"User-Agent": "fin_calc-health-check"})
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.headers.get("Content-Type", "")
    except Exception:
        return _curl_head(url, timeout=timeout)


def fetch_head_info(url, timeout=30):
    """HEAD request returning (status, content_type, content_length|None)."""
    try:
        req = Request(url, method="HEAD", headers={"User-Agent": "fin_calc-health-check"})
        with urlopen(req, timeout=timeout) as resp:
            clen = resp.headers.get("Content-Length")
            return resp.status, resp.headers.get("Content-Type", ""), int(clen) if clen and clen.isdigit() else None
    except Exception:
        # Fall back to curl and parse.
        result = subprocess.run(
            [
                "curl",
                "-I",
                "-L",
                "--retry",
                "2",
                "--retry-all-errors",
                "--retry-delay",
                "1",
                "--connect-timeout",
                "8",
                "--max-time",
                str(timeout),
                "-s",
                url,
            ],
            check=False,
            capture_output=True,
        )
        text = result.stdout.decode("utf-8", errors="ignore")
        status = None
        ctype = ""
        clen = None
        for line in text.splitlines():
            if line.startswith("HTTP/"):
                parts = line.split()
                if len(parts) >= 2 and parts[1].isdigit():
                    status = int(parts[1])
            if line.lower().startswith("content-type:"):
                ctype = line.split(":", 1)[1].strip()
            if line.lower().startswith("content-length:"):
                v = line.split(":", 1)[1].strip()
                if v.isdigit():
                    clen = int(v)
        return status or 0, ctype, clen


def parse_date(val):
    try:
        y, m, d = val.split("-")
        return date(int(y), int(m), int(d))
    except Exception:
        return None


def latest_month_row(payload):
    series = payload.get("series", []) if isinstance(payload, dict) else []
    rows = [row for row in series if row.get("month")]
    if not rows:
        return None
    return max(rows, key=lambda row: row.get("month", ""))


def check_remote_data(errors, warnings):
    status, ctype = fetch_head(ROSSTAT_CPI_URL)
    if status >= 400:
        errors.append(f"ROSSTAT CPI not reachable: HTTP {status}")
    if "application/vnd" not in ctype and "application/octet-stream" not in ctype and "application/zip" not in ctype:
        warnings.append(f"ROSSTAT CPI unexpected content-type: {ctype}")

    macro = fetch_json(MACRO_URL)
    series = macro.get("series", [])
    last_month = max((row.get("month") for row in series if row.get("month")), default=None)
    if not last_month:
        errors.append("macro_monthly.json has no last month")

    fx = fetch_json(FX_URL)
    fx_meta = fx.get("meta", {})
    fx_end = fx_meta.get("end")
    if not fx_end:
        errors.append("fx_daily.json missing meta.end")
    else:
        end_date = parse_date(fx_end)
        if end_date:
            delta = (date.today() - end_date).days
            if delta > 10:
                warnings.append(f"fx_daily meta.end is {delta} days behind today: {fx_end}")
        else:
            warnings.append(f"fx_daily meta.end has invalid date: {fx_end}")

    infl = fetch_json(INFL_ANNUAL_URL)
    if not infl:
        errors.append("inflation_ru_full_1991_2024.json empty or invalid")


def check_local_flags(errors, warnings, workspace_root, data_repo_root):
    rosstat_local = data_repo_root / "data" / "rosstat_ipc_mes.xlsx"
    if rosstat_local.exists():
        errors.append("Local data/rosstat_ipc_mes.xlsx exists (should not be in repo)")

    script_path = data_repo_root / "scripts" / "update_macro_monthly.py"
    if script_path.exists():
        content = script_path.read_text(encoding="utf-8")
        if ROSSTAT_CPI_URL not in content:
            errors.append("ROSSTAT_CPI_URL in update_macro_monthly.py is not the expected GitHub URL")
    else:
        warnings.append("update_macro_monthly.py not found in repo")

    if workspace_root is None:
        warnings.append("Full site workspace not found; skipping local UI/SEO checks")
        return

    assets_dir = workspace_root / "assets"
    if assets_dir.exists():
        conv = assets_dir / "currency_converter.js"
        if conv.exists():
            txt = conv.read_text(encoding="utf-8")
            if "./assets/fx_daily.json" not in txt:
                warnings.append("currency_converter.js does not use local ./assets/fx_daily.json as a same-origin source")

        for rel, needle in (
            ("macro.js", "./assets/macro_monthly.json"),
            ("inflation_monthly.js", "./assets/macro_monthly.json"),
        ):
            script = assets_dir / rel
            if not script.exists():
                continue
            txt = script.read_text(encoding="utf-8")
            if needle not in txt:
                warnings.append(f"{rel} does not reference same-origin {needle}")
    else:
        warnings.append("assets directory not found; skipping UI source scan")

    # Inline ES module imports in HTML must be versioned to avoid cache mixing.
    for rel in ("loan.html", "mortgage.html"):
        p = workspace_root / rel
        if not p.exists():
            continue
        txt = p.read_text(encoding="utf-8")
        if re.search(r'from\s+[\'"]\.?/assets/[a-zA-Z0-9_.-]+\.js[\'"]', txt):
            errors.append(f"{rel} contains unversioned module import (missing ?v=...)")

    # SEO sanity checks for static calculator pages.
    for rel in SEO_PAGES:
        p = workspace_root / rel
        if not p.exists():
            errors.append(f"SEO page missing: {rel}")
            continue
        txt = p.read_text(encoding="utf-8")
        if '<meta name="description"' not in txt:
            errors.append(f"{rel} missing meta description")
        if '<link rel="canonical"' not in txt:
            errors.append(f"{rel} missing canonical")
        expected_canonical = f'https://notboringeconomy.ru/fincalc/{rel}"'
        if expected_canonical not in txt:
            warnings.append(f"{rel} canonical differs from expected {expected_canonical[:-1]}")
        if txt.count('type="application/ld+json"') < 1:
            warnings.append(f"{rel} missing JSON-LD schema")
        if rel != "index.html" and "<h1>" not in txt:
            warnings.append(f"{rel} has no h1")
        if 'var canonicalHost = "www.notboringeconomy.ru"' in txt:
            errors.append(f"{rel} still redirects to www host (expected apex canonical)")

    sitemap = workspace_root / "fincalc-sitemap.xml"
    if not sitemap.exists():
        errors.append("fincalc-sitemap.xml missing")
    else:
        sm_txt = sitemap.read_text(encoding="utf-8")
        for rel in SEO_PAGES:
            if f"/fincalc/{rel}</loc>" not in sm_txt:
                errors.append(f"fincalc-sitemap.xml missing {rel}")

    local_macro = workspace_root / "assets" / "macro_monthly.json"
    if not local_macro.exists():
        errors.append("assets/macro_monthly.json missing")
    elif local_macro.stat().st_size < 10000:
        errors.append("assets/macro_monthly.json too small")

    local_fx = workspace_root / "assets" / "fx_daily.json"
    if not local_fx.exists():
        warnings.append("assets/fx_daily.json missing")
    elif local_fx.stat().st_size < 50_000:
        warnings.append("assets/fx_daily.json looks too small")


def check_actions(errors, warnings):
    repo = os.getenv("GITHUB_REPOSITORY", "solovmm/fin_calc")
    token = os.getenv("GITHUB_TOKEN")
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "fin_calc-health-check"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    workflows_url = f"https://api.github.com/repos/{repo}/actions/workflows"
    req = Request(workflows_url, headers=headers)
    with urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    workflows = data.get("workflows", [])
    names = {w.get("name") for w in workflows}
    missing = EXPECTED_WORKFLOWS - names
    if missing:
        errors.append(f"Missing workflows: {', '.join(sorted(missing))}")

    for w in workflows:
        name = w.get("name")
        if name not in EXPECTED_WORKFLOWS:
            continue
        wid = w.get("id")
        runs_url = f"https://api.github.com/repos/{repo}/actions/workflows/{wid}/runs?per_page=1"
        req = Request(runs_url, headers=headers)
        with urlopen(req, timeout=30) as resp:
            runs = json.loads(resp.read().decode("utf-8")).get("workflow_runs", [])
        if not runs:
            errors.append(f"No runs found for workflow {name}")
            continue
        run = runs[0]
        status = run.get("status")
        conclusion = run.get("conclusion")
        if status != "completed" or conclusion != "success":
            errors.append(f"Workflow {name} latest run not successful: {status}/{conclusion}")


def check_prod_site(errors, warnings, prod_base: str):
    base = prod_base.rstrip("/")
    # Use a throwaway query param to avoid overly aggressive proxy caches.
    v = "healthcheck"
    # Nginx/WordPress stacks can have intermittent latency spikes; keep this generous
    # enough to avoid false negatives while still catching real outages.
    timeout = 25

    critical = [
        ("index.html", 5_000, None),
        ("ndfl.html", 5_000, None),
        ("nds.html", 3_000, None),
        ("loan.html", 5_000, None),
        ("mortgage.html", 5_000, None),
        ("calendar_2026.html", 3_000, None),
        ("macro.html", 3_000, None),
        ("inflation_monthly.html", 3_000, None),
        ("currency_converter.html", 3_000, None),
        ("deposit_yield.html", 5_000, None),
        ("ndfl_rules.json", 500, "application/json"),
        ("assets/common.js", 3_000, None),
        ("assets/ndfl.js", 10_000, None),
        ("assets/nds.js", 2_000, None),
        ("assets/deposit_yield.js", 10_000, None),
        ("assets/calendar_2026.js", 1_000, None),
        ("assets/macro.js", 5_000, None),
        ("assets/macro_monthly.json", 10_000, "application/json"),
        ("assets/inflation_monthly.js", 5_000, None),
        ("assets/currency_converter.js", 5_000, None),
        ("assets/fx_daily.json", 50_000, "application/json"),
        ("assets/style.css", 5_000, None),
        ("assets/tabs.js", 1_000, None),
        ("assets/production_calendar_2026_v2.json", 10_000, "application/json"),
        ("fincalc-sitemap.xml", 400, "xml"),
    ]

    for rel, min_len, expected_ctype in critical:
        url = f"{base}/{rel}?v={v}"
        status, ctype, clen = fetch_head_info(url, timeout=timeout)
        if status <= 0:
            # Some stacks (or intermediate proxies) can be flaky with HEAD while GET works.
            # Prefer verifying availability via a lightweight GET rather than failing deploy.
            try:
                data = fetch_bytes(url, timeout=timeout)
                if len(data) < min_len:
                    errors.append(f"PROD file too small: {rel} ({len(data)} bytes)")
                else:
                    warnings.append(f"PROD HEAD failed for {rel}, but GET succeeded ({len(data)} bytes)")
                continue
            except Exception:
                errors.append(f"PROD head failed: {rel}")
                continue
        if status >= 400:
            errors.append(f"PROD missing/unreachable: {rel} (HTTP {status})")
            continue
        if expected_ctype and expected_ctype not in (ctype or ""):
            warnings.append(f"PROD unexpected content-type for {rel}: {ctype}")

        if clen is not None and clen < min_len:
            errors.append(f"PROD file too small: {rel} ({clen} bytes)")
        elif clen is None:
            # Some servers don't return Content-Length for compressed responses.
            # Do a lightweight GET as a fallback.
            try:
                data = fetch_bytes(url, timeout=timeout)
                if len(data) < min_len:
                    errors.append(f"PROD file too small: {rel} ({len(data)} bytes)")
            except Exception as exc:
                errors.append(f"PROD fetch failed for {rel}: {exc}")

    # Extra heuristics for common deploy breakages.
    try:
        ndfl_js = fetch_bytes(f"{base}/assets/ndfl.js?v={v}", timeout=timeout).decode("utf-8", errors="ignore")
        if "import.meta.url" in ndfl_js:
            warnings.append("PROD ndfl.js contains import.meta.url (can break some Safari versions)")
        if "window.location.href" not in ndfl_js:
            warnings.append("PROD ndfl.js does not reference window.location.href (check rules URL resolver)")
    except Exception:
        pass

    try:
        dep_js = fetch_bytes(f"{base}/assets/deposit_yield.js?v={v}", timeout=timeout).decode("utf-8", errors="ignore")
        if "import.meta.url" in dep_js:
            warnings.append("PROD deposit_yield.js contains import.meta.url (can break some Safari versions)")
    except Exception:
        pass

    # UI smoke without a browser: verify versioned asset links in key HTML pages.
    def _check_html(rel: str) -> None:
        try:
            html = fetch_bytes(f"{base}/{rel}?v={v}", timeout=timeout).decode("utf-8", errors="ignore")
        except Exception as exc:
            errors.append(f"PROD fetch failed for {rel}: {exc}")
            return

        if "assets/style.css?v=" not in html:
            errors.append(f"PROD {rel} missing versioned style.css link")

        # Inline ES module imports must be versioned too, otherwise browsers can mix old/new.
        if re.search(r'from\s+[\'"]\.?/assets/[a-zA-Z0-9_.-]+\.js[\'"]', html):
            errors.append(f"PROD {rel} has unversioned module import (missing ?v=...)")

    for rel in SEO_PAGES:
        _check_html(rel)

    # Basic production SEO checks (meta + canonical + JSON-LD).
    for rel in SEO_PAGES:
        try:
            html = fetch_bytes(f"{base}/{rel}?v={v}", timeout=timeout).decode("utf-8", errors="ignore")
        except Exception as exc:
            errors.append(f"PROD fetch failed for {rel}: {exc}")
            continue
        if '<meta name="description"' not in html:
            warnings.append(f"PROD {rel} missing meta description")
        if '<link rel="canonical"' not in html:
            warnings.append(f"PROD {rel} missing canonical")
        if 'application/ld+json' not in html:
            warnings.append(f"PROD {rel} missing JSON-LD")

    try:
        remote_macro = fetch_json(MACRO_URL)
        prod_macro = fetch_json(f"{base}/assets/macro_monthly.json?v={v}")
        remote_last = latest_month_row(remote_macro)
        prod_last = latest_month_row(prod_macro)
        if not remote_last or not prod_last:
            errors.append("PROD macro_monthly.json cannot determine latest month row")
        else:
            remote_month = remote_last.get("month")
            prod_month = prod_last.get("month")
            if remote_month != prod_month:
                errors.append(f"PROD macro_monthly latest month mismatch: prod={prod_month}, repo={remote_month}")
            compare_keys = ("cpi_mom", "cpi_yoy", "cpi_ytd", "key_rate", "rate_usd")
            mismatched = [key for key in compare_keys if prod_last.get(key) != remote_last.get(key)]
            if mismatched:
                errors.append(
                    "PROD macro_monthly.json latest row differs from repo for "
                    f"{remote_month}: {', '.join(mismatched)}"
                )
    except Exception as exc:
        errors.append(f"PROD macro_monthly freshness check failed: {exc}")


def main():
    parser = argparse.ArgumentParser(description="Health check for fin_calc data sources and workflows")
    parser.add_argument("--skip-actions", action="store_true", help="Skip GitHub Actions checks")
    parser.add_argument("--skip-remote", action="store_true", help="Skip remote data URL checks")
    parser.add_argument("--skip-parity", action="store_true", help="Skip local formula parity cases")
    parser.add_argument("--prod-base", default="", help="Optional: check production site base URL (e.g. https://notboringeconomy.ru/fincalc)")
    args = parser.parse_args()

    errors = []
    warnings = []
    data_repo_root = Path(__file__).resolve().parent.parent
    candidate_workspace_root = data_repo_root.parent
    workspace_root = candidate_workspace_root if (candidate_workspace_root / "assets").exists() else None

    try:
        if not args.skip_remote:
            check_remote_data(errors, warnings)
    except Exception as exc:
        if os.getenv("GITHUB_ACTIONS", "").lower() == "true":
            errors.append(f"Remote data check failed: {exc}")
        else:
            warnings.append(f"Remote data check failed (non-CI): {exc}")

    try:
        check_local_flags(errors, warnings, workspace_root, data_repo_root)
    except Exception as exc:
        errors.append(f"Local checks failed: {exc}")

    if not args.skip_parity:
        try:
            # Run deterministic formula cases (NDFL/NDS/inflation). This catches
            # rule regressions before deploy.
            parity = data_repo_root / "scripts" / "parity_cases.py"
            if parity.exists():
                subprocess.run([sys.executable, str(parity)], check=True, capture_output=True, text=True)
            else:
                warnings.append("parity_cases.py not found; skipping parity checks")
        except subprocess.CalledProcessError as exc:
            out = (exc.stdout or "") + (exc.stderr or "")
            errors.append("Parity cases failed:\n" + out.strip())
        except Exception as exc:
            errors.append(f"Parity cases failed: {exc}")

    if args.prod_base:
        try:
            check_prod_site(errors, warnings, args.prod_base)
        except Exception as exc:
            errors.append(f"Prod site check failed: {exc}")

    if not args.skip_actions:
        try:
            check_actions(errors, warnings)
        except Exception as exc:
            errors.append(f"Actions check failed: {exc}")

    if warnings:
        print("WARNINGS:")
        for w in warnings:
            print(" - " + w)
    if errors:
        print("ERRORS:")
        for e in errors:
            print(" - " + e)
        sys.exit(1)
    print("OK: health check passed.")


if __name__ == "__main__":
    main()
