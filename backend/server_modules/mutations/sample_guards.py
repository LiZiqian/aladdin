"""样机销毁、事件归属与样机池边界校验。
只读取连接并返回错误描述；不得写数据或打开新的事务。分页客户端不能证明完整归属。"""
from __future__ import annotations

import sqlite3

from server_modules import (
    record_writers,
    status_normalization,
    task_mutation_rules,
    task_queries,
    task_reservations,
)


def _sample_archive_occupancy_failure(conn: sqlite3.Connection, samples: list[dict]) -> dict | None:
    """Archive edits cannot release a task that is executing or blocked.

    Read all projects under the caller's write lock; client currentTaskId alone
    is not evidence of occupancy. Future reservations must still allow an
    analysis sample to return; the write service then restores its queued usage.
    """
    reservations = task_reservations.open_reservations(conn, [s.get("id") for s in samples])
    for sample in samples:
        usage = task_reservations.primary_reservation([
            item for item in reservations.get(str(sample.get("id")), [])
            if item["status"] in task_reservations.EXECUTING
        ])
        if not usage:
            continue
        expected = {
            "status": "测试中" if usage["status"] == "进行中" else "在位等待",
            "currentTaskId": usage["taskId"], "currentProjectId": usage["projectId"],
            "currentStageId": usage["stageId"], "currentTestItem": usage["testItem"],
        }
        if any(key in sample and sample[key] != value for key, value in expected.items()):
            return {"status": 409, "error_code": "SAMPLE_TASK_OCCUPIED", "sampleId": sample.get("id"),
                    "taskId": usage["taskId"],
                    "error": "样机正被任务占用；请通过任务结束或变更来释放，不能在档案中直接修改状态或任务关联。"}
    return None


def _sample_destroy_scope_failure(
    conn: sqlite3.Connection,
    *,
    sample_ids: set[str],
    task_mutations: object,
) -> dict | None:
    """Reject destructive writes unless every live task reference is removed."""
    placeholders = ",".join("?" for _ in sample_ids)
    rows = conn.execute(
        f"""
        SELECT DISTINCT t.id, t.project_id, t.stage_id, t.flow_status, t.sample_ids_json
        FROM project_task_samples AS pts
        JOIN project_tasks AS t ON t.id = pts.task_id
        WHERE pts.sample_id IN ({placeholders})
          AND t.deleted_at IS NULL
          AND t.flow_status NOT IN ('正常完成', '异常终止')
          AND {task_queries.task_visibility_sql('t.data_json')}
        """,
        tuple(sorted(sample_ids)),
    ).fetchall() if sample_ids else []
    current_tasks = {str(row["id"]): row for row in rows}
    expected = {
        str(row["id"] or ""): (
            str(row["project_id"] or ""),
            str(row["stage_id"] or ""),
        )
        for row in rows
        if str(row["id"] or "")
    }

    supplied: dict[str, dict] = {}
    if not isinstance(task_mutations, list):
        task_mutations = []
    for item in task_mutations:
        if not isinstance(item, dict) or not isinstance(item.get("task"), dict):
            continue
        task = item["task"]
        task_id = str(item.get("taskId") or task.get("id") or "")
        if not task_id or task_id in supplied:
            return {
                "status": 409,
                "error_code": "SAMPLE_DESTROY_SCOPE_CHANGED",
                "error": "样机占用关系已变化或任务联动载荷不完整，已拒绝销毁。",
            }
        supplied[task_id] = item

    if set(supplied) != set(expected):
        return {
            "status": 409,
            "error_code": "SAMPLE_DESTROY_SCOPE_CHANGED",
            "error": "样机占用关系已变化或任务联动载荷不完整，已拒绝销毁。",
            "missingTaskIds": sorted(set(expected) - set(supplied)),
            "unexpectedTaskIds": sorted(set(supplied) - set(expected)),
        }

    for task_id, item in supplied.items():
        task = item["task"]
        project_id = str(item.get("projectId") or task.get("projectId") or "")
        stage_id = str(item.get("stageId") or task.get("stageId") or "")
        if str(task.get("id") or "") != task_id or (project_id, stage_id) != expected[task_id]:
            return {
                "status": 409,
                "error_code": "SAMPLE_DESTROY_SCOPE_CHANGED",
                "error": "任务归属与当前样机占用关系不一致，已拒绝销毁。",
                "taskId": task_id,
            }
        remaining_ids = set(task_mutation_rules.task_sample_ids(task))
        dangling_ids = remaining_ids & sample_ids
        if dangling_ids:
            return {
                "status": 409,
                "error_code": "SAMPLE_DESTROY_SCOPE_CHANGED",
                "error": "任务联动结果仍引用待销毁样机，已拒绝销毁。",
                "taskId": task_id,
                "sampleIds": sorted(dangling_ids),
            }
        current = current_tasks[task_id]
        executing = str(current["flow_status"] or "") in ("进行中", "阻塞中")
        expected_ids = set() if executing else set(record_writers.json_obj(current["sample_ids_json"], []) or []) - sample_ids
        expected_status = "异常终止" if executing else "待下发"
        if remaining_ids != expected_ids or status_normalization.normalize_task_flow_status(task) != expected_status:
            return {
                "status": 409,
                "error_code": "SAMPLE_DESTROY_SCOPE_CHANGED",
                "error": "样机销毁的任务联动与当前分配或状态不一致，已拒绝保存。",
                "taskId": task_id,
                "expectedSampleIds": sorted(expected_ids),
                "expectedStatus": expected_status,
            }
        from server_modules import device_tasks
        previous = task_mutation_rules.existing_task(conn, task_id) or {}
        device_failure = device_tasks.prepare_task_devices(conn, task, previous,
            "archive_task_delete" if executing else "set_task_plan", now=record_writers.now_iso())
        if device_failure:
            return device_failure
    return None


def _project_delete_sample_scope_failure(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    samples: object,
) -> dict | None:
    """Require a complete, current sample-release payload before deleting a project."""
    rows = conn.execute(
        f"""
        SELECT DISTINCT pts.sample_id
        FROM project_task_samples AS pts
        JOIN project_tasks AS t ON t.id = pts.task_id
        WHERE t.project_id = ?
          AND t.deleted_at IS NULL
          AND t.flow_status NOT IN ('正常完成', '异常终止')
          AND {task_queries.task_visibility_sql('t.data_json')}
        """,
        (project_id,),
    ).fetchall()
    expected_ids = {str(row["sample_id"] or "") for row in rows if str(row["sample_id"] or "")}

    supplied: dict[str, dict] = {}
    if not isinstance(samples, list):
        samples = []
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        sample_id = str(sample.get("id") or "")
        if not sample_id or sample_id in supplied:
            return {
                "status": 409,
                "error_code": "PROJECT_DELETE_SAMPLE_SCOPE_CHANGED",
                "error": "项目关联样机已变化或释放载荷不完整，已拒绝删除项目。",
            }
        supplied[sample_id] = sample

    if set(supplied) != expected_ids:
        return {
            "status": 409,
            "error_code": "PROJECT_DELETE_SAMPLE_SCOPE_CHANGED",
            "error": "项目关联样机已变化或释放载荷不完整，已拒绝删除项目。",
            "missingSampleIds": sorted(expected_ids - set(supplied)),
            "unexpectedSampleIds": sorted(set(supplied) - expected_ids),
        }

    if not expected_ids:
        return None

    placeholders = ",".join("?" for _ in expected_ids)
    existing_rows = conn.execute(
        f"SELECT id FROM sample_records WHERE id IN ({placeholders}) AND deleted_at IS NULL",
        tuple(sorted(expected_ids)),
    ).fetchall()
    existing_ids = {str(row["id"] or "") for row in existing_rows}
    if existing_ids != expected_ids:
        return {
            "status": 409,
            "error_code": "PROJECT_DELETE_SAMPLE_SCOPE_CHANGED",
            "error": "项目关联的样机档案不存在或已变化，已拒绝删除项目。",
            "missingSampleIds": sorted(expected_ids - existing_ids),
        }

    # The client may not have loaded reservations in other projects. Ignore its
    # guessed release status; derive usage after deletion inside this transaction.
    return None


def _sample_event_conflict_failure(conn: sqlite3.Connection, sample_events: object) -> dict | None:
    """Allow idempotent event replay but never permit an event ID to change history."""
    if not isinstance(sample_events, list):
        return None
    incoming_by_id: dict[str, dict] = {}
    for event in sample_events:
        if not isinstance(event, dict):
            continue
        event_id = str(event.get("id") or "")
        if not event_id:
            continue
        normalized = event
        normalized["id"] = event_id
        prior = incoming_by_id.get(event_id)
        if prior is not None and prior != normalized:
            return {
                "status": 409,
                "error_code": "SAMPLE_EVENT_IMMUTABLE",
                "error": "同一批次包含内容不同的同 ID 样机事件，已拒绝写入。",
                "eventId": event_id,
            }
        incoming_by_id[event_id] = normalized

    for event_id, incoming in incoming_by_id.items():
        row = conn.execute(
            "SELECT data_json FROM sample_events WHERE id = ?",
            (event_id,),
        ).fetchone()
        if not row:
            continue
        existing = record_writers.json_obj(row["data_json"], {})
        if existing != incoming:
            return {
                "status": 409,
                "error_code": "SAMPLE_EVENT_IMMUTABLE",
                "error": "样机历史事件不可修改；检测到同 ID 事件内容发生变化。",
                "eventId": event_id,
            }
    return None


def _sample_event_scope_failure(
    conn: sqlite3.Connection,
    sample_events: object,
    *,
    allowed_sample_ids: set[str],
    expected_project_id: str = "",
    expected_stage_id: str = "",
    allow_missing_sample_ids: set[str] | None = None,
) -> dict | None:
    """Validate new non-task sample events before they enter shared history."""
    if sample_events is None:
        return None
    if not isinstance(sample_events, list):
        return {"status": 400, "error": "sampleEvents 必须是数组"}
    allow_missing_sample_ids = allow_missing_sample_ids or set()
    event_ids = {
        str(event.get("id") or "")
        for event in sample_events
        if isinstance(event, dict) and str(event.get("id") or "")
    }
    existing_event_ids: set[str] = set()
    if event_ids:
        placeholders = ",".join("?" for _ in event_ids)
        rows = conn.execute(
            f"SELECT id FROM sample_events WHERE id IN ({placeholders})",
            tuple(sorted(event_ids)),
        ).fetchall()
        existing_event_ids = {str(row["id"] or "") for row in rows}

    for event in sample_events:
        if not isinstance(event, dict):
            return {"status": 400, "error": "sampleEvents 中每一项都必须是 JSON 对象"}
        event_id = str(event.get("id") or "")
        if event_id and event_id in existing_event_ids:
            continue
        sample_id = str(event.get("sampleId") or "")
        if not sample_id or sample_id not in allowed_sample_ids:
            return {
                "status": 409,
                "error_code": "SAMPLE_EVENT_SCOPE_CONFLICT",
                "error": "样机事件超出本次变更允许写入的样机范围，已拒绝保存。",
                "eventId": event_id,
                "sampleId": sample_id,
            }
        if sample_id not in allow_missing_sample_ids:
            sample_row = conn.execute(
                "SELECT 1 FROM sample_records WHERE id = ? AND deleted_at IS NULL",
                (sample_id,),
            ).fetchone()
            if not sample_row:
                return {
                    "status": 409,
                    "error_code": "SAMPLE_EVENT_SCOPE_CONFLICT",
                    "error": "样机事件引用的样机档案不存在，已拒绝保存。",
                    "eventId": event_id,
                    "sampleId": sample_id,
                }

        project_id = str(event.get("projectId") or "")
        stage_id = str(event.get("stageId") or "")
        task_id = str(event.get("taskId") or "")
        if task_id:
            task_row = conn.execute(
                "SELECT project_id, stage_id FROM project_tasks WHERE id = ? AND deleted_at IS NULL",
                (task_id,),
            ).fetchone()
            if not task_row:
                return {
                    "status": 409,
                    "error_code": "SAMPLE_EVENT_OWNERSHIP_CONFLICT",
                    "error": "样机事件引用的任务不存在或已删除，已拒绝保存。",
                    "eventId": event_id,
                    "taskId": task_id,
                }
            actual_project_id = str(task_row["project_id"] or "")
            actual_stage_id = str(task_row["stage_id"] or "")
            if (project_id and project_id != actual_project_id) or (stage_id and stage_id != actual_stage_id):
                return {
                    "status": 409,
                    "error_code": "SAMPLE_EVENT_OWNERSHIP_CONFLICT",
                    "error": "样机事件的项目或阶段与任务归属不一致，已拒绝保存。",
                    "eventId": event_id,
                    "taskId": task_id,
                }
            project_id = actual_project_id
            stage_id = actual_stage_id
        elif stage_id:
            stage_row = conn.execute(
                "SELECT project_id FROM project_stages WHERE id = ? AND deleted_at IS NULL",
                (stage_id,),
            ).fetchone()
            if not stage_row:
                return {
                    "status": 409,
                    "error_code": "SAMPLE_EVENT_OWNERSHIP_CONFLICT",
                    "error": "样机事件引用的阶段不存在或已删除，已拒绝保存。",
                    "eventId": event_id,
                    "stageId": stage_id,
                }
            actual_project_id = str(stage_row["project_id"] or "")
            if project_id and project_id != actual_project_id:
                return {
                    "status": 409,
                    "error_code": "SAMPLE_EVENT_OWNERSHIP_CONFLICT",
                    "error": "样机事件的项目与阶段归属不一致，已拒绝保存。",
                    "eventId": event_id,
                    "stageId": stage_id,
                }
            project_id = actual_project_id

        if expected_project_id and project_id and project_id != expected_project_id:
            return {
                "status": 409,
                "error_code": "SAMPLE_EVENT_OWNERSHIP_CONFLICT",
                "error": "样机事件不属于本次项目变更，已拒绝保存。",
                "eventId": event_id,
            }
        if expected_stage_id and stage_id and stage_id != expected_stage_id:
            return {
                "status": 409,
                "error_code": "SAMPLE_EVENT_OWNERSHIP_CONFLICT",
                "error": "样机事件不属于本次阶段变更，已拒绝保存。",
                "eventId": event_id,
            }
        if expected_project_id:
            project_id = expected_project_id
        if expected_stage_id:
            stage_id = expected_stage_id
        if project_id:
            project_row = conn.execute(
                "SELECT 1 FROM project_records WHERE id = ? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()
            if not project_row:
                return {
                    "status": 409,
                    "error_code": "SAMPLE_EVENT_OWNERSHIP_CONFLICT",
                    "error": "样机事件引用的项目不存在或已删除，已拒绝保存。",
                    "eventId": event_id,
                    "projectId": project_id,
                }
        event["projectId"] = project_id
        event["stageId"] = stage_id
    return None


def _category_sample_scope_failure(conn: sqlite3.Connection, category_id: str, samples: list[dict]) -> dict | None:
    """A pool operation can only create or edit samples belonging to that pool."""
    ids = [str(sample.get("id") or "") for sample in samples]
    existing_categories = {}
    for offset in range(0, len(ids), 400):
        batch = ids[offset:offset + 400]
        placeholders = ",".join("?" for _ in batch)
        existing_categories.update((str(row["id"]), str(row["category_id"])) for row in conn.execute(
            f"SELECT id, category_id FROM sample_records WHERE id IN ({placeholders}) AND deleted_at IS NULL", batch
        ))
    for sample in samples:
        sample_id = str(sample.get("id") or "")
        claimed_category = str(sample.get("categoryId") or category_id)
        actual_category = existing_categories.get(sample_id, category_id)
        if claimed_category != category_id or actual_category != category_id:
            return {
                "status": 409, "error_code": "SAMPLE_CATEGORY_SCOPE_CONFLICT",
                "error": "样机不属于当前样机池，已拒绝跨池写入。",
                "sampleId": sample_id, "categoryId": category_id,
                "actualCategoryId": actual_category, "bodyCategoryId": claimed_category,
            }
    return None
