from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import byterover


class ByteRoverOfflineCommandTests(unittest.TestCase):
    def test_normal_command_runs_node_directly(self) -> None:
        with patch.dict(os.environ, {"FULCRUM_BYTEROVER_OFFLINE": "0"}, clear=False):
            command, cwd = byterover._command("/usr/bin/node", Path("/skill/query.mjs"), ("question",))
        self.assertEqual(command, ["/usr/bin/node", "/skill/query.mjs", "question"])
        self.assertEqual(cwd, Path.cwd().resolve())

    def test_offline_command_uses_private_network_namespace(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            env = {"FULCRUM_BYTEROVER_OFFLINE": "1", "BRV_DATA_DIR": str(data_dir)}
            with (
                patch.dict(os.environ, env, clear=False),
                patch.object(byterover.sys, "platform", "linux"),
                patch.object(byterover.shutil, "which", return_value="/usr/bin/bwrap"),
            ):
                command, _ = byterover._command(
                    "/usr/bin/node",
                    Path("/skill/query.mjs"),
                    ("question",),
                )
        self.assertEqual(command[0:2], ["/usr/bin/bwrap", "--unshare-net"])
        self.assertIn(str(data_dir), command)
        self.assertEqual(command[-3:], ["/usr/bin/node", "/skill/query.mjs", "question"])

    def test_offline_command_fails_closed_without_bubblewrap(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            env = {"FULCRUM_BYTEROVER_OFFLINE": "1", "BRV_DATA_DIR": temp}
            with (
                patch.dict(os.environ, env, clear=False),
                patch.object(byterover.sys, "platform", "linux"),
                patch.object(byterover.shutil, "which", return_value=None),
            ):
                with self.assertRaisesRegex(byterover.ByteRoverError, "requires bubblewrap"):
                    byterover._command("/usr/bin/node", Path("/skill/query.mjs"), ())

    def test_offline_mode_refuses_daemon_in_host_network_namespace(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            pid_dir = data_dir / "projects" / ".daemon"
            pid_dir.mkdir(parents=True)
            (pid_dir / "daemon.pid").write_text(f'{{"pid": {os.getpid()}}}')
            with self.assertRaisesRegex(byterover.ByteRoverError, "existing daemon with network access"):
                byterover._assert_offline_daemon_isolated(data_dir)


if __name__ == "__main__":
    unittest.main()
