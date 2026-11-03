# PianoVal 通用部署指南

本文仅使用示例域名，不包含实际服务器地址或账号。

## 服务启动

安装 Python 3.11 / 3.12 和 uv，在 `server/` 执行 README 中的依赖安装、权重下载与启动命令。进程必须能访问模型文件，并可写入 `PIANOVAL_STUDIO_DIR` 指定的数据目录。

使用进程管理器启动服务，监听本机 `localhost:8765`；由反向代理提供有效 HTTPS，转发 HTTP 与 WebSocket。模型加载成功前，`/ready` 返回 503。

## 账号与来源

不提供默认部署账号。可在服务器终端生成密码哈希；输入通过 getpass 读取，不进入命令行历史：

```bash
cd server
uv run python -c 'from getpass import getpass; from app.auth import hash_password; print(hash_password(getpass("Password: ")))'
```

将输出放入服务的环境配置，并设置自己的用户名：

```dotenv
PIANOVAL_LOGIN_USERNAME=your-own-username
PIANOVAL_PASSWORD_HASH=your-generated-password-hash
PIANOVAL_ALLOWED_ORIGINS=https://pianoval.example.com
PIANOVAL_STUDIO_DIR=/path/to/persistent-data
```

多账号使用 `PIANOVAL_LOGIN_ACCOUNTS_JSON` 配置用户名到密码哈希的 JSON 对象。不应将实际配置提交到仓库。登录启用后，浏览器使用 HttpOnly Cookie 访问页面、API 与 WebSocket，退出仅撤销当前浏览器会话。

## 反向代理

在已经配置有效 TLS 证书的 Nginx `server` 中添加：

```nginx
location / {
    proxy_pass http://localhost:8765;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 120s;
    client_max_body_size 50M;
}
```

子目录部署时，为 Uvicorn 设置对应 `--root-path`，并让代理将该前缀移除后转发；页面会根据 `<base>` 生成同来源的静态资源、API 和 WebSocket 路径。

## 持久化和日志

`PIANOVAL_STUDIO_DIR` 保存上传录音、标注、训练任务、登录会话、测试报告及流式日志，应单独持久化与备份。代码和模型权重不要与该目录混在一起发布。

`stream-runs/` 记录每次流式识别会话；`latency-runs/` 保存逐窗 JSONL；`test-runs/` 保存前端对照和人工复核报告。模型输出、人工放行与原始音频分别保留。

同连接 ping 的往返时间会包含服务端积压，不能当作纯网络 RTT。若计算时间持续大于音频推进时长，需要优化推理或降低并发，不能仅通过增大连接上限解决。

## 浏览器回归

需要认证的回归脚本从 `PIANOVAL_TEST_USERNAME`、`PIANOVAL_TEST_PASSWORD` 读取测试账号，测试地址使用 `PIANOVAL_TEST_URL`。这些值仅保存在本机或 CI 的私密配置中。

Pad 实弹须验证有效证书、麦克风权限、页面前后台切换、持续录音、跟弹误拦、完整停止留档及目标负载下的反馈延迟。
