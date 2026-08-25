# 本地 HTTPS 证书

开发服务器默认读取：

- `https/private.key`
- `https/self-sign.cert`

当前证书为自签名开发证书，包含 `localhost`、`127.0.0.1`、本机名称和生成时检测到的局域网 IPv4。证书与私钥已被 `.gitignore` 排除，不会提交到仓库。

启动 HTTPS：

```powershell
.\bim-studio.ps1 restart all -Https
```

访问：`https://localhost:5173` 或 `https://<本机局域网 IP>:5173`。第一次访问需要在测试设备上信任 `self-sign.cert`。局域网 IP 改变后，应重新生成包含新 IP 的证书。

实时监控的 HLS 与 WebRTC 握手也复用这套证书，避免 HTTPS 页面加载 HTTP 视频时被浏览器拦截。
