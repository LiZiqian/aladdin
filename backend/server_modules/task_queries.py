from __future__ import annotations

import json
import sqlite3

from server_modules import sample_queries, status_normalization, task_reservations


def json_obj(text: str | None, fallback: object | None = None):
    try:
        return json.loads(text or "")
    except Exception:
        return fallback


def first_query_value(query: dict[str, list[str]], name: str, default: str = "") -> str:
    values = query.get(name)
    if not values:
        return default
    return str(values[0] if values[0] is not None else default)


def to_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_page_params(query: dict[str, list[str]], *, default_size: int = 100, max_size: int = 500) -> tuple[int, int]:
    page = to_int(first_query_value(query, "page", "1"), 1)
    page_size = to_int(first_query_value(query, "pageSize", str(default_size)), default_size)
    page = max(1, page)
    page_size = max(1, min(max_size, page_size))
    return page, page_size


def paginate_list(items: list[dict], page: int, page_size: int) -> tuple[list[dict], dict]:
    total = len(items)
    total_pages = max(1, (total + page_size - 1) // page_size)
    page = min(max(1, page), total_pages)
    start = (page - 1) * page_size
    end = start + page_size
    return items[start:end], {
        "page": page,
        "pageSize": page_size,
        "total": total,
        "totalPages": total_pages,
    }


def task_flow_status(task: dict) -> str:
    return status_normalization.normalize_task_flow_status(task)


def person_name_from_text(text: object) -> str:
    raw = str(text or "").strip()
    if "/" in raw:
        return raw.split("/", 1)[0].strip()
    return raw


def task_result_outcome_tokens(task: dict) -> list[str]:
    tokens: list[str] = []

    def add(value: object) -> None:
        result = status_normalization.normalize_task_result_value(value)
        if result == "通过":
            tokens.extend(["通过", "PASS"])
        elif result == "不通过":
            tokens.extend(["不通过", "FAIL"])

    add(task.get("latestResult"))
    add(task.get("result"))
    draft = task.get("resultDraft") if isinstance(task.get("resultDraft"), dict) else {}
    add(draft.get("result"))
    for upload in task.get("resultUploads") or []:
        if isinstance(upload, dict):
            add(upload.get("result"))
    return tokens


def task_search_text(task: dict, progress: dict | None = None) -> str:
    issue = task.get("issueRecord") if isinstance(task.get("issueRecord"), dict) else {}
    chunks = [
        task.get("category"),
        task.get("testItem"),
        task.get("owner"),
        issue.get("dtsNo"),
        issue.get("issueNote"),
        task.get("latestResult"),
        task.get("result"),
        task.get("resultSummary"),
        task.get("completionType"),
    ]
    chunks.extend(task_result_outcome_tokens(task))
    if progress:
        chunks.extend([progress.get("category"), progress.get("testItem")])
    for upload in task.get("resultUploads") or []:
        if isinstance(upload, dict):
            chunks.extend([upload.get("reason"), upload.get("summary"), upload.get("result")])
    for fault in task.get("sampleFaultRecords") or []:
        if isinstance(fault, dict):
            chunks.extend([fault.get("problem"), fault.get("sampleNo"), fault.get("sn"), fault.get("imei")])
    return " ".join(str(x or "") for x in chunks).lower()


def task_matches_query(task: dict, progress: dict | None, query: dict[str, list[str]]) -> bool:
    sku = first_query_value(query, "sku", "")
    sku_value = task.get("skuIndex")
    if sku_value is None:
        sku_value = (progress or {}).get("skuIndex")
    sku_index = str(sku_value) if sku_value is not None else ""
    if sku and sku != sku_index:
        return False

    flow_status = first_query_value(query, "flowStatus", "")
    if flow_status and task_flow_status(task) != status_normalization.normalize_task_flow_status(flow_status):
        return False

    owner_name = first_query_value(query, "ownerName", "").strip()
    owner = str(task.get("owner") or "").strip()
    if owner_name and owner_name not in (owner, person_name_from_text(owner)):
        return False

    category_kw = first_query_value(query, "categoryKeyword", "").strip().lower()
    category = str(task.get("category") or (progress or {}).get("category") or "").lower()
    if category_kw and category_kw not in category:
        return False

    case_kw = first_query_value(query, "caseKeyword", "").strip().lower()
    test_item = str(task.get("testItem") or (progress or {}).get("testItem") or "").lower()
    if case_kw and case_kw not in test_item:
        return False

    dts_kw = first_query_value(query, "dtsKeyword", "").strip().lower()
    issue = task.get("issueRecord") if isinstance(task.get("issueRecord"), dict) else {}
    if dts_kw and dts_kw not in str(issue.get("dtsNo") or "").lower():
        return False

    result_kw = first_query_value(query, "resultKeyword", "").strip().lower()
    if result_kw and result_kw not in task_search_text(task, progress):
        return False

    return True


def query_value_present(query: dict[str, list[str]], name: str) -> bool:
    return bool(first_query_value(query, name, "").strip())


def task_query_requires_python_scan(query: dict[str, list[str]]) -> bool:
    return any(query_value_present(query, key) for key in ("categoryKeyword", "caseKeyword", "dtsKeyword", "resultKeyword"))


def task_visibility_sql(column: str = "data_json") -> str:
    """Hide archived tasks in workspaces while retaining their history rows."""
    document = f"CASE WHEN json_valid({column}) THEN {column} ELSE '{{}}' END"
    return f"COALESCE(json_extract({document}, '$.archived'), 0) = 0 AND COALESCE(json_extract({document}, '$.deletedAt'), '') = ''"


def task_archived_sql(column: str = "data_json") -> str:
    document = f"CASE WHEN json_valid({column}) THEN {column} ELSE '{{}}' END"
    return f"COALESCE(json_extract({document}, '$.archived'), 0) <> 0"


def task_sql_filter_parts(stage_id: str, query: dict[str, list[str]], *, include_flow_status: bool = True) -> tuple[list[str], list[object]]:
    where = ["stage_id = ?", "deleted_at IS NULL", task_visibility_sql()]
    args: list[object] = [stage_id]
    sku = first_query_value(query, "sku", "")
    if sku:
        where.append("sku_index = ?")
        args.append(to_int(sku, 0))
    owner_name = first_query_value(query, "ownerName", "").strip()
    if owner_name:
        where.append("(TRIM(owner) = ? OR INSTR(TRIM(owner), ?) = 1)")
        args.extend([owner_name, f"{owner_name}/"])
    if include_flow_status:
        flow_status = first_query_value(query, "flowStatus", "").strip()
        if flow_status:
            where.append("flow_status = ?")
            args.append(status_normalization.normalize_task_flow_status(flow_status))
    return where, args


def task_from_db_row(row: sqlite3.Row) -> dict:
    task = status_normalization.normalize_task_payload(json_obj(row["data_json"], {}) or {})
    sample_ids = json_obj(row["sample_ids_json"], [])
    if not isinstance(sample_ids, list):
        sample_ids = []
    task.update({
        "id": row["id"],
        "projectId": row["project_id"],
        "stageId": row["stage_id"],
        "progressId": row["progress_id"] or task.get("progressId") or "",
        "category": row["category"] or task.get("category") or "",
        "testItem": row["test_item"] or task.get("testItem") or "",
        "skuIndex": to_int(row["sku_index"] if row["sku_index"] is not None else task.get("skuIndex")),
        "status": status_normalization.normalize_task_stored_status({
            "status": row["status"] or task.get("status") or "",
            "completed": task.get("completed"),
        }),
        "owner": row["owner"] or task.get("owner") or "",
        "sampleIds": sample_ids,
    })
    if row["completed_at"] and not task.get("completedAt"):
        task["completedAt"] = row["completed_at"]
    flow_status = task_flow_status(task)
    task["completed"] = flow_status in ("正常完成", "异常终止")
    if task["completed"]:
        task["completionType"] = flow_status
    return task


def task_sample_reference_ids(task: dict) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()

    def add(value: object) -> None:
        sid = str(value or "").strip()
        if sid and sid not in seen:
            seen.add(sid)
            ids.append(sid)

    for sample_id in task.get("sampleIds") or []:
        add(sample_id)
    for record in task.get("removedSampleRecords") or []:
        if isinstance(record, dict):
            add(record.get("sampleId") or record.get("sid"))
    for record in task.get("sampleFaultRecords") or []:
        if isinstance(record, dict):
            add(record.get("sampleId") or record.get("sid"))
    for draft_item in (task.get("resultDraft") or {}).get("samples") or []:
        if isinstance(draft_item, dict):
            add(draft_item.get("sampleId") or draft_item.get("sid"))
    for upload in task.get("resultUploads") or []:
        if not isinstance(upload, dict):
            continue
        for item in upload.get("samples") or []:
            if isinstance(item, dict):
                add(item.get("sampleId") or item.get("sid"))
    for log in task.get("logs") or []:
        if not isinstance(log, dict):
            continue
        for ref in log.get("sampleRefs") or []:
            if isinstance(ref, dict):
                add(ref.get("sampleId") or ref.get("sid"))
    return ids


def attach_task_sample_snapshots(conn: sqlite3.Connection, tasks: list[dict]) -> list[dict]:
    sample_ids: list[str] = []
    seen: set[str] = set()
    for task in tasks:
        if not isinstance(task, dict):
            continue
        for sample_id in task_sample_reference_ids(task):
            if sample_id not in seen:
                seen.add(sample_id)
                sample_ids.append(sample_id)
    if not sample_ids:
        return tasks

    placeholders = ",".join("?" for _ in sample_ids)
    rows = conn.execute(
        f"""
        SELECT sr.id, sr.category_id, sr.sample_no, sr.sn, sr.imei, sr.board_sn,
               sr.data_json, sr.updated_at, sc.name AS category_name
        FROM sample_records sr
        LEFT JOIN sample_categories sc ON sc.id = sr.category_id
        WHERE sr.id IN ({placeholders}) AND sr.deleted_at IS NULL
        """,
        sample_ids,
    ).fetchall()
    snapshots: dict[str, dict] = {}
    for row in rows:
        data = json_obj(row["data_json"], {}) or {}
        sample_no = row["sample_no"] or data.get("sampleNo") or data.get("code") or row["id"]
        snapshots[str(row["id"])] = {
            "id": row["id"],
            "categoryId": row["category_id"] or data.get("categoryId") or "",
            "categoryName": row["category_name"] or data.get("_categoryName") or data.get("categoryName") or "",
            "code": data.get("code") or sample_no,
            "sampleNo": sample_no,
            "sn": row["sn"] or data.get("sn") or "",
            "imei": row["imei"] or data.get("imei") or "",
            "boardSn": row["board_sn"] or data.get("boardSn") or "",
            "updatedAt": row["updated_at"] or data.get("updatedAt") or "",
        }

    for task in tasks:
        if not isinstance(task, dict):
            continue
        current = task.get("sampleSnapshots")
        if not isinstance(current, dict):
            current = {}
            task["sampleSnapshots"] = current
        for sample_id in task_sample_reference_ids(task):
            existing = current.get(sample_id) if isinstance(current.get(sample_id), dict) else {}
            fresh = snapshots.get(sample_id)
            if fresh:
                merged = {**existing, **fresh}
                # Import rewrites storage timestamps even when sample identity
                # is unchanged. Keep the recorded snapshot time in that case,
                # so reading it cannot create a spurious V2 re-import conflict.
                if existing.get("updatedAt") and all(
                        existing.get(key) == value for key, value in fresh.items() if key != "updatedAt"):
                    merged["updatedAt"] = existing["updatedAt"]
                if existing.get("destroyedAt"):
                    merged["destroyedAt"] = existing.get("destroyedAt")
                current[sample_id] = merged
            elif existing:
                current[sample_id] = existing
    return tasks


def load_task_logs_for(conn: sqlite3.Connection, task_ids: list[str]) -> dict[str, list[dict]]:
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    rows = conn.execute(
        f"""
        SELECT task_id, data_json
        FROM task_logs
        WHERE task_id IN ({placeholders})
        ORDER BY julianday(time), id
        """,
        task_ids,
    ).fetchall()
    logs_by_task: dict[str, list[dict]] = {}
    for row in rows:
        log = json_obj(row["data_json"], None)
        if isinstance(log, dict):
            logs_by_task.setdefault(row["task_id"], []).append(log)
    return logs_by_task


def list_stage_tasks_page(conn: sqlite3.Connection, stage_id: str, query: dict[str, list[str]]) -> dict:
    page, page_size = parse_page_params(query, default_size=100, max_size=500)
    stage_row = conn.execute(
        """
        SELECT id, project_id, name, data_json
        FROM project_stages
        WHERE id = ? AND deleted_at IS NULL
        """,
        (stage_id,),
    ).fetchone()
    if not stage_row:
        raise KeyError("阶段不存在")

    stage = json_obj(stage_row["data_json"], {}) or {}
    progress_items = stage.get("progress") if isinstance(stage.get("progress"), list) else []
    progress_by_id = {str(p.get("id")): p for p in progress_items if isinstance(p, dict) and p.get("id")}
    # A selected filter must not remove the other people from its own dropdown.
    # This stays within the stage/owner index and does not hydrate task JSON.
    owner_names = [str(row["owner"]) for row in conn.execute(
        f"""SELECT DISTINCT owner FROM project_tasks
            WHERE stage_id = ? AND deleted_at IS NULL AND {task_visibility_sql()}
              AND TRIM(COALESCE(owner, '')) <> '' ORDER BY owner""", (stage_id,)
    )]

    if not task_query_requires_python_scan(query):
        where, args = task_sql_filter_parts(stage_id, query, include_flow_status=True)
        base_where, base_args = task_sql_filter_parts(stage_id, query, include_flow_status=False)
        total = int(conn.execute(
            f"SELECT COUNT(*) AS count FROM project_tasks WHERE {' AND '.join(where)}",
            args,
        ).fetchone()["count"] or 0)
        base_total = int(conn.execute(
            f"SELECT COUNT(*) AS count FROM project_tasks WHERE {' AND '.join(base_where)}",
            base_args,
        ).fetchone()["count"] or 0)
        total_pages = max(1, (total + page_size - 1) // page_size)
        page = min(max(1, page), total_pages)
        offset = (page - 1) * page_size

        status_rows = conn.execute(
            f"""
            SELECT COALESCE(flow_status, '待下发') AS flow_status, COUNT(*) AS count
            FROM project_tasks
            WHERE {" AND ".join(base_where)}
            GROUP BY flow_status
            """,
            base_args,
        ).fetchall()
        status_counts = {str(row["flow_status"] or "待下发"): int(row["count"] or 0) for row in status_rows}

        rows = conn.execute(
            f"""
            SELECT id, project_id, stage_id, progress_id, category, test_item, sku_index, status, flow_status, owner,
                   sample_ids_json, data_json, completed_at
            FROM project_tasks
            WHERE {" AND ".join(where)}
            ORDER BY created_at, id
            LIMIT ? OFFSET ?
            """,
            [*args, page_size, offset],
        ).fetchall()

        page_rows: list[dict] = []
        for idx, row in enumerate(rows):
            task = task_from_db_row(row)
            progress = progress_by_id.get(str(task.get("progressId") or ""))
            page_rows.append({
                "key": task.get("id") or f"task_{idx}",
                "task": task,
                "progress": progress,
                "flowStatus": row["flow_status"] or task_flow_status(task),
            })

        logs_by_task = load_task_logs_for(conn, [str(row["task"].get("id")) for row in page_rows if row.get("task")])
        for row in page_rows:
            task = row.get("task") or {}
            task["logs"] = logs_by_task.get(str(task.get("id")), [])
        attach_task_sample_snapshots(conn, [row["task"] for row in page_rows if row.get("task")])

        return {
            "page": page,
            "pageSize": page_size,
            "total": total,
            "totalPages": total_pages,
            "stage": {
                "id": stage_row["id"],
                "projectId": stage_row["project_id"],
                "name": stage_row["name"] or stage.get("name") or "",
            },
            "stats": {
                "totalInStage": base_total,
                "filtered": total,
                "statusCounts": status_counts,
                "ownerNames": owner_names,
            },
            "rows": page_rows,
        }

    where = ["stage_id = ?", "deleted_at IS NULL", task_visibility_sql()]
    args: list[object] = [stage_id]
    sku = first_query_value(query, "sku", "")
    if sku:
        where.append("sku_index = ?")
        args.append(to_int(sku, 0))
    category_kw = first_query_value(query, "categoryKeyword", "").strip().lower()
    if category_kw:
        where.append("(COALESCE(category, '') = '' OR LOWER(category) LIKE ? OR LOWER(data_json) LIKE ?)")
        like = f"%{category_kw}%"
        args.extend([like, like])
    case_kw = first_query_value(query, "caseKeyword", "").strip().lower()
    if case_kw:
        where.append("(COALESCE(test_item, '') = '' OR LOWER(test_item) LIKE ? OR LOWER(data_json) LIKE ?)")
        like = f"%{case_kw}%"
        args.extend([like, like])
    owner_name = first_query_value(query, "ownerName", "").strip()
    if owner_name:
        where.append("(TRIM(owner) = ? OR INSTR(TRIM(owner), ?) = 1)")
        args.extend([owner_name, f"{owner_name}/"])

    rows = conn.execute(
        f"""
        SELECT id, project_id, stage_id, progress_id, category, test_item, sku_index, status, owner,
               sample_ids_json, data_json, completed_at
        FROM project_tasks
        WHERE {" AND ".join(where)}
        ORDER BY created_at, id
        """,
        args,
    ).fetchall()

    all_rows: list[dict] = []
    status_counts: dict[str, int] = {}
    base_query = {key: value for key, value in query.items() if key != "flowStatus"}
    base_total = 0
    for idx, row in enumerate(rows):
        task = task_from_db_row(row)
        progress = progress_by_id.get(str(task.get("progressId") or ""))
        if not task_matches_query(task, progress, base_query):
            continue
        base_total += 1
        flow_status = task_flow_status(task)
        status_counts[flow_status] = status_counts.get(flow_status, 0) + 1
        if not task_matches_query(task, progress, query):
            continue
        all_rows.append({
            "key": task.get("id") or f"task_{idx}",
            "task": task,
            "progress": progress,
            "flowStatus": flow_status,
        })

    page_rows, meta = paginate_list(all_rows, page, page_size)
    logs_by_task = load_task_logs_for(conn, [str(row["task"].get("id")) for row in page_rows if row.get("task")])
    for row in page_rows:
        task = row.get("task") or {}
        task["logs"] = logs_by_task.get(str(task.get("id")), [])
    attach_task_sample_snapshots(conn, [row["task"] for row in page_rows if row.get("task")])

    return {
        **meta,
        "stage": {
            "id": stage_row["id"],
            "projectId": stage_row["project_id"],
            "name": stage_row["name"] or stage.get("name") or "",
        },
        "stats": {
            "totalInStage": base_total,
            "filtered": len(all_rows),
            "statusCounts": status_counts,
            "ownerNames": owner_names,
        },
        "rows": page_rows,
    }


def query_id_list(query: dict[str, list[str]], name: str, *, max_items: int = 500) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in query.get(name) or []:
        for part in str(raw or "").split(","):
            value = part.strip()
            if not value or value in seen:
                continue
            seen.add(value)
            result.append(value)
            if len(result) >= max_items:
                return result
    return result


def sample_candidate_keyword_where(keyword: str, *, negate: bool = False) -> tuple[str, list[object]]:
    keyword = keyword.lower()
    expr = """
        (INSTR(LOWER(COALESCE(r.sample_no, '')), ?) > 0 OR INSTR(LOWER(COALESCE(r.sn, '')), ?) > 0
         OR INSTR(LOWER(COALESCE(r.imei, '')), ?) > 0 OR INSTR(LOWER(COALESCE(r.owner, '')), ?) > 0
         OR INSTR(LOWER(COALESCE(r.borrower, '')), ?) > 0 OR INSTR(LOWER(COALESCE(r.location, '')), ?) > 0
         OR INSTR(LOWER(COALESCE(c.name, '')), ?) > 0 OR INSTR(LOWER(COALESCE(r.data_json, '')), ?) > 0)
    """
    if negate:
        expr = f"NOT {expr}"
    return expr, [keyword] * 8


def open_task_occupancy_for_sample_ids(conn: sqlite3.Connection, sample_ids: list[str], *, exclude_task_id: str = "") -> dict[str, list[dict]]:
    return task_reservations.open_reservations(conn, sample_ids, exclude_task_id=exclude_task_id)


def task_sample_candidate_from_row(row: sqlite3.Row) -> dict:
    sample = sample_queries.sample_from_db_row(row)
    sample["categoryName"] = row["category_name"] or ""
    sample["effectiveStatus"] = sample_queries.sample_effective_status(sample)
    sample["hasProblem"] = sample_queries.sample_has_problem(sample)
    return sample


def sample_record_status(sample: dict) -> str:
    return sample_queries.sample_effective_status(sample)


def decorate_task_sample_candidates(
    samples: list[dict],
    *,
    selected_ids: set[str],
    occupancy: dict[str, list[dict]],
    task: dict | None = None,
    assigned_ids: set[str] | None = None,
) -> list[dict]:
    for sample in samples:
        sid = str(sample.get("id") or "")
        selected = sid in selected_ids
        occupied_tasks = occupancy.get(sid, [])
        disabled_reason = task_reservations.sample_status_block_reason(sample, occupied_tasks, already_assigned=sid in (assigned_ids or set()))
        conflicts = []
        for other in occupied_tasks:
            reason = task_reservations.conflict_reason(task or {}, other)
            if reason:
                conflicts.append({**other, "reason": reason})
        if not disabled_reason and conflicts:
            other = conflicts[0]
            dates = task_reservations.plan_range(other)
            period = f"（{dates[0]} ~ {dates[1]}）" if dates else ""
            disabled_reason = f"{other['reason']}：{other.get('testItem') or '其他任务'}{period}"
        selectable = selected or not disabled_reason
        sample["alreadySelected"] = selected
        sample["selectable"] = selectable
        sample["disabledReason"] = "" if selected else disabled_reason
        sample["selectionConflict"] = disabled_reason
        sample["occupyingTasks"] = occupied_tasks
        sample["conflictingTasks"] = conflicts
        sample["reservationHint"] = "已预约其他时段，可错峰复用" if occupied_tasks and not disabled_reason else ""
    return samples


def list_task_sample_candidates_page(conn: sqlite3.Connection, query: dict[str, list[str]]) -> dict:
    page, page_size = parse_page_params(query, default_size=50, max_size=100)
    task_id = first_query_value(query, "taskId", "").strip()
    task_row = conn.execute("SELECT data_json FROM project_tasks WHERE id = ? AND deleted_at IS NULL", (task_id,)).fetchone() if task_id else None
    task = json_obj(task_row["data_json"], {}) if task_row else {}
    assigned_ids = {str(sid) for sid in task.get("sampleIds", [])}
    # Explicit draft dates take precedence, including empty values when cleared.
    if "planStartDate" in query:
        task["planStartDate"] = first_query_value(query, "planStartDate", "")
        task["planDate"] = ""
    if "planEndDate" in query:
        task["planEndDate"] = first_query_value(query, "planEndDate", "")
        task["endDate"] = ""
    selected_ids = query_id_list(query, "selectedIds", max_items=500)
    selected_set = set(selected_ids)
    category_id = first_query_value(query, "categoryId", "").strip()
    keyword = first_query_value(query, "keyword", "").strip().lower()
    exclude_keyword = first_query_value(query, "excludeKeyword", "").strip().lower()
    status = first_query_value(query, "status", "").strip()
    status = sample_queries.sample_effective_status({"status": status}) if status else ""
    problem_state = sample_queries.sample_problem_state(query)
    reassembly_state = sample_queries.sample_reassembly_state(query)

    categories = sample_queries.list_sample_categories_summary(conn)
    where = ["r.deleted_at IS NULL", "c.deleted_at IS NULL"]
    args: list[object] = []
    if category_id:
        where.append("r.category_id = ?")
        args.append(category_id)
    if selected_ids:
        placeholders = ",".join("?" for _ in selected_ids)
        where.append(f"r.id NOT IN ({placeholders})")
        args.extend(selected_ids)
    if status:
        where.append(f"{sample_queries.sample_usage_status_sql_expr('r.status')} = ?")
        args.append(status)
    if problem_state:
        where.append("r.has_problem = ?")
        args.append(1 if problem_state == "fault" else 0)
    if reassembly_state:
        where.append("COALESCE(r.is_reassembled, 0) = ?")
        args.append(1 if reassembly_state == "reassembled" else 0)
    if keyword:
        expr, expr_args = sample_candidate_keyword_where(keyword)
        where.append(expr)
        args.extend(expr_args)
    if exclude_keyword:
        expr, expr_args = sample_candidate_keyword_where(exclude_keyword, negate=True)
        where.append(expr)
        args.extend(expr_args)

    total = int(conn.execute(
        f"""
        SELECT COUNT(*) AS count
        FROM sample_records r
        JOIN sample_categories c ON c.id = r.category_id
        WHERE {" AND ".join(where)}
        """,
        args,
    ).fetchone()["count"] or 0)
    total_pages = max(1, (total + page_size - 1) // page_size)
    page = min(max(1, page), total_pages)
    offset = (page - 1) * page_size

    rows = conn.execute(
        f"""
        SELECT r.id, r.category_id, c.name AS category_name,
               r.sample_no, r.sn, r.imei, r.board_sn, r.is_reassembled, r.status, r.has_problem, r.effective_status,
               r.location, r.owner, r.borrower, r.data_json
        FROM sample_records r
        JOIN sample_categories c ON c.id = r.category_id
        WHERE {" AND ".join(where)}
        ORDER BY c.sort_order, c.id, r.created_at, r.id
        LIMIT ? OFFSET ?
        """,
        [*args, page_size, offset],
    ).fetchall()
    items = [task_sample_candidate_from_row(row) for row in rows]

    selected_items: list[dict] = []
    if selected_ids:
        placeholders = ",".join("?" for _ in selected_ids)
        selected_rows = conn.execute(
            f"""
            SELECT r.id, r.category_id, c.name AS category_name,
                   r.sample_no, r.sn, r.imei, r.board_sn, r.is_reassembled, r.status, r.has_problem, r.effective_status,
                   r.location, r.owner, r.borrower, r.data_json
            FROM sample_records r
            JOIN sample_categories c ON c.id = r.category_id
            WHERE r.deleted_at IS NULL AND c.deleted_at IS NULL AND r.id IN ({placeholders})
            ORDER BY c.sort_order, c.id, r.created_at, r.id
            """,
            selected_ids,
        ).fetchall()
        selected_by_id = {str(row["id"] or ""): task_sample_candidate_from_row(row) for row in selected_rows}
        selected_items = [selected_by_id[sid] for sid in selected_ids if sid in selected_by_id]
    selected_found_ids = {str(item.get("id") or "") for item in selected_items}
    selected_missing_ids = [sid for sid in selected_ids if sid not in selected_found_ids]

    sample_queries.attach_sample_tested_item_names(conn, [*items, *selected_items])
    all_candidate_ids = [str(item.get("id") or "") for item in [*items, *selected_items]]
    occupancy = open_task_occupancy_for_sample_ids(conn, all_candidate_ids, exclude_task_id=task_id)
    decorate_task_sample_candidates(items, selected_ids=selected_set, occupancy=occupancy, task=task, assigned_ids=assigned_ids)
    decorate_task_sample_candidates(selected_items, selected_ids=selected_set, occupancy=occupancy, task=task, assigned_ids=assigned_ids)

    return {
        "page": page,
        "pageSize": page_size,
        "total": total,
        "totalPages": total_pages,
        "items": items,
        "selectedItems": selected_items,
        "selectedMissingIds": selected_missing_ids,
        "selectedCount": len(selected_ids),
        "categories": categories,
        "filters": {
            "taskId": task_id,
            "categoryId": category_id,
            "keyword": keyword,
            "excludeKeyword": exclude_keyword,
            "status": status,
            "problemState": problem_state,
            "reassembled": reassembly_state,
        },
    }
