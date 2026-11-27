"""Choose the local worker's slot count from Linux CPU and memory allowances."""
import os
import sys
from pathlib import Path

MAX_CONCURRENCY = 4
MIB = 1024 * 1024
CPUS_PER_JOB = 2
MEMORY_PER_JOB = 1536 * MIB
CPU_RESERVE = 2
MEMORY_RESERVE = 2048 * MIB


def _read(path):
    try:
        return path.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        # The controller may be absent or mounted using the other cgroup version.
        return ""


def _ancestors(root, relative):
    path = root
    yield path
    for entry in Path(relative).parts[1:]:
        path = path / entry
        yield path


def _memberships(proc_cgroup):
    for line in proc_cgroup.splitlines():
        _, controllers, path = line.split(":", 2)
        # A namespace can report an ancestor outside the mounted root.
        if not path.startswith("/") or ".." in Path(path).parts:
            path = "/"
        for controller in controllers.split(","):
            yield controller, path


def _cpu_v2(group):
    fields = _read(group / "cpu.max").split()
    if fields and fields[0] != "max":
        return int(fields[0]) // int(fields[1])
    return None


def _cpu_v1(group):
    quota = _read(group / "cpu.cfs_quota_us")
    if quota and int(quota) > 0:
        return int(quota) // int(_read(group / "cpu.cfs_period_us"))
    return None


def _memory(group, limit_file, usage_file):
    limit = _read(group / limit_file)
    if limit and limit != "max":
        return max(0, int(limit) - int(_read(group / usage_file)))
    return None


def worker_capacity(logical_cpus, meminfo, cgroups, mount):
    """Return slots, CPU budget and available bytes, keeping headroom for other services."""
    mem_available = next((int(line.split()[1]) * 1024 for line in meminfo.splitlines()
                          if line.startswith("MemAvailable:")), 0)
    cpu_budget = max(1, logical_cpus - CPU_RESERVE)
    memory_budget = max(0, mem_available - MEMORY_RESERVE)
    roots = {"": (mount,), "cpu": (mount / "cpu", mount / "cpu,cpuacct", mount / "cpuacct,cpu"),
             "memory": (mount / "memory",)}
    for controller, relative in _memberships(cgroups):
        for root in roots.get(controller, ()):
            for group in _ancestors(root, relative):
                if controller != "memory":
                    cpu = _cpu_v2(group) if controller == "" else _cpu_v1(group)
                    if cpu is not None:
                        cpu_budget = min(cpu_budget, cpu)
                if controller != "cpu":
                    usage = ("memory.max", "memory.current") if controller == "" else ("memory.limit_in_bytes", "memory.usage_in_bytes")
                    memory = _memory(group, *usage)
                    if memory is not None:
                        memory_budget = min(memory_budget, memory)
    slots = max(1, min(MAX_CONCURRENCY, cpu_budget // CPUS_PER_JOB, memory_budget // MEMORY_PER_JOB))
    return slots, cpu_budget, memory_budget


def detect_capacity():
    """Read the kernel's visible resources once at worker startup."""
    cpu_count = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count() or 1
    try:
        cgroups = _read(Path("/proc/self/cgroup"))
        if cgroups:
            return worker_capacity(cpu_count, _read(Path("/proc/meminfo")), cgroups, Path("/sys/fs/cgroup"))
    except (OSError, ValueError, ZeroDivisionError) as error:
        print(f"Cannot read video-remake resource limits: {error}", file=sys.stderr)
    return 1, cpu_count, 0
