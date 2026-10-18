import os
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import deploy_timeweb_ftp as deployer


class FtpDeployTests(unittest.TestCase):
    def test_control_and_passive_connections_use_same_ipv4_address(self):
        ftp = Mock()
        ftp.makepasv.return_value = ("unroutable-server-address", 50001)
        item = deployer.UploadItem(Path("assets/macro_monthly.json"), Path("unused.json"))
        passive_addresses = []
        with patch.dict(os.environ, {"TIMEWEB_FTP_PASSWORD": "test-password"}, clear=True):
            with patch.object(deployer, "FTP", return_value=ftp):
                with patch.object(deployer.socket, "gethostbyname", return_value="192.0.2.1"):
                    with patch.object(deployer, "_sync_runtime_assets"):
                        with patch.object(deployer, "_data_items", return_value=[item]):
                            with patch.object(deployer, "_upload_one", side_effect=lambda *a, **k: passive_addresses.append(ftp.makepasv())):
                                result = deployer.main(["--user", "test-user", "--mode", "data", "--no-bump-version"])
        self.assertEqual(result, 0)
        ftp.connect.assert_called_once_with("192.0.2.1", 21, timeout=30)
        self.assertEqual(passive_addresses, [("192.0.2.1", 50001)])


if __name__ == "__main__":
    unittest.main()
