# CANNBot 模型代理 · 桌面壳（Python + pywebview + pystray）
# 原生窗口用系统 WebView（WebView2/EdgeChromium），托盘用 pystray，内核是 node server.mjs。
# 重复启动安全：发现内核已在跑就直接开窗口，不再起第二个。
import os
import re
import sys
import time
import threading
import subprocess
import urllib.request
import urllib.error

import webview
import pystray
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))


def read_addr():
    """从 config.yaml 读监听地址（在面板里改过端口后，这里能自动跟上）"""
    host, port = "127.0.0.1", 8787
    try:
        with open(os.path.join(HERE, "config.yaml"), encoding="utf-8") as f:
            text = f.read()
        m = re.search(r"^\s*host:\s*(\S+)", text, re.M)
        if m:
            host = m.group(1).strip("'\"")
        m = re.search(r"^\s*port:\s*(\d+)", text, re.M)
        if m:
            port = int(m.group(1))
    except Exception:
        pass
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    return host, port


HOST, PORT = read_addr()
URL = f"http://{HOST}:{PORT}/"

proxy = None
window = None
tray = None


def proxy_alive():
    try:
        urllib.request.urlopen(f"http://{HOST}:{PORT}/api/state", timeout=1)
        return True
    except urllib.error.HTTPError:
        return True  # 有响应就算活着（401 = 设了 api-key）
    except Exception:
        return False


def start_proxy():
    global proxy
    kwargs = {"cwd": HERE, "stdin": subprocess.PIPE}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW  # 不弹黑窗
    env = {**os.environ, "CANNBOT_PROXY_PARENT": "1"}  # 内核据此开启孤儿保护
    proxy = subprocess.Popen(["node", os.path.join(HERE, "server.mjs")], env=env, **kwargs)


def wait_proxy(timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proxy_alive():
            return True
        time.sleep(0.3)
    return False


def make_icon():
    img = Image.new("RGBA", (64, 64), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((4, 4, 60, 60), radius=14, fill=(110, 123, 255, 255))  # #6e7bff
    d.ellipse((22, 22, 42, 42), fill=(255, 255, 255, 255))
    return img


def show_window(_icon=None, _item=None):
    if window is None:
        return
    try:
        window.restore()
        window.show()
        # Windows 下 show() 只是重新显示，常被别的窗口压在后面、抢不到前台焦点；
        # 「置顶 → 取消置顶」是 Z 序操作，不受前台锁限制，能可靠把它提到最前。
        if os.name == "nt":
            window.on_top = True
            window.on_top = False
    except Exception:
        pass


def on_closing():
    # 关窗 = 缩到托盘，不退出
    try:
        window.hide()
        return False
    except Exception:
        return True


def quit_app(_icon=None, _item=None):
    try:
        if proxy is not None:
            proxy.terminate()
    except Exception:
        pass
    try:
        if tray is not None:
            tray.stop()
    except Exception:
        pass
    os._exit(0)


def main():
    global window, tray
    if not proxy_alive():
        start_proxy()
        if not wait_proxy():
            print("代理内核启动失败（node server.mjs）", file=sys.stderr)

    window = webview.create_window("CANNBot 模型代理", URL, width=460, height=780, min_size=(380, 600))
    window.events.closing += on_closing

    tray = pystray.Icon(
        "cannbot-proxy",
        make_icon(),
        "CANNBot 模型代理",
        menu=pystray.Menu(
            # default=True：Windows 下左键单击托盘图标即触发「打开面板」
            pystray.MenuItem("打开面板", show_window, default=True),
            pystray.MenuItem("退出", quit_app),
        ),
    )
    threading.Thread(target=tray.run, daemon=True).start()

    webview.start()  # 主线程阻塞，窗口销毁后返回
    quit_app()


if __name__ == "__main__":
    main()