"""Region/department groups and equipment cards for the warehouse."""
from __future__ import annotations

import copy
import json
import re

from server_modules import device_tasks, mutation_summary


DEVICE_STATUSES = ("闲置", "使用中", "维护中", "停用")


def save_warehouse(ctx, payload: dict, client_ip: str) -> tuple[bool, dict]:
    if "device" in payload:
        if "group" in payload:
            return False, {"status": 400, "error": "请分别保存分组和设备"}
        return save_device(ctx, payload, client_ip)
    return save_group(ctx, payload, client_ip)


def save_device(ctx, payload: dict, client_ip: str) -> tuple[bool, dict]:
    device = payload.get("device")
    group_id = payload.get("groupId")
    if not isinstance(device, dict) or not isinstance(group_id, str):
        return False, {"status": 400, "error": "设备及所属分组不能为空"}
    device_id = device.get("id")
    if not isinstance(device_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", device_id):
        return False, {"status": 400, "error": "设备标识无效"}
    fields = {}
    for key, label, limit in (("name", "设备名称", 100), ("code", "设备编号", 80),
                              ("model", "型号", 100), ("manufacturer", "制造商", 100),
                              ("location", "存放位置", 120), ("owner", "负责人", 80), ("notes", "备注", 2000)):
        value = device.get(key, "")
        if not isinstance(value, str) or len(value.strip()) > limit or (key in ("name", "code") and not value.strip()):
            return False, {"status": 400, "error": f"{label}须填写有效文本（最多 {limit} 个字符）"}
        fields[key] = value.strip()
    fields["status"] = device.get("status", "闲置")
    if fields["status"] not in DEVICE_STATUSES:
        return False, {"status": 400, "error": "设备状态无效"}
    if "hasFault" in device and type(device["hasFault"]) is not bool:
        return False, {"status": 400, "error": "设备故障标记须为布尔值"}
    if "faultNote" in device and (not isinstance(device["faultNote"], str) or len(device["faultNote"].strip()) > 2000):
        return False, {"status": 400, "error": "故障说明须为不超过 2000 字符的文本"}
    expected = payload.get("expectedRevision")
    if type(expected) is not int or expected < 0:
        return False, {"status": 400, "error": "设备仓库版本号无效"}
    with ctx.write_db_connection() as conn:
        row = conn.execute("SELECT data_json, revision FROM app_state WHERE id = 1").fetchone()
        if row is None:
            return False, {"status": 409, "error": "平台尚未初始化"}
        state = json.loads(row["data_json"])
        warehouse = read_warehouse(conn, include_usage=False)
        if expected != warehouse.get("revision", 0):
            return False, {"status": 409, "error": "设备仓库已更新，请刷新列表后重试。"}
        group = next((item for item in warehouse["groups"] if item.get("id") == group_id), None)
        if group is None:
            return False, {"status": 404, "error": "设备分组不存在，请刷新列表"}
        for item in warehouse["groups"]:
            for other in item.get("devices") or []:
                if other.get("id") == device_id:
                    if item["id"] != group_id:
                        return False, {"status": 409, "error": "设备已属于其他分组"}
                elif str(other.get("code", "")).strip().casefold() == fields["code"].casefold():
                    return False, {"status": 409, "error": "设备编号已存在，请使用唯一编号"}
        devices = group.setdefault("devices", [])
        existing = next((item for item in devices if item.get("id") == device_id), None)
        now = ctx.now_iso()
        fields["hasFault"] = device.get("hasFault", bool((existing or {}).get("hasFault", False)))
        fields["faultNote"] = device.get("faultNote", str((existing or {}).get("faultNote") or "")).strip()
        saved = {**(existing or {}), "id": device_id, **fields, "updatedAt": now}
        if existing is None:
            saved["createdAt"] = now
            devices.append(saved)
        else:
            devices[devices.index(existing)] = saved
        group["updatedAt"] = now
        warehouse["revision"] = expected + 1
        state["deviceWarehouse"] = warehouse
        conn.execute("UPDATE app_state SET data_json = ?, revision = ?, updated_at = ? WHERE id = 1",
                     (ctx.json_dumps(state), int(row["revision"]) + 1, now))
        blocked = device_tasks.block_faulted_device_tasks(conn, device_id, now=now, fault_note=fields["faultNote"]) if fields["hasFault"] else None
        conn.execute("""INSERT INTO audit_log
            (time, user, action, remark, revision_before, revision_after, client_ip)
            VALUES (?, '', ?, ?, ?, ?, ?)""",
            (now, "edit_device" if existing else "add_device", f'{fields["name"]}（{fields["code"]}）',
             int(row["revision"]), int(row["revision"]) + 1, client_ip))
        result = {"warehouse": device_tasks.decorate_warehouse(conn, warehouse), "previousRevision": int(row["revision"]),
                  "revision": int(row["revision"]) + 1, "updated_at": now}
        if blocked and blocked["taskIds"]:
            result["affected"] = mutation_summary.build_mutation_affected_summary(conn,
                task_ids=blocked["taskIds"], project_ids=blocked["projectIds"],
                stage_ids=blocked["stageIds"], sample_ids=blocked["sampleIds"])
        return True, result


def read_warehouse(conn, *, include_usage=True) -> dict:
    row = conn.execute("SELECT data_json FROM app_state WHERE id = 1").fetchone()
    state = json.loads(row["data_json"]) if row else {}
    warehouse = state.get("deviceWarehouse") or {"revision": 0, "groups": []}
    if not isinstance(warehouse, dict) or not isinstance(warehouse.get("groups"), list):
        raise ValueError("设备仓库数据格式无效")
    warehouse = copy.deepcopy(warehouse)
    return device_tasks.decorate_warehouse(conn, warehouse) if include_usage else warehouse


def save_group(ctx, payload: dict, client_ip: str) -> tuple[bool, dict]:
    group = payload.get("group")
    if not isinstance(group, dict):
        return False, {"status": 400, "error": "地域部门卡片不能为空"}
    group_id = group.get("id")
    if not isinstance(group_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", group_id):
        return False, {"status": 400, "error": "卡片标识无效"}
    fields = {}
    for key, label in (("region", "地域"), ("department", "部门")):
        value = group.get(key)
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 80:
            return False, {"status": 400, "error": f"{label}须填写 1–80 个字符"}
        fields[key] = value.strip()
    expected = payload.get("expectedRevision")
    if type(expected) is not int or expected < 0:
        return False, {"status": 400, "error": "设备仓库版本号无效"}
    with ctx.write_db_connection() as conn:
        row = conn.execute("SELECT data_json, revision FROM app_state WHERE id = 1").fetchone()
        if row is None:
            return False, {"status": 409, "error": "平台尚未初始化"}
        state = json.loads(row["data_json"])
        warehouse = read_warehouse(conn, include_usage=False)
        groups = warehouse["groups"]
        revision = warehouse.get("revision", 0)
        if expected != revision:
            return False, {"status": 409, "error": "设备仓库已更新，请刷新列表后重试。"}
        existing = next((item for item in groups if item.get("id") == group_id), None)
        if any(item.get("id") != group_id
               and str(item.get("region", "")).strip().casefold() == fields["region"].casefold()
               and str(item.get("department", "")).strip().casefold() == fields["department"].casefold()
               for item in groups):
            return False, {"status": 409, "error": "该地域下已存在同名部门"}
        now = ctx.now_iso()
        saved = {**(existing or {}), "id": group_id, **fields, "updatedAt": now}
        if existing is None:
            saved["createdAt"] = now
            groups.append(saved)
        else:
            groups[groups.index(existing)] = saved
        warehouse["revision"] = revision + 1
        state["deviceWarehouse"] = warehouse
        conn.execute("UPDATE app_state SET data_json = ?, revision = ?, updated_at = ? WHERE id = 1",
                     (ctx.json_dumps(state), int(row["revision"]) + 1, now))
        conn.execute("""INSERT INTO audit_log
            (time, user, action, remark, revision_before, revision_after, client_ip)
            VALUES (?, '', ?, ?, ?, ?, ?)""",
            (now, "edit_device_group" if existing else "add_device_group",
             f'{fields["region"]}－{fields["department"]}', int(row["revision"]), int(row["revision"]) + 1, client_ip))
        return True, {"warehouse": device_tasks.decorate_warehouse(conn, warehouse), "previousRevision": int(row["revision"]),
                      "revision": int(row["revision"]) + 1, "updated_at": now}
