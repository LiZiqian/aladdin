"""Equipment assignment, dated reservations and immutable usage evidence.

All validation and writes run inside the caller's BEGIN IMMEDIATE transaction.
Equipment remains in warehouse JSON; open task JSON is the source of occupancy.
"""
from __future__ import annotations

import copy
import json
import re
import uuid
from time import time_ns

from server_modules import record_writers, status_normalization, task_queries, task_reservations


ASSIGNMENT_ACTIONS = {"create_task_config", "save_task_config", "temp_change_task", "create_tasks_batch"}
TRANSITIONS = {
    "start_task": ("start", "设备开始使用"), "restart_task": ("restart", "设备恢复使用"),
    "block_task": ("block", "设备阻塞"), "finish_task_result": ("release", "设备释放"),
    "archive_task_delete": ("release", "设备释放"),
}


def warehouse_devices(conn, warehouse=None):
    if warehouse is None:
        row = conn.execute("SELECT data_json FROM app_state WHERE id = 1").fetchone()
        state = json.loads(row[0]) if row else {}
        warehouse = state.get("deviceWarehouse") or {}
    result = {}
    for group in warehouse.get("groups") or []:
        for device in group.get("devices") or []:
            result[str(device.get("id") or "")] = (device, group)
    return result


def snapshot(device, group):
    return {"id": device["id"], "name": str(device.get("name") or ""),
            "code": str(device.get("code") or ""), "model": str(device.get("model") or ""),
            "groupId": str(group.get("id") or ""), "region": str(group.get("region") or ""),
            "department": str(group.get("department") or "")}


def open_tasks(conn):
    rows = conn.execute("SELECT id, project_id, stage_id, data_json FROM project_tasks "
                        "WHERE deleted_at IS NULL AND flow_status NOT IN ('正常完成', '异常终止') ORDER BY id")
    tasks = []
    for row in rows:
        task = json.loads(row["data_json"] or "{}")
        task.update(id=row["id"], projectId=row["project_id"], stageId=row["stage_id"])
        if task_reservations.is_open(task):
            tasks.append(task)
    return tasks


def decorate_warehouse(conn, warehouse):
    devices = warehouse_devices(conn, warehouse)
    if not devices:
        return warehouse
    refs = {}
    for task in open_tasks(conn):
        for device_id in task.get("deviceIds") or []:
            refs.setdefault(device_id, []).append(task_reservations.task_reference(task))
    for device_id, (device, _) in devices.items():
        uses = refs.get(device_id, [])
        current = [item for item in uses if item["status"] in task_reservations.EXECUTING]
        reserved = [item for item in uses if item["status"] == "待下发"]
        device["hasFault"] = bool(device.get("hasFault", False))
        device["faultNote"] = str(device.get("faultNote") or "")
        device["currentTasks"], device["reservations"] = current, reserved
        device["usageStatus"] = ("阻塞中" if any(item["status"] == "阻塞中" for item in current)
                                 else "使用中" if current else "已预约" if reserved else "闲置")
    return warehouse


def failure(code, message, **details):
    return {"status": 409, "error_code": code, "error": message, **details}


def device_ids_failure(ids):
    if (not isinstance(ids, list) or len(ids) > 100 or any(not isinstance(value, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value) for value in ids)
            or len(ids) != len(set(ids))):
        return {"status": 400, "error_code": "TASK_DEVICE_IDS_INVALID", "error": "测试设备须为不重复的设备 ID 数组（最多 100 台）。"}
    return None


def validate_state_device_assignments(data):
    """Final import gate over the complete candidate state, before any writes."""
    devices = warehouse_devices(None, data.get("deviceWarehouse") or {})
    tasks = []
    for project in data.get("projects") or []:
        for stage in project.get("stages") or []:
            for source in stage.get("tasks") or []:
                ids = source.get("deviceIds", [])
                invalid = device_ids_failure(ids)
                if invalid:
                    return invalid
                if not task_reservations.is_open(source):
                    continue
                task = {**source, "projectId": project.get("id"), "stageId": stage.get("id")}
                for device_id in ids:
                    found = devices.get(device_id)
                    reason = "设备不存在" if found is None else ""
                    if found and status_normalization.normalize_task_flow_status(task) == "进行中":
                        reason = "设备有故障" if found[0].get("hasFault") else "设备不可用" if found[0].get("status", "闲置") != "闲置" else ""
                    if reason:
                        return failure("DEVICE_NOT_AVAILABLE", "导入任务引用不可用的测试设备。", devices=[{"deviceId": device_id, "taskId": task.get("id"), "reason": reason}])
                tasks.append(task)
    occupied = {}
    for task in tasks:
        for device_id in task.get("deviceIds") or []:
            for other in occupied.get(device_id, []):
                reason = task_reservations.conflict_reason(task, other)
                if reason:
                    return failure("DEVICE_OCCUPANCY_CONFLICT", "导入后设备预约或使用发生冲突。", conflicts=[{
                        "deviceId": device_id, "incomingTaskId": task.get("id"),
                        "reason": reason.replace("样机", "设备"), **task_reservations.task_reference(other)}])
            occupied.setdefault(device_id, []).append(task)
    return None


def prepare_task_devices(conn, task, previous, action, *, now, user="", is_delete=False, proposed_tasks=()):
    """Validate then overwrite client equipment snapshots with authoritative ones."""
    old_ids = list(previous.get("deviceIds") or [])
    ids = task.get("deviceIds", old_ids)
    invalid = device_ids_failure(ids)
    if invalid:
        return invalid
    changed = set(ids) != set(old_ids)
    if changed and (action not in ASSIGNMENT_ACTIONS or is_delete):
        return failure("TASK_DEVICE_ASSIGNMENT_NOT_ALLOWED", "请通过任务配置或临时变更调整测试设备。")
    if not ids and not old_ids and "deviceIds" not in task and "deviceSnapshots" not in previous:
        task.pop("deviceSnapshots", None)
        return None
    if action not in ASSIGNMENT_ACTIONS:
        ids = old_ids
    task["deviceIds"] = list(ids)
    stored_snapshots = copy.deepcopy(previous.get("deviceSnapshots") or {})
    if is_delete:
        task["deviceSnapshots"] = stored_snapshots
        return None
    devices = warehouse_devices(conn)
    checking = set(ids) if action in {"start_task", "restart_task"} else set(ids) - set(old_ids)
    unavailable = []
    for device_id in sorted(checking):
        found = devices.get(device_id)
        reason = ("设备不存在" if found is None else "设备有故障" if found[0].get("hasFault")
                  else f'设备状态为「{found[0].get("status")}」' if found[0].get("status", "闲置") != "闲置" else "")
        if reason:
            unavailable.append({"deviceId": device_id, "reason": reason,
                                "device": snapshot(*found) if found else stored_snapshots.get(device_id, {"id": device_id})})
    if unavailable:
        return failure("DEVICE_NOT_AVAILABLE", "设备不存在、有故障或处于不可用状态，无法分配或启动任务。", devices=unavailable)
    if ids and task_reservations.is_open(task):
        proposed_ids = {item.get("id") for item in proposed_tasks}
        peers = [item for item in open_tasks(conn) if item["id"] not in proposed_ids]
        peers += list(proposed_tasks)
        conflicts = []
        for other in peers:
            if other.get("id") == task.get("id"):
                continue
            shared = set(ids) & set(other.get("deviceIds") or [])
            reason = task_reservations.conflict_reason(task, other) if shared else ""
            for device_id in sorted(shared if reason else []):
                conflicts.append({"deviceId": device_id, "reason": reason.replace("样机", "设备"),
                                  **task_reservations.task_reference(other)})
        if conflicts:
            return failure("DEVICE_OCCUPANCY_CONFLICT", "设备预约时间重叠，或仍被其他执行中/阻塞中的任务占用。", conflicts=conflicts)
    refresh = action in ASSIGNMENT_ACTIONS or action in {"start_task", "restart_task"}
    if status_normalization.normalize_task_flow_status(previous) in task_reservations.TERMINAL:
        refresh = False
    task["deviceSnapshots"] = {
        device_id: snapshot(*devices[device_id]) if refresh and device_id in devices
        else copy.deepcopy(stored_snapshots.get(device_id) or (snapshot(*devices[device_id]) if device_id in devices else {"id": device_id}))
        for device_id in ids
    }
    evidence = {"deviceIds": copy.deepcopy(task["deviceIds"]), "deviceSnapshots": copy.deepcopy(task["deviceSnapshots"])}
    existing_logs = task_queries.load_task_logs_for(conn, [task["id"]]).get(task["id"], [])
    by_id = {item.get("id"): item for item in existing_logs}
    incoming_logs = copy.deepcopy(task.get("logs") if isinstance(task.get("logs"), list) else existing_logs)
    incoming_by_id = {item.get("id"): item for item in incoming_logs if item.get("id")}
    logs = []
    # A summary can omit server equipment logs. Insert those at their original
    # place among existing records, before newly submitted client events.
    for prior in existing_logs:
        incoming = incoming_by_id.get(prior.get("id"))
        if prior.get("deviceAction"):
            logs.append(copy.deepcopy(prior))
        elif incoming is not None:
            logs.append(incoming)
    logs.extend(item for item in incoming_logs if item.get("id") not in by_id)
    for log in logs:
        prior = by_id.get(log.get("id"))
        if prior:
            for key in ("deviceIds", "deviceSnapshots", "previousDeviceIds", "previousDeviceSnapshots", "deviceAction"):
                if key in prior:
                    log[key] = copy.deepcopy(prior[key])
                else:
                    log.pop(key, None)
        else:
            log.update(copy.deepcopy(evidence))
    event = ("change" if old_ids else "assign", "设备变更" if old_ids else "设备分配") if changed else TRANSITIONS.get(action)
    if event and (ids or old_ids):
        device_action, label = event
        log = {"id": f"tasklog_device_{time_ns():020d}_{uuid.uuid4().hex}", "time": now, "action": label,
               "deviceAction": device_action, "user": user or "管理员",
               "fromStatus": status_normalization.normalize_task_flow_status(previous),
               "toStatus": status_normalization.normalize_task_flow_status(task), **copy.deepcopy(evidence)}
        if changed:
            log.update(previousDeviceIds=old_ids, previousDeviceSnapshots=stored_snapshots)
        names = [f'{item.get("name", key)}（{item.get("code", key)}）' for key, item in (task["deviceSnapshots"] or stored_snapshots).items()]
        log["detail"] = f"{label}：" + "、".join(names)
        logs.append(log)
    task["logs"] = logs
    return None


def enrich_sample_events(conn, events, task):
    for event in events:
        event_id = event.get("id")
        if event_id and conn.execute("SELECT 1 FROM sample_events WHERE id = ?", (event_id,)).fetchone():
            continue
        if not task.get("deviceIds") and not task.get("deviceSnapshots"):
            event.pop("deviceIds", None)
            event.pop("deviceSnapshots", None)
            continue
        event["deviceIds"] = copy.deepcopy(task.get("deviceIds") or [])
        event["deviceSnapshots"] = copy.deepcopy(task.get("deviceSnapshots") or {})


def block_faulted_device_tasks(conn, device_id, *, now, user="", fault_note=""):
    """A fault blocks running tasks atomically; repairing does not restart them."""
    affected = {"taskIds": [], "projectIds": set(), "stageIds": set(), "sampleIds": set()}
    fault_device, fault_group = warehouse_devices(conn)[device_id]
    fault_snapshot = snapshot(fault_device, fault_group)
    fault_label = f'{fault_snapshot["name"]}（{fault_snapshot["code"]}）'
    for task in open_tasks(conn):
        if device_id not in (task.get("deviceIds") or []) or status_normalization.normalize_task_flow_status(task) != "进行中":
            continue
        task["status"] = "阻塞中"
        task["flowStatus"] = "阻塞中"
        task["blockedAt"] = now
        task["blockReason"] = "测试设备故障"
        task["updatedAt"] = now
        evidence = {"deviceIds": copy.deepcopy(task.get("deviceIds") or []),
                    "deviceSnapshots": copy.deepcopy(task.get("deviceSnapshots") or {})}
        log = {"id": f"tasklog_device_{time_ns():020d}_{uuid.uuid4().hex}", "time": now, "action": "设备故障阻塞",
               "deviceAction": "fault_block", "faultDeviceId": device_id, "user": user or "系统",
               "faultDeviceSnapshot": copy.deepcopy(fault_snapshot),
               "fromStatus": "进行中", "toStatus": "阻塞中", "reason": fault_note,
               "detail": f"测试设备 {fault_label} 标记故障，任务已自动阻塞。", **evidence}
        task["logs"] = task_queries.load_task_logs_for(conn, [task["id"]]).get(task["id"], []) + [log]
        record_writers.upsert_task_record(conn, task, task["projectId"], task["stageId"])
        events = [{**copy.deepcopy(log), "id": f"event_device_{uuid.uuid4().hex}", "sampleId": sid,
                   "source": "设备故障阻塞", "taskId": task["id"], "projectId": task["projectId"],
                   "stageId": task["stageId"], "testItem": task.get("testItem", "")} for sid in task.get("sampleIds") or []]
        for event in events:
            row = conn.execute("SELECT status FROM sample_records WHERE id = ? AND deleted_at IS NULL", (event["sampleId"],)).fetchone()
            before = str(row["status"] or "闲置") if row else ""
            event["from"] = before
            event["to"] = before if before in {"取走分析", "已退库"} else "在位等待"
        record_writers.upsert_sample_events(conn, events)
        affected["taskIds"].append(task["id"])
        affected["projectIds"].add(task["projectId"])
        affected["stageIds"].add(task["stageId"])
        affected["sampleIds"].update(task.get("sampleIds") or [])
    if affected["sampleIds"]:
        from server_modules.mutations.effects import reconcile_task_sample_occupancy
        reconcile_task_sample_occupancy(conn, affected["sampleIds"])
    return affected
