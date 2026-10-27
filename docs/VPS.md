# VPS 存储与旧记录迁移

这个 fork 把写作记录存在自己的 VPS。各设备通过 HTTPS 提交新增记录，不再互相覆盖 `data.json`。

本地仍保留一份缓存和待上传记录，放在 Obsidian 的 IndexedDB 里，不在笔记库里。断网时能继续记，联网后每 30 秒补传，也可以在设置里点 **检查并同步**。同一笔记录重传不会重复计数。

VPS 地址、访问令牌和 Vault ID 保存在插件目录的 `vps-settings.json`，可以用 Syncthing 同步。令牌在文件中是明文。不会上传笔记正文；服务器会收到文件路径、日期、时间段、字数和字符数。

## 1. 部署服务

需要 VPS 上有 Docker Compose，以及指向 VPS 的域名。下面命令在仓库根目录执行：

```sh
cd server
cp .env.example .env
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

把生成的令牌填进 `.env` 的 `KTR_TOKEN`，然后运行：

```sh
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

服务只把端口映射到 VPS 的 `127.0.0.1:8787`。通过 Caddy 或现有 Nginx 提供 HTTPS；Caddy 配置见 `server/Caddyfile.example`。插件只接受 HTTPS，只有本机测试允许 HTTP。

数据在 Docker 卷 `ktr-data` 中。不要运行 `docker compose down -v`，它会删掉数据库。当前服务面向一个人的设备；令牌可访问服务中的所有 vault，不是多用户权限系统。

## 2. 构建、安装插件

在本机仓库根目录：

```sh
npm ci
npm run build
```

先关闭 Obsidian 中的 Keep the Rhythm。备份原插件目录，再把仓库中的 `main.js`、`manifest.json`、`styles.css` 复制到笔记库的 `.obsidian/plugins/keep-the-rhythm/`，最后启用插件。

**先备份旧 `data.json`，不要删除它。** 所有要使用服务器的设备都需要安装这个 fork。切换后不要用官方版本覆盖它，否则官方版本会继续读取旧 JSON。

## 3. 迁移旧记录：两种方法选一种

迁移前先停止各设备上的写作，等现有文件同步完成，选出一份最完整的 `data.json`。已有的冲突副本不能直接相加，因为可能重复；先单独保留，再核对缺少的日期。

迁移保留日期、文件路径、起始字数、起始字符数，以及每个时间段的字数和字符数增量，包括负数。原来的数字 `id` 只用于本地查表，不作为服务器身份。

### 方法 A：在插件里迁移

1. 在第一台设备打开 **Keep the Rhythm → VPS storage**。
2. 填写 Server URL、Access token、Vault ID（例如 `writing`）。每项输入自动保存在本机，即使暂时格式不正确也不会丢。
3. 点 **首次导入历史并连接**。
4. 按钮会直接生效，不需要重载。插件先在 `.keep-the-rhythm/pre-vps-时间戳.json` 保存备份，再建立本地迁移记录并上传。
5. 等状态显示 **Synced**，核对热力图和历史记录。
6. 其他设备填写相同连接信息，点 **加入已有记录**，立即生效。

加入前也会保存本机旧记录。加入操作不会把该设备的旧历史再加一遍。如果加入失败，继续使用原本的本地记录；修正连接后再次点击连接按钮。

首次导入支持断网：导入内容和此后新增记录先持久保存在本机。首次上传没完成前不要清除 Obsidian 的应用数据。服务器拒绝用不同历史再次初始化同一个 Vault ID，以免误覆盖。

### 方法 B：命令行迁移（可逐字段核验）

先预览，不改文件、不联网：

```sh
python3 server/migrate.py /absolute/path/to/data.json
```

确认条数和日期范围后，通过环境变量提供令牌，不要把它写进仓库：

```sh
read -s KTR_TOKEN
export KTR_TOKEN
python3 server/migrate.py /absolute/path/to/data.json \
  --server https://ktr.example.com --vault writing --apply
unset KTR_TOKEN
```

工具会：

1. 检查数据格式，并打印日记录数、分时记录数、日期范围和合计。
2. 在源文件旁创建带时间戳的 `.bak` 文件；也可以用 `--backup /path/to/backup.json` 指定位置。
3. 只初始化空的服务器历史。同一份数据可安全重试；不同数据会被拒绝。
4. 从服务器读回导入内容，逐字段核对，而不只是检查总数。

完成后，**包括第一台在内，所有设备都选 加入已有记录**。不要再次从插件导入。

工具直接接受 `schema: "0.2"` 的数据。更早的格式先通过原插件升级，再使用它保存的 `data.json`。

## 4. 日常使用与边界

- 云模式不再读入外部同步来的统计 JSON，也不再定期往笔记库写统计备份。旧 JSON 保留为迁移前快照。
- 仍须同步笔记正文；这里解决的是写作统计的文件覆盖，不解决正文冲突。
- 在设备上删掉笔记，保留过去的写作记录，避免文件同步把历史重复扣减。云模式下 `ignoreDeletedFiles` 不改变这一行为。
- 在插件里显式删除某条历史，只删除当前设备已经看到的写作事件。其他设备还没上传的写作会保留；两台设备重复删除不会重复扣数。
- 重命名更新当前已经看到的记录。断网设备后来上传、仍使用旧路径的事件会保留旧路径。两台设备同时改成不同名称时，按事件顺序编号和唯一 ID 确定同一个结果。
- 各设备应使用相同的时区和计数设置。服务器按设备提供的本地日期记账，不重新切分日期。
- 每次编辑会留一笔事件，历史只增不清。个人使用先观察数据库大小；多年大量写作后需要另做压缩方案。
- 本地应用缓存被清除后，已上传的数据可以重新加入取回；未上传数据只能从该设备或导出的备份恢复。

## 5. 备份和恢复

插件设置中的 **导出备份** 会导出当前完整记录，包括还未上传的内容，格式与原 `data.json` 一致，不含服务器令牌。

服务器在线备份使用 SQLite 的备份接口，不要只复制正在写入的 `.sqlite3` 文件。以下命令在 `server/` 中执行：

```sh
docker compose exec ktr python -c \
  'import sqlite3; src=sqlite3.connect("/data/ktr.sqlite3"); dst=sqlite3.connect("/data/backup.sqlite3"); src.backup(dst); dst.close(); src.close()'
docker compose cp ktr:/data/backup.sqlite3 ./ktr-backup.sqlite3
```

把备份复制到 VPS 以外保存。恢复时先停止服务，再还原数据库；不要把旧备份覆盖到仍运行的服务。若客户端发现服务器记录倒退，会停止同步，避免静默丢数据。

要回到官方插件：先在所有设备停止写作，等上传完成，导出完整备份。关闭插件，保存当前插件文件，把导出的 JSON 复制为插件目录的 `data.json`，再安装并启用官方版本。此后又恢复为文件同步，需要重新处理原来的冲突风险。不要同时运行两种模式。

## 6. 验证

```sh
npm test -- --runInBand
npm run check
npm run build
python3 -m unittest discover -s server -v
```

测试覆盖：双设备写入、重传、响应丢失、断网后重启、同步中继续编辑、删除合并、重命名、分页、鉴权、重复迁移、迁移字段保留、服务器事务回滚。

## 用 Syncthing 同步 VPS 设置

同步笔记库中的 `.obsidian/plugins/keep-the-rhythm/vps-settings.json`。如果使用自定义配置目录，以插件设置目录为准。当前已经连接的设备会在升级后自动生成此文件，之后修改输入也会自动保存。

其他设备安装同版本插件，收到配置后重载插件即可自动加入服务器已有历史。新设备不会继承“首次导入”动作，不会把旧记录再导入一遍。已经连接的设备保留自己的待传队列和读取进度。正在运行时收到文件变更，也需要重载插件才会应用。

文件只含服务器地址、令牌、Vault ID 和表单草稿。它不含写作记录、设备状态或同步进度。请确保 Syncthing 没有排除 `.obsidian` 或这个文件。访问令牌是明文，会跟随这个文件同步到其他设备。
