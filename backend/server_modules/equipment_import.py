"""Preserve task equipment when merging V2 bundles without replacing local cards.

Device IDs are identities, not names. Ambiguous identities fail the import rather
than silently binding historical tests to different hardware in the destination.
"""
from __future__ import annotations

import copy
import re
import uuid

from server_modules import task_reservations


def _index(warehouse):
    result = {}
    if not isinstance(warehouse, dict) or not isinstance(warehouse.get("groups", []), list):
        raise ValueError("设备仓库格式无效")
    codes = set()
    for group in warehouse.get("groups", []):
        if not isinstance(group, dict) or not isinstance(group.get("devices", []), list):
            raise ValueError("设备分组格式无效")
        for device in group.get("devices", []):
            if not isinstance(device, dict):
                raise ValueError("设备记录格式无效")
            did, code = device.get("id"), device.get("code")
            if (not isinstance(did, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", did)
                    or not isinstance(code, str) or not code.strip() or len(code.strip()) > 80
                    or not isinstance(device.get("name"), str) or not device["name"].strip()
                    or len(device["name"].strip()) > 100):
                raise ValueError("导入设备的标识、名称或编号无效")
            if did in result or code.strip().casefold() in codes:
                raise ValueError("导入设备的 ID 或编号重复")
            if device.get("status", "闲置") not in ("闲置", "使用中", "维护中", "停用"):
                raise ValueError("导入设备状态无效")
            if type(device.get("hasFault", False)) is not bool:
                raise ValueError("导入设备故障标记无效")
            if not isinstance(device.get("faultNote", ""), str) or len(device.get("faultNote", "")) > 2000:
                raise ValueError("导入设备故障说明无效")
            result[did] = (group, device)
            codes.add(code.strip().casefold())
    return result


def _mark_external_snapshots(record, target_index, deployment_id):
    for field, ids_field in (("deviceSnapshots", "deviceIds"), ("previousDeviceSnapshots", "previousDeviceIds")):
        snapshots = record.get(field)
        ids = record.get(ids_field) or []
        if isinstance(ids, list) and ids and snapshots is None:
            snapshots = record[field] = {}
        if not isinstance(snapshots, dict):
            continue
        if isinstance(ids, list):
            for did in ids:
                if isinstance(did, str):
                    snapshots.setdefault(did, {"id": did})
        for did, snapshot in snapshots.items():
            if not isinstance(snapshot, dict):
                continue
            local = target_index.get(did)
            code = snapshot.get("code")
            if local and code and str(code).strip().casefold() == local[1]["code"].strip().casefold():
                continue
            snapshot["external"] = True
            snapshot.setdefault("sourceDeviceId", did)
            if deployment_id:
                snapshot.setdefault("sourceDeploymentId", deployment_id)


def merge_referenced_equipment(current: dict, incoming: dict, task_ids: set[str], *, source_deployment_id="", sample_ids=None) -> None:
    """Merge only hardware referenced by the tasks the user actually imported."""
    target = copy.deepcopy(current.get("deviceWarehouse") or {"revision": 0, "groups": []})
    target_index = _index(target)
    source_index = _index(incoming.get("deviceWarehouse") or {"groups": []})
    codes = {device["code"].strip().casefold(): did for did, (_, device) in target_index.items()}
    added = False
    for project in current.get("projects") or []:
        for stage in project.get("stages") or []:
            for task in stage.get("tasks") or []:
                if task.get("id") not in task_ids:
                    continue
                ids = task.get("deviceIds", [])
                if not isinstance(ids, list) or any(not isinstance(did, str) or not did for did in ids) or len(ids) != len(set(ids)):
                    raise ValueError("导入任务的设备配置必须是不重复的设备 ID 数组")
                snapshots = task.get("deviceSnapshots") or {}
                if not isinstance(snapshots, dict):
                    raise ValueError("导入任务的设备快照格式无效")
                for did in ids:
                    snapshot = snapshots.get(did) or {}
                    if not isinstance(snapshot, dict):
                        raise ValueError("导入任务的设备快照格式无效")
                    existing = target_index.get(did)
                    source = source_index.get(did)
                    if existing:
                        historical_code = snapshot.get("code") or (source[1].get("code") if source else "")
                        if historical_code and str(historical_code).strip().casefold() != existing[1]["code"].strip().casefold():
                            raise ValueError(f"设备 ID {did} 在两端对应不同编号，无法自动关联，请先核对设备身份")
                        continue
                    if not source:
                        if task_reservations.is_open(task):
                            raise ValueError(f"未结束任务引用的设备 {did} 不在数据包或本机仓库中")
                        # Completed records can remain historical without a live card.
                        continue
                    group, device = source
                    code = device["code"].strip().casefold()
                    if code in codes:
                        raise ValueError(f"设备编号 {device['code']} 已对应另一设备 ID，请先核对设备身份")
                    region, department = group.get("region"), group.get("department")
                    if any(not isinstance(value, str) or not value.strip() or len(value) > 80 for value in (region, department)):
                        raise ValueError("导入设备所属地域或部门无效")
                    target_group = next((item for item in target["groups"]
                                         if item.get("region") == region and item.get("department") == department), None)
                    if target_group is None:
                        gid = group.get("id")
                        if (not isinstance(gid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", gid)
                                or any(item.get("id") == gid for item in target["groups"])):
                            gid = "device_group_" + uuid.uuid4().hex
                        target_group = {"id": gid, "region": region, "department": department, "devices": []}
                        target["groups"].append(target_group)
                    saved = copy.deepcopy(device)
                    for key in ("usageStatus", "currentTasks", "reservations"):
                        saved.pop(key, None)
                    target_group.setdefault("devices", []).append(saved)
                    target_index[did] = (target_group, saved)
                    codes[code] = did
                    added = True
    if added:
        target["revision"] = int(target.get("revision", 0)) + 1
        current["deviceWarehouse"] = target
    # A task may have switched equipment. Its earlier log references must not
    # accidentally resolve to an unrelated local card with a reused source ID.
    for project in current.get("projects") or []:
        for stage in project.get("stages") or []:
            for task in stage.get("tasks") or []:
                if task.get("id") in task_ids:
                    _mark_external_snapshots(task, target_index, source_deployment_id)
                    for log in task.get("logs") or []:
                        if isinstance(log, dict):
                            _mark_external_snapshots(log, target_index, source_deployment_id)
    for event in (current.get("sampleLibrary") or {}).get("logs") or []:
        if isinstance(event, dict) and (event.get("taskId") in task_ids or event.get("sampleId") in (sample_ids or set())):
            _mark_external_snapshots(event, target_index, source_deployment_id)
