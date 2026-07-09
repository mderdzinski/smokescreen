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


def _blocks(source: str, header: str) -> list[str]:
    blocks: list[str] = []
    offset = 0

    while True:
        match = re.search(rf"{re.escape(header)}\s*\{{", source[offset:])
        if match is None:
            break

        start = offset + match.end() - 1
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
                    blocks.append(source[body_start:index])
                    offset = index + 1
                    break
        else:
            raise AssertionError(f"Unclosed Terraform block: {header}")

    assert blocks, f"Missing Terraform block: {header}"
    return blocks


def _assert_assignment(source: str, name: str, value: str) -> None:
    pattern = rf"(?m)^\s*{re.escape(name)}\s*=\s*{re.escape(value)}\s*$"
    assert re.search(pattern, source), f"Expected {name} = {value}"


def test_artifact_registry_repository_has_cleanup_policies() -> None:
    source = MAIN_TF.read_text()
    repository = _block(
        source,
        'resource "google_artifact_registry_repository" "smokescreen"',
    )
    policies = {
        re.search(r'(?m)^\s*id\s*=\s*"([^"]+)"\s*$', policy).group(1): policy
        for policy in _blocks(repository, "cleanup_policies")
    }
    _assert_assignment(repository, "repository_id", "var.artifact_repository_id")
    _assert_assignment(repository, "location", "var.artifact_repository_location")
    _assert_assignment(repository, "format", '"DOCKER"')
    _assert_assignment(repository, "cleanup_policy_dry_run", "false")

    keep_recent = policies["keep-recent-versions"]
    _assert_assignment(keep_recent, "action", '"KEEP"')
    _assert_assignment(_block(keep_recent, "most_recent_versions"), "keep_count", "10")

    delete_old_untagged = policies["delete-old-untagged-images"]
    _assert_assignment(delete_old_untagged, "action", '"DELETE"')
    delete_condition = _block(delete_old_untagged, "condition")
    _assert_assignment(delete_condition, "tag_state", '"UNTAGGED"')
    _assert_assignment(delete_condition, "older_than", '"2592000s"')


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


def test_poll_scheduler_runs_hourly_in_utc() -> None:
    source = MAIN_TF.read_text()
    poll_schedule = _block(
        source,
        'resource "google_cloud_scheduler_job" "poll_schedule"',
    )

    _assert_assignment(poll_schedule, "schedule", '"0 * * * *"')
    _assert_assignment(poll_schedule, "time_zone", '"Etc/UTC"')
    assert "paused" not in poll_schedule


def test_dashboard_service_account_can_trigger_poll_job() -> None:
    source = MAIN_TF.read_text()
    poll_runner = _block(
        source,
        'resource "google_cloud_run_v2_job_iam_member" "dashboard_poll_runner"',
    )

    _assert_assignment(poll_runner, "role", '"roles/run.invoker"')
    assert "google_cloud_run_v2_job.poll_and_reply.name" in poll_runner
    assert "google_service_account.dashboard.email" in poll_runner
