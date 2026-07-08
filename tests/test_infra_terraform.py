from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAIN_TF = ROOT / "infra" / "main.tf"


def _block(source: str, header: str) -> str:
    match = re.search(rf"{re.escape(header)}\s*\{{", source)
    assert match is not None, f"Missing Terraform block: {header}"

    start = match.end() - 1
    depth = 0
    body_start = None
    in_string = False
    escaped = False

    for index, char in enumerate(source[start:], start=start):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
            if depth == 1:
                body_start = index + 1
        elif char == "}":
            depth -= 1
            if depth == 0 and body_start is not None:
                return source[body_start:index]

    raise AssertionError(f"Unclosed Terraform block: {header}")


def _assert_assignment(source: str, name: str, value: str) -> None:
    pattern = rf"(?m)^\s*{re.escape(name)}\s*=\s*{re.escape(value)}\s*$"
    assert re.search(pattern, source), f"Expected {name} = {value}"


def test_dashboard_cloud_run_resources_are_cost_sized() -> None:
    source = MAIN_TF.read_text()
    service = _block(source, 'resource "google_cloud_run_v2_service" "dashboard"')
    service_scaling = _block(service, "scaling")
    template = _block(service, "template")
    template_scaling = _block(template, "scaling")
    containers = _block(template, "containers")
    resources = _block(containers, "resources")
    limits = _block(resources, "limits =")

    _assert_assignment(service_scaling, "min_instance_count", "0")

    _assert_assignment(
        template,
        "execution_environment",
        '"EXECUTION_ENVIRONMENT_GEN1"',
    )
    _assert_assignment(template, "max_instance_request_concurrency", "1")

    _assert_assignment(template_scaling, "min_instance_count", "0")
    _assert_assignment(template_scaling, "max_instance_count", "1")

    _assert_assignment(limits, "cpu", '"0.5"')
    _assert_assignment(limits, "memory", '"512Mi"')
    _assert_assignment(resources, "cpu_idle", "true")
    _assert_assignment(resources, "startup_cpu_boost", "true")
