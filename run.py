"""ตัวช่วยรันเซิร์ฟเวอร์ — python run.py แล้วเปิด http://localhost:8000"""
import socket

import uvicorn


def lan_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        sock.close()


if __name__ == "__main__":
    print("  เครื่องนี้      : http://localhost:8000")
    print(f"  เครื่องอื่นในวง : http://{lan_ip()}:8000")
    uvicorn.run("app.server:app", host="0.0.0.0", port=8000, reload=False)
