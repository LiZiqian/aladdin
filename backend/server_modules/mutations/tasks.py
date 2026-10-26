"""单任务与批量任务写入。
顺序保持为校验、同事务写入关联记录、推进 revision 与审计、提交。
业务拒绝返回 (False, detail)，成功返回 (True, detail)；由 HTTP 层生成响应。"""
from __future__ import annotations

from .common import (
    MutationServiceContext,
    _bump_revision_and_audit,
    _current_revision,
    _mutation_flags_failure,
    _task_revision_failure,
)

from .effects import (
    _operational_sample_write_payloads,
    reconcile_task_sample_occupancy,
)

from .sample_guards import (
    _sample_event_conflict_failure,
)

from .task_guards import (
    _task_sample_event_scope_failure,
    _task_sample_payload_failure,
    _task_scope_failure,
)

from server_modules import (
    device_tasks,
    mutation_summary,
    record_writers,
    status_normalization,
    task_mutation_rules,
)


def commit_task_mutation(ctx: MutationServiceContext, payload: dict, client_ip: str) -> tuple[bool, dict]:
    flag_failure = _mutation_flags_failure(payload, "createIfMissing")
    if flag_failure:
        return False, flag_failure
    task = payload.get("task")
    if not isinstance(task, dict):
        return False, {"status": 400, "error": "task 必须是 JSON 对象"}
    sample_ids_failure = task_mutation_rules.task_sample_ids_failure(task)
    if sample_ids_failure:
        return False, sample_ids_failure
    task_id = str(payload.get("taskId") or task.get("id") or "")
    project_id = str(payload.get("projectId") or task.get("projectId") or "")
    stage_id = str(payload.get("stageId") or task.get("stageId") or "")
    if not task_id or not project_id or not stage_id:
        return False, {"status": 400, "error": "缺少 projectId/stageId/taskId"}
    samples_value = payload.get("samples")
    sample_events_value = payload.get("sampleEvents")
    if samples_value is not None and not isinstance(samples_value, list):
        return False, {"status": 400, "error": "samples 必须是数组"}
    if sample_events_value is not None and not isinstance(sample_events_value, list):
        return False, {"status": 400, "error": "sampleEvents 必须是数组"}
    sample_payloads = [sample for sample in (samples_value or []) if isinstance(sample, dict)]
    if len(sample_payloads) != len(samples_value or []):
        return False, {"status": 400, "error": "samples 中每一项都必须是 JSON 对象"}
    sample_events = [event for event in (sample_events_value or []) if isinstance(event, dict)]
    if len(sample_events) != len(sample_events_value or []):
        return False, {"status": 400, "error": "sampleEvents 中每一项都必须是 JSON 对象"}
    action_aliases = {"task_start": "start_task"}
    raw_action = str(payload.get("action") or "")
    action = action_aliases.get(raw_action, raw_action)
    allowed_actions = {
        "create_task_config",
        "save_task_config",
        "assign_task_samples",
        "reassign_task_samples",
        "set_task_plan",
        "temp_change_task",
        "save_task_result_draft",
        "update_issue_record",
        "upload_task_result",
        "start_task",
        "restart_task",
        "block_task",
        "finish_task_result",
        "archive_task_delete",
        "delete_task",
    }
    if action not in allowed_actions:
        return False, {
            "status": 400,
            "error_code": "TASK_ACTION_NOT_ALLOWED",
            "error": f"不支持的任务操作: {raw_action or '(空)'}",
        }
    is_delete = str(payload.get("deleteMode") or "") == "delete"
    if (action == "delete_task") != is_delete:
        return False, {
            "status": 400,
            "error_code": "TASK_ACTION_NOT_ALLOWED",
            "error": "delete_task 操作与物理删除模式不一致。",
        }
    task["id"] = task_id
    task["projectId"] = project_id
    task["stageId"] = stage_id
    task = status_normalization.normalize_task_payload(task)
    affected = {}

    with ctx.write_db_connection() as conn:
        current_revision = _current_revision(conn)
        revision_failure = _task_revision_failure(payload, current_revision)
        if revision_failure:
            return False, revision_failure
        event_failure = _sample_event_conflict_failure(conn, sample_events)
        if event_failure:
            return False, {**event_failure, "server_revision": current_revision}
        event_scope_failure = _task_sample_event_scope_failure(
            conn,
            sample_events,
            project_id=project_id,
            stage_id=stage_id,
            task_id=task_id,
        )
        if event_scope_failure:
            return False, {**event_scope_failure, "server_revision": current_revision}
        scope_failure = _task_scope_failure(
            conn,
            task_id=task_id,
            project_id=project_id,
            stage_id=stage_id,
        )
        if scope_failure:
            return False, {**scope_failure, "server_revision": current_revision}
        if action == "archive_task_delete" and status_normalization.normalize_task_flow_status(task) not in ("正常完成", "异常终止"):
            archived_at = ctx.now_iso()
            task.update({
                "status": "异常终止",
                "completed": True,
                "completionType": "异常终止",
                "completedAt": str(task.get("completedAt") or archived_at),
                "endDate": str(task.get("endDate") or archived_at[:10]),
            })
            task = status_normalization.normalize_task_payload(task)
        if action == "finish_task_result":
            finished = task_mutation_rules.existing_finished_task(conn, task_id)
            if finished:
                return False, {
                    "status": 409,
                    "error_code": "TASK_ALREADY_FINISHED",
                    "error": "任务已经结束，已拒绝重复结束请求。",
                    "taskId": task_id,
                    "taskStatus": str(finished.get("status") or ""),
                    "server_revision": current_revision,
                }
        state_conflict = task_mutation_rules.task_action_state_conflict(
            conn,
            task_id,
            action,
            task,
            is_delete=is_delete,
        )
        if state_conflict:
            return False, {
                "status": 409,
                "error_code": "TASK_STATE_CONFLICT",
                "error": state_conflict["reason"],
                **state_conflict,
                "server_revision": current_revision,
            }
        current_task = task_mutation_rules.existing_task(conn, task_id) or {}
        device_failure = device_tasks.prepare_task_devices(conn, task, current_task, action,
            now=ctx.now_iso(), user=str(payload.get("user") or ""), is_delete=is_delete)
        if device_failure:
            return False, {**device_failure, "server_revision": current_revision}
        if not is_delete:
            status_blockers = task_mutation_rules.detect_task_mutation_sample_status_blockers(
                conn, [(task_id, task)], check_all=action in ("start_task", "restart_task"))
            if status_blockers:
                return False, {
                    "status": 409,
                    "error_code": "SAMPLE_STATUS_NOT_SELECTABLE",
                    "error": "样机当前状态不可用于测试，请确认样机已归还且可用。",
                    "samples": status_blockers,
                    "server_revision": current_revision,
                }
            if action in ("finish_task_result", "upload_task_result") and sample_payloads:
                result_sample_ids = {str(sample.get("id") or "") for sample in sample_payloads}
                if not task_mutation_rules.existing_finished_task(conn, task_id):
                    # Finishing owns current assignments, but not samples removed
                    # earlier and subsequently assigned to another open task.
                    result_sample_ids -= task_mutation_rules.existing_task_sample_ids(conn, task_id)
                locked = task_mutation_rules.detect_completed_task_sample_current_state_locks(
                    conn,
                    task_id,
                    result_sample_ids,
                )
                if locked:
                    return False, {
                        "status": 409,
                        "error_code": "SAMPLE_CURRENT_STATE_LOCKED",
                        "error": "样机正在其他未完成任务中，已拒绝通过旧任务覆盖当前样机信息。",
                        "conflicts": locked,
                        "server_revision": current_revision,
                    }
            conflicts = task_mutation_rules.detect_task_mutation_occupancy_conflicts(conn, task_id, task, project_id, stage_id)
            if conflicts:
                return False, {
                    "status": 409,
                    "error_code": "SAMPLE_OCCUPANCY_CONFLICT",
                    "error": "样机预约时间重叠，或仍被其他执行中/阻塞中的任务占用，已拒绝保存。",
                    "conflicts": conflicts,
                    "server_revision": current_revision,
                }

        sample_failure = _task_sample_payload_failure(
            conn,
            task_id=task_id,
            action=action,
            task=task,
            sample_payloads=sample_payloads,
            sample_events=sample_events,
            is_delete=is_delete,
        )
        if sample_failure:
            return False, {**sample_failure, "server_revision": current_revision}

        old_sample_ids = task_mutation_rules.existing_task_sample_ids(conn, task_id)
        current_task = task_mutation_rules.existing_task(conn, task_id) or {}
        reservation_only = status_normalization.normalize_task_flow_status(task) == "待下发"
        if is_delete:
            reservation_only = status_normalization.normalize_task_flow_status(current_task) == "待下发"
        sample_write_payloads = _operational_sample_write_payloads(conn, sample_payloads, preserve_sample_state=reservation_only)
        for sample in sample_write_payloads:
            record_writers.update_sample_record(conn, sample)
        device_tasks.enrich_sample_events(conn, sample_events, task)
        record_writers.upsert_sample_events(conn, sample_events)
        if is_delete:
            record_writers.delete_task_record(conn, task_id)
        else:
            record_writers.upsert_task_record(
                conn,
                task,
                project_id,
                stage_id,
                create_if_missing=bool(payload.get("createIfMissing")),
            )

        affected_sample_ids = old_sample_ids | task_mutation_rules.task_sample_ids(task) | {str(sample["id"]) for sample in sample_write_payloads}
        reconcile_task_sample_occupancy(conn, affected_sample_ids)

        new_revision, updated_at = _bump_revision_and_audit(
            ctx,
            conn,
            current_revision=current_revision,
            action=action,
            remark=str(payload.get("remark") or "任务增量变更"),
            user=str(payload.get("user") or ""),
            client_ip=client_ip,
        )
        for sample in payload.get("samples") or []:
            if isinstance(sample, dict) and sample.get("id"):
                affected_sample_ids.add(str(sample.get("id") or ""))
        for event in payload.get("sampleEvents") or []:
            if isinstance(event, dict) and event.get("sampleId"):
                affected_sample_ids.add(str(event.get("sampleId") or ""))
        affected = mutation_summary.build_mutation_affected_summary(
            conn,
            project_ids=[project_id],
            stage_ids=[stage_id],
            task_ids=[task_id],
            sample_ids=affected_sample_ids,
        )
        conn.commit()

    return True, {"revision": new_revision, "updated_at": updated_at, "affected": affected}


def commit_task_batch_mutation(ctx: MutationServiceContext, payload: dict, client_ip: str) -> tuple[bool, dict]:
    flag_failure = _mutation_flags_failure(payload, "createIfMissing")
    if flag_failure:
        return False, flag_failure
    tasks = payload.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return False, {"status": 400, "error": "tasks 必须是非空数组"}
    project_id = str(payload.get("projectId") or "")
    stage_id = str(payload.get("stageId") or "")
    if not project_id or not stage_id:
        return False, {"status": 400, "error": "缺少 projectId/stageId"}
    affected = {}

    normalized_tasks: list[dict] = []
    seen_task_ids: set[str] = set()
    for task in tasks:
        if not isinstance(task, dict):
            return False, {"status": 400, "error": "tasks 中每一项都必须是 JSON 对象"}
        sample_ids_failure = task_mutation_rules.task_sample_ids_failure(task)
        if sample_ids_failure:
            return False, sample_ids_failure
        device_ids_failure = device_tasks.device_ids_failure(task.get("deviceIds", []))
        if device_ids_failure:
            return False, device_ids_failure
        task_id = str(task.get("id") or "")
        if not task_id:
            return False, {"status": 400, "error": "任务缺少 id"}
        if task_id in seen_task_ids:
            return False, {"status": 400, "error": f"任务 id 重复: {task_id}"}
        seen_task_ids.add(task_id)
        task["id"] = task_id
        task["projectId"] = project_id
        task["stageId"] = stage_id
        normalized_tasks.append(status_normalization.normalize_task_payload(task))

    with ctx.write_db_connection() as conn:
        current_revision = _current_revision(conn)
        revision_failure = _task_revision_failure(payload, current_revision)
        if revision_failure:
            return False, revision_failure
        action = str(payload.get("action") or "task_batch_mutation")
        stage_row = conn.execute(
            """
            SELECT id
            FROM project_stages
            WHERE id = ? AND project_id = ? AND deleted_at IS NULL
            """,
            (stage_id, project_id),
        ).fetchone()
        if not stage_row:
            return False, {"status": 404, "error": f"阶段不存在: {stage_id}"}

        placeholders = ",".join("?" for _ in normalized_tasks)
        existing_rows = conn.execute(
            f"""
            SELECT id, project_id, stage_id
            FROM project_tasks
            WHERE deleted_at IS NULL AND id IN ({placeholders})
            """,
            tuple(str(task.get("id") or "") for task in normalized_tasks),
        ).fetchall()
        scope_conflicts = [
            {
                "taskId": str(row["id"] or ""),
                "actualProjectId": str(row["project_id"] or ""),
                "actualStageId": str(row["stage_id"] or ""),
            }
            for row in existing_rows
            if str(row["project_id"] or "") != project_id or str(row["stage_id"] or "") != stage_id
        ]
        if scope_conflicts:
            return False, {
                "status": 409,
                "error_code": "TASK_SCOPE_CONFLICT",
                "error": "批量任务中包含属于其他项目或阶段的任务，已拒绝跨范围写入。",
                "tasks": scope_conflicts,
                "server_revision": current_revision,
            }

        if action != "create_tasks_batch" or not bool(payload.get("createIfMissing")):
            return False, {
                "status": 409,
                "error_code": "TASK_BATCH_CREATE_ONLY",
                "error": "批量任务接口仅允许一次性创建新的待下发空任务。",
                "server_revision": current_revision,
            }
        if existing_rows:
            return False, {
                "status": 409,
                "error_code": "TASK_ALREADY_EXISTS",
                "error": "批量创建中包含已经存在的任务，已拒绝覆盖。",
                "taskIds": sorted(str(row["id"] or "") for row in existing_rows),
                "server_revision": current_revision,
            }

        invalid_tasks = []
        for task in normalized_tasks:
            sample_ids = task.get("sampleIds")
            flow_status = status_normalization.normalize_task_flow_status(task)
            if not isinstance(sample_ids, list) or sample_ids or flow_status != "待下发":
                invalid_tasks.append({
                    "taskId": str(task.get("id") or ""),
                    "status": flow_status,
                    "sampleIds": sample_ids if isinstance(sample_ids, list) else [],
                })
        if invalid_tasks:
            return False, {
                "status": 409,
                "error_code": "TASK_BATCH_CREATE_ONLY",
                "error": "批量创建只接受未分配样机的待下发任务。",
                "tasks": invalid_tasks,
                "server_revision": current_revision,
            }

        status_blockers = task_mutation_rules.detect_task_mutation_sample_status_blockers(
            conn,
            [(str(task.get("id") or ""), task) for task in normalized_tasks],
        )
        if status_blockers:
            return False, {
                "status": 409,
                "error_code": "SAMPLE_STATUS_NOT_SELECTABLE",
                "error": "样机状态不可选：只有闲置样机可以加入测试任务，已拒绝保存。",
                "samples": status_blockers,
                "server_revision": current_revision,
            }

        for task in normalized_tasks:
            device_failure = device_tasks.prepare_task_devices(conn, task, {}, action,
                now=ctx.now_iso(), user=str(payload.get("user") or ""), proposed_tasks=normalized_tasks)
            if device_failure:
                return False, {**device_failure, "server_revision": current_revision}

        for task in normalized_tasks:
            record_writers.upsert_task_record(
                conn,
                task,
                project_id,
                stage_id,
                create_if_missing=True,
            )

        new_revision, updated_at = _bump_revision_and_audit(
            ctx,
            conn,
            current_revision=current_revision,
            action=action,
            remark=str(payload.get("remark") or f"批量任务增量变更：{len(normalized_tasks)} 个"),
            user=str(payload.get("user") or ""),
            client_ip=client_ip,
        )
        affected = mutation_summary.build_mutation_affected_summary(
            conn,
            project_ids=[project_id],
            stage_ids=[stage_id],
            task_ids=[task.get("id") for task in normalized_tasks],
            sample_ids=[
                sample_id
                for task in normalized_tasks
                for sample_id in (task.get("sampleIds") or [])
            ],
        )
        conn.commit()

    return True, {"revision": new_revision, "updated_at": updated_at, "count": len(normalized_tasks), "affected": affected}
