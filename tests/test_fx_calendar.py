import sys
import unittest
import json
from pathlib import Path

import pandas as pd


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import update_fx_daily
import update_macro_monthly


class DailyFxCalendarTests(unittest.TestCase):
    def test_repository_daily_file_has_complete_calendar_and_rates(self):
        payload = json.loads((REPO_ROOT / "data" / "fx_daily.json").read_text(encoding="utf-8"))
        rows = payload["series"]
        dates = pd.to_datetime([row["date"] for row in rows])
        expected_dates = pd.date_range(dates.min(), dates.max(), freq="D")

        self.assertEqual(dates.tolist(), expected_dates.tolist())
        for row in rows:
            for code in update_fx_daily.CURRENCIES:
                self.assertIsNotNone(row["rates"].get(code), f"{row['date']} {code}")

    def test_incremental_window_does_not_erase_carried_weekend_rate(self):
        existing = pd.DataFrame(
            {
                "date": pd.date_range("2026-02-01", "2026-02-05", freq="D"),
                "USD": [80.0, 80.0, 81.0, 81.0, 82.0],
            }
        )
        refreshed = pd.DataFrame(
            {
                "date": pd.date_range("2026-02-02", "2026-02-05", freq="D"),
                "USD": [None, 81.0, 81.0, 82.0],
            }
        )

        merged = pd.concat([existing, refreshed], ignore_index=True)
        repaired = update_fx_daily.normalize_daily_rates(merged, ["USD"])

        self.assertEqual(repaired.loc[repaired["date"] == "2026-02-02", "USD"].item(), 80.0)
        self.assertFalse(repaired["USD"].isna().any())

    def test_missing_calendar_rows_are_added_and_forward_filled(self):
        sparse = pd.DataFrame(
            {
                "date": pd.to_datetime(["2026-02-01", "2026-02-04"]),
                "USD": [80.0, 82.0],
            }
        )

        repaired = update_fx_daily.normalize_daily_rates(sparse, ["USD"])

        self.assertEqual(repaired["date"].dt.strftime("%Y-%m-%d").tolist(), [
            "2026-02-01", "2026-02-02", "2026-02-03", "2026-02-04"
        ])
        self.assertEqual(repaired["USD"].tolist(), [80.0, 80.0, 80.0, 82.0])


class MonthlyFxCalendarTests(unittest.TestCase):
    def test_monthly_average_uses_every_calendar_day_for_all_currencies(self):
        dates = pd.to_datetime(["2026-01-31", "2026-02-03", "2026-02-06", "2026-02-28"])
        data = {}
        expected = {}
        for offset, code in enumerate(update_macro_monthly.FX_CODES):
            start = 80.0 + offset
            middle = 82.0 + offset
            end = 84.0 + offset
            data[code] = [start, middle, end, None]
            expected[code] = (start * 2 + middle * 3 + end * 23) / 28

        daily = pd.DataFrame(data, index=dates)
        monthly = update_macro_monthly.compute_fx_monthly(daily)
        february = monthly.loc[pd.Period("2026-02", freq="M")]

        for code in update_macro_monthly.FX_CODES:
            self.assertAlmostEqual(february[f"rate_{code.lower()}"], expected[code])
            self.assertEqual(february[f"rate_{code.lower()}_end"], 84.0 + update_macro_monthly.FX_CODES.index(code))


if __name__ == "__main__":
    unittest.main()
