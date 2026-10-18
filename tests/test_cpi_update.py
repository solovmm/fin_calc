import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import update_macro_monthly as updater


class CpiUpdateTests(unittest.TestCase):
    def test_decimal_comma_and_numeric_excel_cells_produce_same_cpi(self):
        months = list(updater.MONTH_TO_NUM)
        numeric = pd.DataFrame({"Unnamed: 0": months, 2025: [100.5] * 12, 2026: [100.35] * 12})
        textual = numeric.copy()
        textual[2026] = "100,35"
        with patch.object(updater, "_download_cpi_bytes", return_value=(b"", ".xlsx")):
            with patch.object(updater, "_read_cpi_excel", return_value=numeric):
                expected = updater.load_cpi()
            with patch.object(updater, "_read_cpi_excel", return_value=textual):
                actual = updater.load_cpi()
        pd.testing.assert_frame_equal(actual, expected)
        self.assertAlmostEqual(actual.loc[pd.Period("2026-09"), "cpi_mom"], 0.35)

    def test_bad_nonempty_cell_is_reported_instead_of_silently_skipped(self):
        data = pd.DataFrame({"Unnamed: 0": ["сентябрь"], 2026: ["invalid"]})
        with patch.object(updater, "_download_cpi_bytes", return_value=(b"", ".xlsx")):
            with patch.object(updater, "_read_cpi_excel", return_value=data):
                with self.assertRaises(ValueError):
                    updater.load_cpi()

    def test_repeat_cpi_update_without_local_site_is_successful_and_preserves_rates(self):
        month = pd.Period(pd.Timestamp.now(), freq="M") - 1
        row = {
            "month": str(month), "date": f"{month}-01", "rate_usd": 85.0,
            "rate_usd_end": 84.0, "key_rate": 14.0, "key_rate_end": 14.0,
            "cpi_mom": None, "cpi_yoy": None, "cpi_ytd": None,
        }
        cpi = pd.DataFrame({"cpi_mom": [0.35], "cpi_yoy": [6.0], "cpi_ytd": [5.0]}, index=[month])
        with tempfile.TemporaryDirectory() as tmp:
            macro_path = Path(tmp) / "macro.json"
            macro_path.write_text(json.dumps({"meta": {}, "series": [row]}), encoding="utf-8")
            with patch.multiple(updater, MACRO_FILE=macro_path, MACRO_ASSET_FILE=None,
                                LAST_UPDATED_FILE=Path(tmp) / "last_updated.json"):
                with patch.object(updater, "load_cpi", return_value=cpi):
                    with patch.object(sys, "argv", ["update_macro_monthly.py", "--mode", "cpi"]):
                        updater.main()
                        first = macro_path.read_bytes()
                        updater.main()
                        self.assertEqual(macro_path.read_bytes(), first)
            actual = json.loads(first)["series"][0]
            self.assertEqual(actual["cpi_mom"], 0.35)
            for field in ("rate_usd", "rate_usd_end", "key_rate", "key_rate_end", "month", "date"):
                self.assertEqual(actual[field], row[field])


if __name__ == "__main__":
    unittest.main()
