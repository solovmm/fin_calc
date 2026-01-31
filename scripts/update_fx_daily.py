import json
from datetime import datetime, timedelta
from pathlib import Path
import xml.etree.ElementTree as ET

import pandas as pd
import requests

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
OUT_FILE = DATA_DIR / "fx_daily.json"

START_DATE = datetime(2000, 1, 1).date()
DATE_FMT = "%d.%m.%Y"

# Валюты по требованию
CURRENCIES = {
    "USD": ["R01235"],
    "EUR": ["R01239"],
    "CNY": ["R01375"],
    "GBP": ["R01035"],
    "CHF": ["R01775"],
    "THB": ["R01675"],
    "IDR": ["R01280"],
    "TRY": ["R01700", "R01700J"],  # сначала R01700 как попросили, затем fallback
    "INR": ["R01270"],
}


def _fetch_currency_series(val_ids, start_date, end_date):
    last_error = None
    for val_id in val_ids:
        url = (
            "https://www.cbr.ru/scripts/XML_dynamic.asp"
            f"?date_req1={start_date.strftime(DATE_FMT)}"
            f"&date_req2={end_date.strftime(DATE_FMT)}"
            f"&VAL_NM_RQ={val_id}"
        )
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            root = ET.fromstring(resp.content)
        except Exception as e:
            last_error = e
            continue

        records = []
        for record in root.findall("Record"):
            date_str = record.attrib.get("Date")
            nominal = float(record.findtext("Nominal").replace(",", "."))
            value = float(record.findtext("Value").replace(",", "."))
            rate = value / nominal
            date = datetime.strptime(date_str, DATE_FMT).date()
            records.append({"date": date, "rate": rate})

        if not records:
            last_error = ValueError(f"No records for {val_id}")
            continue

        df = pd.DataFrame(records)
        df["date"] = pd.to_datetime(df["date"])
        df = df.sort_values("date").set_index("date")

        full_idx = pd.date_range(start=start_date, end=end_date, freq="D")
        df = df.reindex(full_idx)
        df["rate"] = df["rate"].ffill()
        return df["rate"].reset_index().rename(columns={"index": "date"})

    raise RuntimeError(f"Failed to fetch currency series: {last_error}")


def _load_existing():
    if not OUT_FILE.exists():
        return None
    data = json.loads(OUT_FILE.read_text(encoding="utf-8"))
    rows = data.get("series", [])
    if not rows:
        return None

    records = []
    for row in rows:
        rec = {"date": row.get("date")}
        rates = row.get("rates", {})
        rec.update(rates)
        records.append(rec)

    df = pd.DataFrame(records)
    df["date"] = pd.to_datetime(df["date"])
    return df


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    existing_df = _load_existing()
    today = datetime.now().date()

    if existing_df is None:
        fetch_start = START_DATE
    else:
        last_date = existing_df["date"].max().date()
        fetch_start = max(START_DATE, last_date - timedelta(days=7))

    all_rates = []
    for code, ids in CURRENCIES.items():
        series_df = _fetch_currency_series(ids, fetch_start, today)
        series_df = series_df.rename(columns={"rate": code})
        all_rates.append(series_df)

    df = all_rates[0]
    for other in all_rates[1:]:
        df = df.merge(other, on="date", how="outer")

    df = df.sort_values("date")

    if existing_df is not None:
        df = pd.concat([existing_df, df], ignore_index=True)
        df = df.drop_duplicates(subset=["date"], keep="last")
        df = df.sort_values("date")

    df = df[df["date"].dt.date >= START_DATE]

    codes = list(CURRENCIES.keys())
    output_rows = []
    for _, row in df.iterrows():
        rates = {}
        for code in codes:
            val = row.get(code)
            rates[code] = round(float(val), 6) if pd.notna(val) else None
        output_rows.append({
            "date": row["date"].strftime("%Y-%m-%d"),
            "rates": rates
        })

    meta = {
        "base": "RUB",
        "source": "CBR XML_dynamic",
        "currencies": codes,
        "start": START_DATE.strftime("%Y-%m-%d"),
        "end": output_rows[-1]["date"] if output_rows else None,
        "updated": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rows": len(output_rows),
    }

    out = {"meta": meta, "series": output_rows}
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {OUT_FILE} ({len(output_rows)} rows)")


if __name__ == "__main__":
    main()
