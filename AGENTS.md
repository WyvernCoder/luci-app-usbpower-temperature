# AGENTS.md

本文件面向接手本仓库的 AI/开发者，说明架构、约定、构建与测试方法。提交到公开仓库前请遵守文末的隐私规则。

## 项目目标

`luci-app-usbpower-temperature` 是一个 OpenWrt/LuCI 插件：读取 SoC 温度，按阈值和回差控制一个 USB 端口的 VBUS 供电，典型用途是给路由器加装 USB 风扇。

默认策略：温度 > 65°C 通电，≤ 60°C 断电；通电后至少保持 300 秒，断电后至少保持 120 秒。一个实例只控制一个端口。

## 运行时架构

```
LuCI JS 视图 (overview-v3.js)
   │  UCI 读写 / fs.exec (rpcd ACL)
   ▼
UCI /etc/config/usbpower_temperature
   │  procd
   ▼
/etc/init.d/usbpower_temperature  ──►  /usr/sbin/usbpowerd run
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
        gpio 后端                   uhubctl/regulator           command 后端
   /sys/class/gpio/.../value      hub 或 regulator state      sh -c 自定义命令
```

- 守护进程每 `poll_interval` 秒读一次温度；比较使用整数毫摄氏度（原始值 × `sensor_divisor`），避免浮点。
- 状态写入 `/var/run/usbpowerd.state`（key=value），供 `status-json` 读取；pid 写入 `/var/run/usbpowerd.pid`。
- 最近 10 次实际切换写入 `/tmp/usbpowerd.history`（`时间|状态|原因|温度`），`status-json` 以 `history` 数组返回；`/tmp` 在重启后清空。
- 最近 50 行守护进程日志写入 `/tmp/usbpowerd.log`（`时间|消息`），`status-json` 以 `logs` 数组返回；日志同时继续写 syslog（`logger -t usbpowerd`）。
- 每轮循环在子 shell 里把 `status-json` 结果写入 `/tmp/usbpowerd.status.json`，供前端在 `fs.exec` 失败时用 `fs.read` 回退读取；服务停止时删除该缓存。
- 所有切换都回读校验；`command` 后端没有 `command_state` 时状态视为 unknown，但写命令返回值仍会检查。
- 服务停止不改 GPIO 当前值；重启后由固件默认逻辑先上电，再由插件接管。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `root/etc/config/usbpower_temperature` | UCI 默认配置，`enabled=0` |
| `root/etc/init.d/usbpower_temperature` | procd 服务，检查 `enabled` 与配置有效性 |
| `root/usr/sbin/usbpowerd` | 主守护进程；子命令 `run`、`check`、`status-json`、`detect` |
| `root/usr/sbin/usbpower-temperature-ctl` | 手动切换 `on`/`off`/`auto`，写 UCI 后重启服务 |
| `root/etc/...`、`root/usr/share/luci/...` | 菜单和 rpcd ACL |
| `root/www/luci-static/resources/view/usbpower-temperature/overview-v3.js` | LuCI 视图 |
| `root/usr/lib/lua/luci/i18n/luci-app-usbpower-temperature.zh-cn.lmo` | 编译后的简体中文目录（构建产物，提交到仓库） |
| `po/zh_Hans/luci-app-usbpower-temperature.po` | 翻译源文件 |
| `packaging/` | ipk 的 postinst/prerm/postrm |
| `tools/build_lmo.py` | 把 `.po` 编译为 LuCI `.lmo`，支持 `--check` |
| `tools/build_ipk.py` | 无 SDK 的 ipk 构建脚本 |
| `tools/usb-fan.ps1` | 手动 sysfs GPIO 控制示例（仅 gpio 后端） |
| `build-ipk.ps1` / `install.ps1` | 构建与开发期直装入口 |
| `Makefile` | OpenWrt SDK/feed 构建入口 |

## 配置与接口

### UCI 选项

完整表格见 README。常用默认值：`backend=gpio`、`gpio_path` 为空（强制先配置）、`sensor=/sys/class/thermal/thermal_zone0/temp`、`on_threshold=65`、`off_threshold=60`、`poll_interval=10`、`min_on_time=300`、`min_off_time=120`、`storage_guard=1`、`enabled=0`。

### 后端约定

每个后端实现三件事：

1. `backend_read`：返回 `1`、`0` 或 `unknown`
2. `backend_write <1|0>`：执行切换，返回退出码
3. `verify_level`：写后回读确认（`command` 且无 `command_state` 时跳过）

| backend | 关键配置 | 读 | 写 |
|---|---|---|---|
| `gpio` | `gpio_path` | `cat` 值 | `echo 1/0 >` |
| `uhubctl` | `uhubctl_location`, `uhubctl_port` | `uhubctl -l -p` 输出中的 `power` | `uhubctl -l -p -a on/off` |
| `regulator` | `regulator_path`（指向 `state`） | `enabled`/`disabled` | 写 `enabled`/`disabled` |
| `command` | `command_on`, `command_off`, `command_state` | 可选命令输出 0/1 | `sh -c` 执行 |

新增后端时同步修改：默认 UCI 配置、`load_config`/`check_config`、`backend_read`/`backend_write`、`detect_json`（可选）、LuCI 表单字段与 `depends`、README/AGENTS 文档、测试。

### `status-json` 输出

```json
{
  "running": true,
  "enabled": true,
  "configured": true,
  "backend": "gpio",
  "target": "/sys/class/gpio/usb_power/value",
  "mode": "auto",
  "state": "on",
  "temp": 66.0,
  "sensor_ok": true,
  "on": 65,
  "off": 60,
  "last_change": 0,
  "reason": "temperature=66.0",
  "guard": false,
  "history": [
    { "ts": 1792826872, "state": "off", "reason": "temperature=60.1", "temp": 60.1 },
    { "ts": 1792826873, "state": "on", "reason": "temperature=66.0", "temp": 66.0 }
  ],
  "logs": [
    { "ts": 1792826873, "msg": "started: backend=gpio mode=auto sensor=/sys/class/thermal/thermal_zone0/temp" },
    { "ts": 1792826874, "msg": "USB power -> 1 (temperature=66.0)" }
  ]
}
```

- `state=unknown` 时前端回退读取 state 文件。
- `temp=-1` 表示当前读取失败。
- `guard=true` 表示检测到存储挂载（仅当 `storage_guard=1`）。
- `history` 是切换记录（升序，最多 10 条）；`logs` 是守护进程日志（升序，最多 50 条）。UI 都按最新在前展示。

### `detect` 输出

`targets` 数组元素带 `backend` 与对应字段（`path` 或 `location`/`port`），`sensors` 元素带 `path`、`type`、`temp`。前端用它填充检测列表。

## 依赖

- 包依赖只有 `luci-base`（`Depends: luci-base`）。已核对：该固件的 `luci-base` 硬依赖 `rpcd`、`rpcd-mod-file`、`rpcd-mod-luci`、`rpcd-mod-ucode`、`cgi-io`、`ucode` 等；`fs.exec` 所需的 `rpcd-mod-file` 会随 `luci-base` 安装。
- `cbi.js`（`_()`/`sfh`/`window.TR` 的前端支持）、`admin/translations/*` 控制器和 `admin/system` 菜单父节点都属于 `luci-base`，不需要 `luci-compat` 或 `luci-mod-system`。
- 中文翻译无需 `luci-i18n-*` 包：插件自带 `luci-app-usbpower-temperature.zh-cn.lmo`。
- 运行时还依赖 OpenWrt 基础系统的 BusyBox（`sh`、`awk`、`sed`、`mount`、`logger`）、`procd` 和 `uci`。
- `uhubctl` 不是硬依赖，仅 `backend=uhubctl` 时需要用户自行 `opkg install uhubctl`；未安装时 `usbpowerd check` 会拒绝启动该后端。
- 构建依赖：Python 3.8+、`tar`；预构建 ipk 不需要 SDK 或 `msgfmt`。

## 本地化（i18n）

- **英文是源语言**：`overview-v3.js` 和 `menu.d` 菜单标题必须使用英文，并用 `_('English string')` 包裹；禁止在 JS 里硬编码中文。
- 简体中文来自 `po/zh_Hans/luci-app-usbpower-temperature.po`，由 `python3 tools/build_lmo.py` 编译成 `root/usr/lib/lua/luci/i18n/luci-app-usbpower-temperature.zh-cn.lmo`。
- LuCI 的 `_()` 用 SuperFastHash（UTF-8）作为键；LMO 的索引必须按 key hash 升序排列，否则 LuCI 的二分查找会失败。不要手改 `.lmo`，只改 `.po` 后重新生成。
- `python3 tools/build_lmo.py --check` 用于校验已提交的 `.lmo` 是否与 `.po` 一致；`tools/build_ipk.py` 会在打包前自动执行该检查，不一致直接失败。
- 语言跟随 LuCI 的 `luci.main.lang`（`zh_cn` → `zh-cn` 目录，`en` → 源字符串）；没有独立的语言开关。
- 新增/修改界面文案的流程：改英文 `_()` → 更新 `.po` → `python3 tools/build_lmo.py` → `python3 tools/build_lmo.py --check` → 重新构建 ipk → 在设备上检查 `/cgi-bin/luci/admin/translations/zh-cn` 是否包含新译文。
- `menu.d` 的 `title` 也用 `_()` 翻译，已包含在 `.po` 中。
- README 是中英双语文档；改动功能时两边同步更新。

## 构建与发布

```sh
python3 tools/build_ipk.py
```

产物：`dist/luci-app-usbpower-temperature_1.3.2-1_all.ipk`。该文件是 gzip 压缩的 tar（含 `./debian-binary`、`./data.tar.gz`、`./control.tar.gz`），与本项目验证过的 opkg 版本一致；`Makefile` 供 OpenWrt SDK 正式构建。

版本发布时同步更新：

- `tools/build_ipk.py` 中的 `PKG_VERSION`/`PKG_RELEASE`
- `Makefile` 中的 `PKG_VERSION`/`PKG_RELEASE`
- README 中出现的 ipk 文件名
- 如接口有变，更新 README 与 AGENTS

Windows 下可用 `powershell -File build-ipk.ps1` 或 `pwsh -File build-ipk.ps1`；脚本需 UTF-8 BOM，否则 Windows PowerShell 5.1 会乱码。

## 在设备上测试

以下命令在路由器上以 root 执行。测试前先备份 `/etc/config/usbpower_temperature`。

### 基本检查

```sh
sh -n /usr/sbin/usbpowerd
/usr/sbin/usbpowerd check
/usr/sbin/usbpowerd detect
/usr/sbin/usbpowerd status-json
```

### 用假温度文件验证回差

```sh
echo 55000 > /tmp/fake_temp
uci set usbpower_temperature.settings.sensor=/tmp/fake_temp
uci set usbpower_temperature.settings.poll_interval=2
uci set usbpower_temperature.settings.min_on_time=0
uci set usbpower_temperature.settings.min_off_time=0
uci commit usbpower_temperature
/etc/init.d/usbpower_temperature restart

sleep 3; cat /sys/class/gpio/usb_power/value          # 期望 0
echo 66000 > /tmp/fake_temp; sleep 4                  # 期望 1
echo 62000 > /tmp/fake_temp; sleep 3                  # 期望保持 1
echo 59000 > /tmp/fake_temp; sleep 3                  # 期望 0
```

实际路径取决于后端；GPIO 后端可把 `cat` 换成配置的路径。

### 其他后端

- `command`：把 `command_on/off` 设为写临时文件，`command_state` 读该文件，验证状态变化。
- `regulator`：把 `regulator_path` 指向包含 `disabled` 的临时文件（仅开发机测试用），验证写入 `enabled`/`disabled`。
- `uhubctl`：用 PATH 前置的假 `uhubctl` 脚本模拟 `-a on/off` 和 `Port N: ... power` 输出。

```sh
PATH=/tmp/fakebin:/usr/sbin:/usr/bin:/sbin:/bin /usr/sbin/usbpowerd run
```

### 存储保护

用 PATH 前置一个假 `mount`，输出包含 `/dev/sda1 on ...`，在自动模式温度低于断电阈值时应保持通电，状态 `reason=blocked_storage`。

### 传感器故障

把 `sensor` 指向不存在或非数字内容，等待 3 个轮询周期：`auto` 模式应强制通电并记录 `sensor_error`。

### 前端

- 静态资源应返回 HTTP 200：`/luci-static/resources/view/usbpower-temperature/overview-v3.js`
- 页面需要登录后访问：`/cgi-bin/luci/admin/system/usbpower-temperature`
- 视图文件名带版本（`overview-v3.js`），用于打破浏览器缓存；大幅改 UI 后若用户仍看到旧界面，重命名视图文件并同步 `menu.d` 的 `path`。
- 状态读取优先 `fs.exec('/usr/sbin/usbpowerd',['status-json'])`，失败时回退 `fs.read('/tmp/usbpowerd.status.json')`；两者都失败才显示“服务不可用”，并显示可读错误（含重新登录提示）。
- 修改 UCI 后确认 `service rpcd reload` 已执行，菜单/ACL 才会刷新。
- 本地化检查（无需登录）：`curl -s http://localhost/cgi-bin/luci/admin/translations/zh-cn` 应包含 `.po` 中的中文，例如 `USB 温控风扇`；`/translations/en` 应为空对象，英文界面直接显示源字符串。
- 安装翻译目录后如果页面仍是英文，先刷新页面；仍不生效时检查文件名是否匹配 `*.zh-cn.lmo`、`.lmo` 是否由 `build_lmo.py` 生成。

## 编码约定

- 路由器端脚本严格 POSIX sh / BusyBox ash：不用 bash 数组、`[[ ]]`、`local -r` 等；需要 `local` 时直接使用。
- 所有 JSON 输出必须能被 `jsonfilter` 解析；路径/字符串经 `jesc` 转义。
- 服务脚本必须有可执行位；数据文件 644；ipk 构建脚本会按路径设置权限。
- LuCI 视图使用 `'require ...'` + `view.extend` + `form.Map` 的 ES5 风格，避免可选链、箭头函数和模板字符串（目标环境为旧浏览器）。
- 所有用户可见文案使用英文 `_()`；中文只放在 `.po` 里，不写进 JS。
- 修改 UCI 后调用 `/etc/init.d/usbpower_temperature restart`；ACL 变更后执行 `/etc/init.d/rpcd reload`。
- 不要缩短最小驻留时间或回差作为“优化”，那会导致风扇频繁启停。

## 安全不变量

1. 断电前必须检查 `storage_guard`（`/dev/sd*` 挂载）。
2. `auto` 模式传感器连续 3 次失败后必须强制通电；`always_off` 不因传感器故障改变。
3. 未配置有效后端时服务不得启动（`usbpowerd check` 失败 → init 拒绝启动）。
4. 切换后必须回读校验；失败只记录并重试，不得假装成功。
5. 不得触碰内部 `pwm-fan`/`glfan` 的配置或设备。
6. 停止服务不得主动改变 GPIO 状态。

## 隐私规则（重要）

本仓库会公开发布，**不得**写入任何与开发机/内网有关的信息：

- 不写本机用户名、主机名、Windows/Unix 绝对路径、盘符
- 不写真实路由器 IP、mDNS 名、MAC、序列号、SSID、密码、SSH 密钥路径
- 不提交 `dist/`、`*.ipk`、日志、抓包、设备备份
- 文档示例统一用 `root@<router>`、`/path/to/...`、`<router>` 等占位符
- 提交前自查：搜索盘符、用户目录、内网地址、私有主机名等模式

## 已知限制

- 单端口控制；多口需要扩展为多个 output section。
- 无转速/堵转反馈，纯开环。
- 风扇开启后若温度始终高于断电阈值，风扇会持续运行；这是回差逻辑的正常行为，调高 `off_threshold` 或增大驻留时间可改变，但会增加切换次数。
- `uhubctl` 不同版本输出格式可能不同；解析失败显示 unknown，不误切换。
- 未在多种厂商硬件上实测；跨厂商兼容性依赖后端配置正确。

## 发布检查清单

- [ ] `python3 tools/build_ipk.py` 成功（会先校验 `.lmo` 是否最新）
- [ ] `python3 tools/build_lmo.py --check` 通过
- [ ] `sh -n` 所有脚本
- [ ] JSON 文件可解析
- [ ] LuCI 视图通过 `node --check`（需包一层函数以允许顶层 `return`）
- [ ] 设备上安装/卸载/重装正常，配置保留
- [ ] 65/60 回差、驻留、存储保护、传感器故障测试通过
- [ ] 切换记录最多 10 条、按时间升序存储、UI 按最新在前展示
- [ ] 日志最多 50 条、包含启动/切换/停止信息，UI 可显示
- [ ] `/tmp/usbpowerd.status.json` 内容可解析；`fs.exec` 失败时 UI 能回退到 `fs.read`
- [ ] `/admin/translations/zh-cn` 包含新文案，英文界面仍显示英文
- [ ] README/AGENTS 隐私自查通过
- [ ] 版本号在两个构建入口一致
