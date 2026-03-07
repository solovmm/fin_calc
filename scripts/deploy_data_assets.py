#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import socket
from dataclasses import dataclass
from ftplib import FTP
from pathlib import Path


DATA_REPO_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class UploadItem:
    local_path: Path
    remote_rel: str


UPLOAD_ITEMS = (
    UploadItem(DATA_REPO_ROOT / "data" / "macro_monthly.json", "assets/macro_monthly.json"),
    UploadItem(DATA_REPO_ROOT / "data" / "fx_daily.json", "assets/fx_daily.json"),
    UploadItem(
        DATA_REPO_ROOT / "data" / "inflation_ru_full_1991_2024.json",
        "inflation_ru_full_1991_2024.json",
    ),
)


def parse_args() -> argparse.Namespace:
    port_default = os.getenv("TIMEWEB_FTP_PORT") or "21"
    parser = argparse.ArgumentParser(description="Deploy runtime data JSON files to Timeweb via FTP.")
    parser.add_argument("--host", default=os.getenv("TIMEWEB_FTP_HOST") or "vh312.timeweb.ru")
    parser.add_argument("--port", type=int, default=int(port_default))
    parser.add_argument("--user", default=os.getenv("TIMEWEB_FTP_USER") or "")
    parser.add_argument("--password", default=os.getenv("TIMEWEB_FTP_PASSWORD") or "")
    parser.add_argument("--remote-root", default=os.getenv("TIMEWEB_FTP_REMOTE_ROOT") or "/fincalc")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def ensure_files() -> None:
    missing = [str(item.local_path) for item in UPLOAD_ITEMS if not item.local_path.exists()]
    if missing:
        raise FileNotFoundError("Missing upload files:\n" + "\n".join(missing))


def ensure_remote_dir(ftp: FTP, rel_dir: str) -> None:
    rel_dir = rel_dir.strip("/")
    if not rel_dir:
        return
    current = ""
    for part in rel_dir.split("/"):
        current = f"{current}/{part}" if current else part
        try:
            ftp.mkd(current)
        except Exception:
            pass


def connect_ftp(host: str, port: int, user: str, password: str, remote_root: str) -> FTP:
    ftp = FTP()
    last_exc: Exception | None = None
    for _ in range(5):
        try:
            ftp.connect(host, port, timeout=90)
            ftp.login(user, password)
            last_exc = None
            break
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
    orig_makepasv = ftp.makepasv

    def _makepasv():
        _ignored_host, passive_port = orig_makepasv()
        return host, passive_port

    ftp.makepasv = _makepasv  # type: ignore[assignment]

    ftp.cwd("/")
    ensure_remote_dir(ftp, remote_root)
    ftp.cwd(remote_root)
    return ftp


def upload_one(ftp: FTP, item: UploadItem, dry_run: bool) -> None:
    remote_dir = str(Path(item.remote_rel).parent).replace("\\", "/")
    if remote_dir not in ("", "."):
        ensure_remote_dir(ftp, remote_dir)

    size = item.local_path.stat().st_size
    if dry_run:
        print(f"DRY  {item.remote_rel} ({size} bytes)")
        return

    last_exc: Exception | None = None
    for _ in range(5):
        try:
            with item.local_path.open("rb") as fh:
                ftp.storbinary(f"STOR {item.remote_rel}", fh)
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

    try:
        remote_size = ftp.size(item.remote_rel)
        if remote_size is not None and int(remote_size) != int(size):
            raise RuntimeError(
                f"Uploaded size mismatch for {item.remote_rel}: local={size} remote={remote_size}"
            )
    except Exception:
        pass

    print(f"OK   {item.remote_rel} ({size} bytes)")


def main() -> int:
    args = parse_args()
    ensure_files()

    if args.dry_run:
        for item in UPLOAD_ITEMS:
            upload_one(None, item, True)  # type: ignore[arg-type]
        return 0

    if not args.user or not args.password:
        raise SystemExit("TIMEWEB_FTP_USER and TIMEWEB_FTP_PASSWORD (or --user/--password) are required")

    ftp = connect_ftp(args.host, args.port, args.user, args.password, args.remote_root)
    try:
        for item in UPLOAD_ITEMS:
            upload_one(ftp, item, False)
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
