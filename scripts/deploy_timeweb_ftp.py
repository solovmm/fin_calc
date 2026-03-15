#!/usr/bin/env python3
"""
Deploy static fincalc files to Timeweb via FTP (binary mode).

Why this exists:
- Timeweb serves JS/JSON with very long cache headers; if you upload only some files,
  it's easy to end up with mismatched HTML/JS on production.
- FTP must upload in binary mode, otherwise JSON/JS may get corrupted/zeroed.

This script uploads either:
  - full site (default): top-level *.html/*.json/*.xml and everything under assets/
  - minimal set (--mode minimal): only files typically changed during quick fixes

It prompts for the password (does not store it).
"""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import shutil
from dataclasses import dataclass
from ftplib import FTP, error_perm
from getpass import getpass
from pathlib import Path
from typing import Iterable, Iterator, List, Tuple


SITE_TOPLEVEL_SUFFIXES = {".html", ".json", ".xml"}
EXCLUDE_NAMES = {".DS_Store"}


@dataclass(frozen=True)
class UploadItem:
    rel: Path
    abs_path: Path


def _data_repo_root() -> Path:
    # GitHub repo root for the data repository: data_repo/scripts/... -> parents[1]
    return Path(__file__).resolve().parents[1]


def _site_root() -> Path:
    data_repo_root = _data_repo_root()
    candidate = data_repo_root.parent
    if (candidate / "assets").exists() and (candidate / "data_repo").exists():
        return candidate
    return data_repo_root


def _sync_runtime_assets(site_root: Path, data_repo_root: Path) -> None:
    pairs = [
        (data_repo_root / "data" / "macro_monthly.json", site_root / "assets" / "macro_monthly.json"),
        (data_repo_root / "data" / "fx_daily.json", site_root / "assets" / "fx_daily.json"),
        (data_repo_root / "data" / "inflation_ru_full_1991_2024.json", site_root / "inflation_ru_full_1991_2024.json"),
    ]
    for src, dst in pairs:
        if src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


def _iter_full_site(local_root: Path) -> Iterator[UploadItem]:
    assets_dir = local_root / "assets"

    # assets/*
    if assets_dir.exists():
        # Upload assets first. If a deploy fails part-way through, it's safer for
        # old HTML to keep working than to push new HTML that references new JS.
        for p in sorted(assets_dir.rglob("*")):
            if p.is_dir():
                continue
            if p.name in EXCLUDE_NAMES:
                continue
            rel = p.relative_to(local_root)
            yield UploadItem(rel=rel, abs_path=p)

    # Top-level files (HTML/JSON/XML) last.
    for p in sorted(local_root.iterdir()):
        if p.is_dir():
            continue
        if p.name in EXCLUDE_NAMES:
            continue
        if p.suffix.lower() in SITE_TOPLEVEL_SUFFIXES:
            yield UploadItem(rel=Path(p.name), abs_path=p)


def _minimal_items(local_root: Path) -> List[UploadItem]:
    rels = [
        Path("ndfl.html"),
        Path("deposit_yield.html"),
        Path("ndfl_rules.json"),
        Path("assets/ndfl.js"),
        Path("assets/deposit_yield.js"),
        Path("assets/tabs.js"),
    ]
    items: List[UploadItem] = []
    for rel in rels:
        p = local_root / rel
        if not p.exists():
            raise FileNotFoundError(f"Missing required file for minimal deploy: {p}")
        items.append(UploadItem(rel=rel, abs_path=p))
    return items


def _data_items(data_repo_root: Path) -> List[UploadItem]:
    mapping = [
        (Path("assets/macro_monthly.json"), data_repo_root / "data" / "macro_monthly.json"),
        (Path("assets/fx_daily.json"), data_repo_root / "data" / "fx_daily.json"),
        (Path("inflation_ru_full_1991_2024.json"), data_repo_root / "data" / "inflation_ru_full_1991_2024.json"),
    ]
    items: List[UploadItem] = []
    for rel, p in mapping:
        if not p.exists():
            raise FileNotFoundError(f"Missing required file for data deploy: {p}")
        items.append(UploadItem(rel=rel, abs_path=p))
    return items


def _ensure_remote_dir(ftp: FTP, rel_dir: str) -> None:
    rel_dir = rel_dir.strip("/")
    if not rel_dir:
        return
    parts = [p for p in rel_dir.split("/") if p]
    cur = ""
    for p in parts:
        cur = f"{cur}/{p}" if cur else p
        try:
            ftp.mkd(cur)
        except error_perm:
            # Exists or no permission; ignore if it's "already exists".
            pass


def _upload_one(ftp: FTP, item: UploadItem, *, dry_run: bool) -> None:
    rel_posix = item.rel.as_posix()
    remote_dir = str(item.rel.parent).replace("\\", "/")
    if remote_dir != ".":
        _ensure_remote_dir(ftp, remote_dir)

    size = item.abs_path.stat().st_size
    if dry_run:
        print(f"DRY  {rel_posix} ({size} bytes)")
        return

    # Data connections (passive ports) can be flaky; retry a few times.
    last_exc: Exception | None = None
    for _attempt in range(1, 6):
        try:
            with item.abs_path.open("rb") as f:
                ftp.storbinary(f"STOR {rel_posix}", f)
            last_exc = None
            break
        except (TimeoutError, socket.timeout, OSError) as exc:
            last_exc = exc
            try:
                ftp.voidcmd("NOOP")
            except Exception:
                pass
    if last_exc is not None:
        raise last_exc

    # Best-effort verification via SIZE (may be unsupported for some servers/files)
    try:
        remote_size = ftp.size(rel_posix)
        if remote_size is not None and int(remote_size) != int(size):
            raise RuntimeError(f"Uploaded size mismatch for {rel_posix}: local={size} remote={remote_size}")
    except Exception:
        # Don't fail deploy on SIZE quirks, but still show that upload happened.
        pass

    print(f"OK   {rel_posix} ({size} bytes)")


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description="Deploy fincalc static files to Timeweb via FTP (binary).")
    parser.add_argument("--host", default="vh312.timeweb.ru", help="FTP host (default: vh312.timeweb.ru)")
    parser.add_argument("--port", type=int, default=21, help="FTP port (default: 21)")
    parser.add_argument("--user", required=True, help="FTP username")
    parser.add_argument(
        "--remote-root",
        default="/fincalc",
        help="Remote directory to deploy into (default: /fincalc)",
    )
    parser.add_argument(
        "--mode",
        choices=["full", "minimal", "data"],
        default="full",
        help="Deploy mode: full site (default), minimal subset, or runtime data only",
    )
    parser.add_argument("--dry-run", action="store_true", help="Only print what would be uploaded")
    parser.add_argument(
        "--no-bump-version",
        action="store_true",
        help="Do not update cache-busting ?v=... across HTML/JS before uploading (default: bump enabled).",
    )
    args = parser.parse_args(argv)

    data_repo_root = _data_repo_root()
    local_root = _site_root()
    _sync_runtime_assets(local_root, data_repo_root)

    # Timeweb serves static JS/CSS with very long cache headers.
    # Bump a shared ?v=... version across HTML and JS imports before uploading
    # to avoid HTML/JS mismatches on production.
    if args.mode != "data" and not args.dry_run and not args.no_bump_version:
        bump = local_root / "data_repo" / "scripts" / "bump_version.py"
        if not bump.exists():
            bump = data_repo_root / "scripts" / "bump_version.py"
        if bump.exists():
            subprocess.run([sys.executable, str(bump)], check=True)
        else:
            print(f"WARNING: bump_version.py not found at {bump}; continuing without bump.", file=sys.stderr)

    if args.mode != "data" and not args.dry_run:
        sitemap_gen = local_root / "data_repo" / "scripts" / "generate_fincalc_sitemap.py"
        if not sitemap_gen.exists():
            sitemap_gen = data_repo_root / "scripts" / "generate_fincalc_sitemap.py"
        if sitemap_gen.exists():
            subprocess.run([sys.executable, str(sitemap_gen)], check=True)
        else:
            print(f"WARNING: generate_fincalc_sitemap.py not found at {sitemap_gen}; continuing.", file=sys.stderr)

    if args.mode == "minimal":
        items = _minimal_items(local_root)
    elif args.mode == "data":
        items = _data_items(data_repo_root)
    else:
        items = list(_iter_full_site(local_root))

    if not items:
        print("Nothing to upload.", file=sys.stderr)
        return 2

    # Password: prefer env var for non-interactive runs (CI / tooling),
    # fall back to prompting to avoid leaking secrets on the command line.
    password = os.getenv("FTP_PASSWORD") or os.getenv("TIMEWEB_FTP_PASSWORD")
    if not password:
        password = getpass("FTP password: ")

    def _connect_and_cwd() -> FTP:
        # FTP greeting/data connections can be flaky/slow (reverse DNS, rate limits, etc.).
        # Retry a few times and keep PASV connections routable.
        ftp = FTP()
        last_exc: Exception | None = None
        for _attempt in range(1, 6):
            try:
                ftp.connect(args.host, args.port, timeout=90)
                ftp.login(args.user, password)
                last_exc = None
                break
            except error_perm:
                # Auth/permission errors won't get better with retries.
                raise
            except (TimeoutError, socket.timeout, OSError) as exc:
                last_exc = exc
                try:
                    ftp.close()
                except Exception:
                    pass
                ftp = FTP()

        if last_exc is not None:
            raise last_exc

        ftp.passiveserver = True

        # Some FTP servers behind NAT return an unroutable IP in the PASV response.
        # Force data connections to use the same host as the control connection.
        orig_makepasv = ftp.makepasv

        def _makepasv():
            _host, port = orig_makepasv()
            return args.host, port

        ftp.makepasv = _makepasv  # type: ignore[assignment]

        # Prefer absolute cwd; if it fails, try to create and retry.
        try:
            ftp.cwd(args.remote_root)
        except error_perm:
            # Create path step-by-step.
            parts = [p for p in args.remote_root.strip("/").split("/") if p]
            ftp.cwd("/")
            cur = ""
            for p in parts:
                cur = f"{cur}/{p}"
                try:
                    ftp.mkd(cur)
                except error_perm:
                    pass
            ftp.cwd(args.remote_root)

        return ftp

    ftp = _connect_and_cwd()
    try:
        for item in items:
            # If a passive port is flaky/unreachable, reconnect and retry the file.
            for _attempt in range(1, 4):
                try:
                    _upload_one(ftp, item, dry_run=args.dry_run)
                    break
                except error_perm:
                    raise
                except (TimeoutError, socket.timeout, OSError) as exc:
                    if _attempt >= 3:
                        raise exc
                    try:
                        ftp.quit()
                    except Exception:
                        try:
                            ftp.close()
                        except Exception:
                            pass
                    ftp = _connect_and_cwd()
    finally:
        try:
            ftp.quit()
        except Exception:
            pass

    if args.dry_run:
        print(f"DRY-RUN complete: {len(items)} files planned.")
    else:
        print(f"Deploy complete: {len(items)} files uploaded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
