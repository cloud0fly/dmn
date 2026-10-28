# DMN 原生 Desktop 插件

支持 Windows DSH Desktop **0.2.1-rc.3**。通过官方 main / sidebar.panellist / settings.section 与 Connection 接口加载，使用独立命名管道服务。两个节点持有各自固定根会话和私有记忆；加载、配置检查和重连均不调用模型。

从完整 DMN 源码发布 ZIP 解压后的根目录运行：

```powershell
powershell -NoProfile -File scripts/install-native.ps1
```

需要先正常退出 Desktop，并安装 Node 24.14+（24.x）与 npm；安装器自动 npm ci、构建、版本检查和官方 CLI 注册。本目录不能单独 npm pack 后安装：服务、SDK、模板和锁文件位于完整源码包内。升级保留原数据路径，停机生成成套备份；卸载使用同一脚本 -Mode uninstall，保留消息、记忆、根会话与配置。

启动后点击左侧“群聊”。原生面板和设置中的 DMN 页都能配置数据库绝对路径、日志目录、两条已支持模型路由和凭据引用。新密钥仅写入官方 DSH 凭据服务；普通设置文件只保存引用，留空保留原密钥。默认引用 DMN_DEEPSEEK_API_KEY，回退到启动环境 DEEPSEEK_API_KEY，不读取其他插件的通用旧密钥。

v0.2.0 使用顶部话题选择、A/B 成员卡片、群聊消息气泡与固定输入框，不增加内部侧栏；点击卡片选择收件人，Ctrl+Enter 发送，Enter 换行。“连接设置”和“运行管理”使用顶部图标进入次级面板。节点旁的齿轮分别编辑系统提示词，留空使用内置 Persona；仅对本节点后续轮次生效，保留固定会话、历史与宿主安全规则。运行中或未知轮次拒绝编辑，冲突需重新读取。Schema v8 升级前由安装器成套备份，回退需匹配旧版备份。首次读取发现两节点；先创建定向话题，再选择收件人发送。授权讨论会开始有限轮数的交流。所有输入显示排队/完成/拒绝/未知等实际状态，Accepted 不代表模型完成。断线先读取状态，原请求重试沿用原幂等键。

诊断与受控维护区提供证明、对账、精确确认放弃、停机备份/校验/原位恢复。遗留服务登记须证明旧 PID 已退出、没有 Runtime 锁并填写原因才能归档；不会自动清锁或重放。原位恢复先保留旧数据对，故障时保留隔离屏障。

完整说明和阶段证据见 [Desktop 用户手册](../../docs/DESKTOP_NATIVE_USER_GUIDE.md) 与 [实施记录](../../docs/DESKTOP_NATIVE_IMPLEMENTATION.md)。
