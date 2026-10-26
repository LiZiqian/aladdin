<p align="center">
  <img src="frontend/css/assets/aladdin-logo.png" alt="ALADDIN 系统 Logo" width="640">
</p>

<h1 align="center">ALADDIN 系统</h1>

<p align="center">
  <strong>硬件测试与样机全生命周期管理平台</strong><br>
  从测试计划到结果追溯，让每一台样机的历程清晰可见。
</p>

<p align="center">
  <img alt="Source version 7.4.0" src="https://img.shields.io/badge/version-7.4.0-C89136?style=flat-square">
  <img alt="Python 3.9+" src="https://img.shields.io/badge/python-3.9%2B-10394B?style=flat-square&amp;logo=python&amp;logoColor=white">
  <img alt="No pip or npm dependencies" src="https://img.shields.io/badge/dependencies-none-10394B?style=flat-square">
</p>

<p align="center">
  <a href="#下载与启动">快速开始</a> ·
  <a href="#能做什么">功能概览</a> ·
  <a href="#数据与迁移">数据与备份</a> ·
  <a href="#更新版本">更新指南</a>
</p>

---

ALADDIN 系统面向硬件测试团队，将项目、阶段、测试任务、样机档案与设备管理集中在一个内网工作平台中，贯通测试安排、样机分配、结果录入和履历追溯。

在一台电脑上启动服务，团队通过浏览器访问。业务数据保存在服务端本地，无需安装独立数据库，也无需执行 `pip install` 或 `npm install`。

> 当前源码版本：`7.4.0` · 最新代码：`main` · 默认端口：`9398`

## 能做什么

| 模块 | 用途 |
|------|------|
| 项目与阶段 | 管理 SKU、BOM、测试策略、人员和地点 |
| 测试任务 | 配置执行人、计划、样机和测试设备，跟踪启动、阻塞、变更和结束 |
| 样机档案 | 在样机卡片中查看基本信息、问题表、测试履历、图片、CT 三维模型与视频、点云数据 |
| 结果录入 | 记录结论、DTS、问题、照片和样机去向 |
| 设备仓库 | 按地域、部门管理设备，联动任务预约、使用和阻塞状态，单独维护设备故障 |
| 批量导入 | 导入项目人员、样机和测试用例 |
| 数据迁移 | 导出完整或选定范围的数据、单台样机档案，导入前预览内容与冲突 |

打开样机卡片，可按以下栏目查看和管理数据：

| 样机卡片栏目 | 支持查看的数据 |
|--------------|----------------|
| 样机信息 | SN、IMEI、主板 SN、阶段、方案、重组来源、当前状态与任务、挂账人、持有人、位置和备注 |
| 样机问题表 | 样机的问题记录与关联图片，集中查看故障和问题情况 |
| 测试履历 | 各次测试所属的项目与阶段、任务、执行人、日期、状态、结果、问题及结果图片；可查看样机状态日志，并点击关联测试设备查看设备详情 |
| 图片数据 | 样机照片、问题图片和测试结果图片，支持缩略图浏览、大图缩放与拖动 |
| CT 三维数据 | 上传 CT 转换后的 **STL 三维模型**，在线旋转、平移、缩放和复位查看；也支持上传 **MP4、WebM、MOV、M4V、AVI、MKV** 格式的 CT 切片视频 |
| 点云数据 | 上传 **PLY、PCD、XYZ、PTS、TXT** 点云文件，在线 3D 查看，支持旋转、平移、缩放、点大小调整；带 RGB 数据时显示原始颜色，否则按高度着色 |

CT 三维数据和点云数据支持多文件上传与原文件下载，单个文件不超过 **75 MB**。CT 视频可在浏览器支持相应格式与编码时直接播放，也可下载后播放。

## 下载与启动

### Windows

1. [下载 ALADDIN 系统（main 分支 ZIP）](https://github.com/LiZiqian/TestChamber/archive/refs/heads/main.zip)，解压到固定目录。
2. 安装 Python 3.9 或更高版本。
3. 双击 `start_server.bat`，按提示选择默认端口或自定义端口。
4. 保持服务窗口运行，在浏览器打开 [http://127.0.0.1:9398/](http://127.0.0.1:9398/)。如修改了端口，使用所选端口访问。

启动脚本会尝试寻找 Python；未找到时可按提示填写或拖入 `python.exe`。在服务窗口按 `Ctrl+C` 可停止服务。

也可以使用 Git。GitHub 仓库仍使用 `TestChamber` 作为仓库名，默认克隆目录也为 `TestChamber`：

```powershell
git clone --branch main --single-branch https://github.com/LiZiqian/TestChamber.git
cd TestChamber
.\start_server.bat
```

以上入口获取 `main` 的最新代码；[GitHub Releases](https://github.com/LiZiqian/TestChamber/releases) 中的标签版本不一定包含 `main` 的最新修改。

### 命令行启动

在解压后的项目目录执行。仅允许本机访问：

```powershell
python -m backend.server --host 127.0.0.1 --port 9398
```

允许受信任的局域网设备访问：

```powershell
python -m backend.server --host 0.0.0.0 --port 9398
```

Windows 启动脚本默认监听 `0.0.0.0`，同一内网的其他电脑可访问 `http://服务器IP:9398/`。仅在受信任的内网使用；当前版本没有账号登录或资源访问权限控制，请勿直接暴露到公网。

macOS 或 Linux 将命令中的 `python` 改为 `python3` 即可。

## 第一次使用

1. 创建样机池并新增或批量导入样机。
2. 创建项目和阶段。
3. 配置 SKU、BOM、测试策略、人员和地点。
4. 生成并配置测试任务。
5. 分配样机，启动任务并录入结果。
6. 结束任务后，在样机档案中查看完整履历。

## 数据与迁移

首次启动会在项目内创建 `data/`。主要内容如下：

```text
data/
├── testchamber.sqlite   # 主数据库
├── samples/             # 样机照片、缩略图和附件
├── import-previews/     # 导入预览临时文件
└── exports/             # 导出临时文件
```

- 业务数据迁移：使用系统内的数据包导出和导入，根据需要选择完整或指定范围的数据，确认导入预览后再提交。
- 单台样机迁移：在样机详情中导出和导入“样机档案包”。
- 完整备份：停止服务后复制整个 `data/` 目录，包含数据库和全部附件；不要只复制数据库文件。

当前只支持 ChamberData V2 数据包和现行数据库结构，不会自动升级旧数据库或扫描同级旧数据目录。旧版本数据请先确认兼容性，并保留原始备份。

`data/`、真实数据库、照片和公司测试数据不会随 GitHub 源码发布，也不要手动提交到 Git。

## 更新版本

更新前先停止服务，备份整个 `data/` 目录，并保留一份原版本程序。历史数据库不保证能被当前版本直接使用。

**使用 Git 安装**：在项目目录中检查本地改动，再更新 `main`：

```powershell
git status --short
git switch main
git pull --ff-only origin main
```

若有本地改动或 Git 提示无法快进，请先处理差异，不要强制覆盖。

**使用 ZIP 安装**：下载最新 `main` ZIP 并解压到新目录。确认数据库兼容后，将已备份的整个 `data/` 目录复制到新目录，再启动新版本。

更新完成后重新启动服务，并在浏览器按 `Ctrl+F5` 刷新页面。不要让新旧两个服务同时使用同一份业务数据。

## 常见问题

| 问题 | 处理方式 |
|------|----------|
| 页面打不开 | 确认服务窗口仍在运行、访问端口正确；默认可访问 [健康检查](http://127.0.0.1:9398/api/health) |
| 找不到 Python | 运行 `python --version`；Windows 启动脚本也可手动选择 `python.exe` |
| 端口被占用 | 关闭旧服务，或启动时改用其他端口 |
| 局域网无法访问 | 使用 `0.0.0.0` 启动，并检查 Windows 防火墙和服务器 IP |
| 更新后仍显示旧界面 | 确认正在运行的是新目录中的服务，再按 `Ctrl+F5` 刷新 |
| 导入被拒绝 | 确认使用 ChamberData V2 数据包，查看预览和错误提示，不要手动覆盖数据库 |

## 目录与技术说明

```text
TestChamber/          # ALADDIN 系统项目目录
├── backend/          # Python 后端
├── frontend/         # 页面、脚本、样式、正式 Logo 与导入模板
├── start_server.bat  # Windows 启动入口
├── README.md         # 使用说明
└── data/             # 首次启动创建，不包含在源码中
```

当前版本的文件中不包含维护者本地的开发文档、验证脚本、测试与设计草稿；这些内容可能仍存在于历史提交中。

- 后端：Python 标准库 `ThreadingHTTPServer`
- 数据库：SQLite WAL
- 前端：Vanilla JavaScript SPA
- 健康检查：`GET /api/health`
