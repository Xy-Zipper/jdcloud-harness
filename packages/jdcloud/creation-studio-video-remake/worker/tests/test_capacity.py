"""Exercise the CPU and memory limits and the HTTP worker slots."""
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Thread
from unittest.mock import patch
from urllib.request import ProxyHandler, Request, build_opener

from capacity import MIB, worker_capacity
from server import Handler, WorkerServer


class WorkerCapacityTest(unittest.TestCase):
    def test_sizes_for_the_vm_and_clamps_to_cpu_and_memory_quotas(self):
        with tempfile.TemporaryDirectory() as directory:
            mount = Path(directory)
            meminfo = f"MemAvailable: {20 * 1024 * 1024} kB"
            self.assertEqual(worker_capacity(8, meminfo, "0::/", mount), (3, 6, 18 * 1024 * MIB))
            (mount / "cpu.max").write_text("200000 100000\n")
            self.assertEqual(worker_capacity(8, meminfo, "0::/", mount)[0], 1)
            (mount / "cpu.max").write_text("max 100000\n")
            (mount / "memory.max").write_text(str(3400 * MIB))
            (mount / "memory.current").write_text(str(400 * MIB))
            self.assertEqual(worker_capacity(8, meminfo, "0::/", mount)[0], 1)
            (mount / "memory.max").write_text("max\n")
            self.assertEqual(worker_capacity(32, meminfo, "0::/", mount)[0], 4)

    def test_uses_cgroup_v1_limits_even_in_a_child_group(self):
        with tempfile.TemporaryDirectory() as directory:
            mount = Path(directory)
            group = mount / "cpu,cpuacct" / "docker" / "worker"
            group.mkdir(parents=True)
            (group / "cpu.cfs_quota_us").write_text("600000\n")
            (group / "cpu.cfs_period_us").write_text("100000\n")
            parent = group.parent
            (parent / "cpu.cfs_quota_us").write_text("400000\n")
            (parent / "cpu.cfs_period_us").write_text("100000\n")
            memory = mount / "memory"
            memory.mkdir()
            (memory / "memory.limit_in_bytes").write_text(str(8 * 1024 * MIB))
            (memory / "memory.usage_in_bytes").write_text(str(64 * MIB))
            memberships = "2:cpu,cpuacct:/docker/worker\n3:memory:/docker/worker\n"
            self.assertEqual(worker_capacity(8, "MemAvailable: 20971520 kB", memberships, mount)[0], 2)

    def test_probe_reports_slots_and_two_requests_overlap(self):
        arrived = Barrier(2)

        def measure(_video):
            arrived.wait(timeout=5)
            return 6

        with patch("server.measure", measure), WorkerServer(("127.0.0.1", 0), Handler, 2) as server:
            serving = Thread(target=server.serve_forever)
            serving.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/probe"

                def probe():
                    opener = build_opener(ProxyHandler({}))
                    with opener.open(Request(url, data=b"0000ftypisom"), timeout=8) as response:
                        return response.headers["X-Remake-Worker-Concurrency"], response.read()

                with ThreadPoolExecutor(2) as clients:
                    self.assertEqual(list(clients.map(lambda _: probe(), range(2))),
                                     [("2", b'{"duration": 6}')] * 2)
            finally:
                server.shutdown()
                serving.join()
