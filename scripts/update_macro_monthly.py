import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

import pandas as pd
import requests
import urllib3
from io import BytesIO
from bs4 import BeautifulSoup

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
MACRO_FILE = DATA_DIR / "macro_monthly.json"
FX_DAILY_FILE = DATA_DIR / "fx_daily.json"

START_DATE = datetime(2000, 1, 1)

FX_CODES = ["USD", "EUR", "CNY", "GBP", "CHF", "THB", "IDR", "TRY", "INR"]

ROSSTAT_CPI_URL = "https://github.com/solovmm/rosstat/raw/refs/heads/main/ipc_mes.xlsx"

MONTH_TO_NUM = {
    "январь": 1,
    "февраль": 2,
    "март": 3,
    "апрель": 4,
    "май": 5,
    "июнь": 6,
    "июль": 7,
    "август": 8,
    "сентябрь": 9,
    "октябрь": 10,
    "ноябрь": 11,
    "декабрь": 12,
}


def load_fx_daily():
    if not FX_DAILY_FILE.exists():
        raise FileNotFoundError(f"Missing {FX_DAILY_FILE}. Run update_fx_daily.py first.")

    data = json.loads(FX_DAILY_FILE.read_text(encoding="utf-8"))
    rows = data.get("series", [])
    records = []
    for row in rows:
        rec = {"date": row.get("date")}
        rates = row.get("rates", {})
        for code in FX_CODES:
            rec[code] = rates.get(code)
        records.append(rec)

    df = pd.DataFrame(records)
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").set_index("date")
    return df


def compute_fx_monthly(df_daily):
    df_daily = df_daily[FX_CODES].copy()
    monthly_mean = df_daily.resample("ME").mean()
    monthly_end = df_daily.resample("ME").last()
    monthly_mean.index = monthly_mean.index.to_period("M")
    monthly_end.index = monthly_end.index.to_period("M")

    out = pd.DataFrame(index=monthly_mean.index)
    for code in FX_CODES:
        out[f"rate_{code.lower()}"] = monthly_mean[code]
        out[f"rate_{code.lower()}_end"] = monthly_end[code]
    return out


def fetch_key_rate_changes():
    url = (
        "https://www.cbr.ru/hd_base/KeyRate/?UniDbQuery.Posted=True"
        f"&UniDbQuery.From={START_DATE.strftime('%d.%m.%Y')}"
        f"&UniDbQuery.To={datetime.now().strftime('%d.%m.%Y')}"
    )
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.content, "html.parser")
    table = None
    for t in soup.find_all("table"):
        if "Дата" in t.get_text() and "Ставка" in t.get_text():
            table = t
            break
    if table is None:
        raise ValueError("Key rate table not found on CBR page")

    data = []
    for row in table.find_all("tr")[1:]:
        cols = row.find_all("td")
        if len(cols) < 2:
            continue
        date = datetime.strptime(cols[0].get_text(strip=True), "%d.%m.%Y")
        rate = float(cols[1].get_text(strip=True).replace(",", "."))
        data.append({"date": date, "rate": rate})

    df = pd.DataFrame(data).sort_values("date")
    df = df.set_index("date")

    full_idx = pd.date_range(start=START_DATE, end=datetime.now(), freq="D")
    df = df.reindex(full_idx)
    df["rate"] = df["rate"].ffill()
    return df


def compute_key_rate_monthly(df_daily):
    monthly_mean = df_daily["rate"].resample("ME").mean()
    monthly_end = df_daily["rate"].resample("ME").last()
    monthly_mean.index = monthly_mean.index.to_period("M")
    monthly_end.index = monthly_end.index.to_period("M")
    return monthly_mean, monthly_end


def _download_cpi_bytes():
    url_ext = Path(ROSSTAT_CPI_URL).suffix.lower()
    try:
        resp = requests.get(ROSSTAT_CPI_URL, timeout=30)
        resp.raise_for_status()
        return resp.content, url_ext
    except requests.RequestException:
        pass

    try:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        resp = requests.get(ROSSTAT_CPI_URL, timeout=30, verify=False)
        resp.raise_for_status()
        return resp.content, url_ext
    except requests.RequestException:
        pass

    try:
        result = subprocess.run(
            ["curl", "-L", "-f", ROSSTAT_CPI_URL],
            check=True,
            capture_output=True,
        )
        return result.stdout, url_ext
    except Exception as exc:
        raise RuntimeError("Failed to download CPI file from Rosstat") from exc


def _read_cpi_excel(content, ext):
    if ext != ".xlsx":
        raise RuntimeError("CPI file must be .xlsx")
    return pd.read_excel(BytesIO(content), sheet_name="01", header=3, nrows=13, engine="openpyxl")


def load_cpi():
    local_override = os.getenv("ROSSTAT_CPI_LOCAL")
    local_path = Path(local_override) if local_override else None
    bundled_xlsx = DATA_DIR / "rosstat_ipc_mes.xlsx"

    content = None
    ext = None
    if local_path and local_path.exists():
        content = local_path.read_bytes()
        ext = local_path.suffix.lower()
    elif bundled_xlsx.exists():
        content = bundled_xlsx.read_bytes()
        ext = bundled_xlsx.suffix.lower()
    else:
        content, ext = _download_cpi_bytes()

    df = _read_cpi_excel(content, ext)
    df = df.rename(columns={"Unnamed: 0": "month"})
    df["month"] = df["month"].map(MONTH_TO_NUM)
    df = df.dropna(subset=["month"])

    long_df = df.melt(id_vars=["month"], var_name="year", value_name="cpi_index")
    long_df = long_df.dropna(subset=["year"])
    long_df["year"] = long_df["year"].astype(int)
    long_df["month"] = long_df["month"].astype(int)
    long_df["cpi_index"] = pd.to_numeric(long_df["cpi_index"], errors="coerce")

    long_df["date"] = pd.to_datetime(
        long_df["year"].astype(str) + "-" + long_df["month"].astype(str).str.zfill(2) + "-01"
    )
    long_df = long_df.sort_values("date")

    long_df["cpi_mom"] = long_df["cpi_index"] - 100

    long_df["cpi_ytd"] = (
        long_df.groupby("year")["cpi_index"]
        .apply(lambda s: (s / 100).cumprod() * 100 - 100)
        .reset_index(level=0, drop=True)
    )

    long_df["chain_index"] = (long_df["cpi_index"] / 100).cumprod() * 100
    long_df["cpi_yoy"] = long_df["chain_index"].pct_change(12, fill_method=None) * 100

    long_df = long_df.set_index("date")
    long_df["month"] = long_df.index.to_period("M")

    cpi = long_df.groupby("month").last()[["cpi_mom", "cpi_yoy", "cpi_ytd"]]
    return cpi


def load_macro_base():
    if not MACRO_FILE.exists():
        raise FileNotFoundError(f"Missing {MACRO_FILE}")
    data = json.loads(MACRO_FILE.read_text(encoding="utf-8"))
    return data


def main():
    macro = load_macro_base()
    series = macro.get("series", [])
    if not series:
        raise ValueError("macro_monthly.json is empty")

    last_month_str = max(row.get("month") for row in series if row.get("month"))
    last_month = pd.Period(last_month_str, freq="M")

    fx_daily = load_fx_daily()
    fx_monthly = compute_fx_monthly(fx_daily)

    key_daily = fetch_key_rate_changes()
    key_mean, key_end = compute_key_rate_monthly(key_daily)

    cpi = load_cpi()

    target_months = [m for m in fx_monthly.index if m > last_month]
    target_months.sort()

    rate_fields = []
    for code in FX_CODES:
        rate_fields.append(f"rate_{code.lower()}")
        rate_fields.append(f"rate_{code.lower()}_end")

    # ensure all rows have new fields
    for row in series:
        for field in rate_fields:
            row.setdefault(field, None)

    new_rows = []
    for month in target_months:
        if month not in fx_monthly.index:
            continue
        if month not in key_mean.index or month not in key_end.index:
            continue
        if month not in cpi.index:
            continue

        fx_row = fx_monthly.loc[month]
        key_val = key_mean.loc[month]
        key_val_end = key_end.loc[month]
        cpi_row = cpi.loc[month]

        required = [key_val, key_val_end, cpi_row.get("cpi_mom"), cpi_row.get("cpi_yoy"), cpi_row.get("cpi_ytd")]
        if any(pd.isna(v) for v in required):
            continue

        row = {
            "date": month.to_timestamp().strftime("%Y-%m-%d"),
            "month": str(month),
            "key_rate": float(key_val),
            "key_rate_end": float(key_val_end),
            "cpi_mom": float(cpi_row["cpi_mom"]),
            "cpi_yoy": float(cpi_row["cpi_yoy"]),
            "cpi_ytd": float(cpi_row["cpi_ytd"]),
        }

        missing_fx = False
        for code in FX_CODES:
            avg_val = fx_row.get(f"rate_{code.lower()}")
            end_val = fx_row.get(f"rate_{code.lower()}_end")
            if pd.isna(avg_val) or pd.isna(end_val):
                missing_fx = True
                break
            row[f"rate_{code.lower()}"] = float(avg_val)
            row[f"rate_{code.lower()}_end"] = float(end_val)

        if missing_fx:
            continue

        new_rows.append(row)

    if not new_rows:
        print("No new months to append.")
        return

    series.extend(new_rows)
    series.sort(key=lambda r: r.get("month", ""))

    macro["series"] = series
    macro.setdefault("meta", {})
    macro["meta"]["generated_at"] = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    macro["meta"]["rows"] = len(series)
    macro["meta"].setdefault("source", "CBR + Rosstat")

    MACRO_FILE.write_text(json.dumps(macro, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Appended {len(new_rows)} months. Total rows: {len(series)}")


if __name__ == "__main__":
    main()
