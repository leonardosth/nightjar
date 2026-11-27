#!/usr/bin/env python3
"""
Surgically patches moonlight-common-c (and its enet submodule) for Nightjar on Samsung Tizen WASM:
  1. Frame Warp v1 hooks:
     - LiHasFrameWarpControl()         (RTSP DESCRIBE a=x-rl-control 0x5543 detection)
     - LiSetFrameWarpCallback(cb)      (ENet SS_ENC_CONTROL_V2 0x5544/0x5545/0x5546 receive)
     - LiSendFrameWarpRequest(ptr,len) (ENet SS_ENC_CONTROL_V2 0x5543 reliable send)
  2. Samsung Emscripten 1.39.4.7 Tizen Sockets Extension compatibility:
     - PlatformSockets.c: disable post-socket() fcntl(O_NONBLOCK) in setSocketNonBlocking()
       (breaks/stalls TCP RTSP connectTcpSocket on Tizen WRT) and map __WASI_ERRNO_* codes.
     - enet/unix.c: create ENet UDP sockets with SOCK_NONBLOCK directly, treat ENET_SOCKOPT_NONBLOCK
       as already satisfied, and map __WASI_ERRNO_AGAIN / __WASI_ERRNO_INPROGRESS.
"""
import pathlib
import re
import sys


def replace_exact(text: str, old: str, new: str, label: str, expected_count: int = 1) -> str:
    actual = text.count(old)
    if actual != expected_count:
        raise RuntimeError(f"Expected {expected_count} occurrence(s) of {label}, found {actual}")
    return text.replace(old, new, expected_count)


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: patch_moonlight_frame_warp.py <moonlight-common-c-dir>", file=sys.stderr)
        sys.exit(2)

    root = pathlib.Path(sys.argv[1])
    src = root / "src"
    enet_dir = root / "enet"

    # 1. Limelight.h — public C API for Frame Warp v1
    limelight_h = src / "Limelight.h"
    h_text = limelight_h.read_text(encoding="utf-8")
    if "LiSetFrameWarpCallback" not in h_text:
        h_text = "#include <stdbool.h>\n#include <stddef.h>\n#include <stdint.h>\n" + h_text
        end_anchor = "#ifdef __cplusplus\n}\n#endif"
        h_add = """// Nightjar / Rubylight Frame Warp v1 hooks (0x5543..=0x5546)
typedef void (*FrameWarpPacketCallback)(uint16_t msgType, const uint8_t* data, size_t len);
void LiSetFrameWarpCallback(FrameWarpPacketCallback callback);
bool LiHasFrameWarpControl(void);
int LiSendFrameWarpRequest(const uint8_t* payload, size_t len);

#ifdef __cplusplus
}
#endif"""
        h_text = replace_exact(h_text, end_anchor, h_add, "Limelight.h end anchor")
        limelight_h.write_text(h_text, encoding="utf-8")
        print(f"Patched {limelight_h}")

    # 2. RtspConnection.c — strict token parse of 0x5543 on a=x-rl-control + WASI ECONNREFUSED retry
    rtsp_path = src / "RtspConnection.c"
    rtsp_text = rtsp_path.read_text(encoding="utf-8")
    if "g_hasFrameWarpControl" not in rtsp_text:
        rtsp_header = (
            '#include "Limelight-internal.h"\n'
            "#include <stdatomic.h>\n"
            "static atomic_bool g_hasFrameWarpControl = ATOMIC_VAR_INIT(false);\n"
            "bool LiHasFrameWarpControl(void) { return atomic_load(&g_hasFrameWarpControl); }\n"
            "static bool rlHasFrameWarpControl(const char* sdp) {\n"
            "    if (!sdp) return false;\n"
            "    const char* p = sdp;\n"
            "    while (*p) {\n"
            "        const char* nl = strchr(p, '\\n');\n"
            "        size_t len = nl ? (size_t)(nl - p) : strlen(p);\n"
            "        if (len > 0 && p[len - 1] == '\\r') len--;\n"
            "        if (len >= 15 && strncmp(p, \"a=x-rl-control:\", 15) == 0) {\n"
            "            const char* cur = p + 15;\n"
            "            const char* end = p + len;\n"
            "            while (cur < end) {\n"
            "                const char* comma = memchr(cur, ',', (size_t)(end - cur));\n"
            "                const char* tok_end = comma ? comma : end;\n"
            "                while (cur < tok_end && (*cur == ' ' || *cur == '\\t')) cur++;\n"
            "                const char* trim_end = tok_end;\n"
            "                while (trim_end > cur && (trim_end[-1] == ' ' || trim_end[-1] == '\\t')) trim_end--;\n"
            "                size_t tlen = (size_t)(trim_end - cur);\n"
            "                if (tlen > 0 && tlen < 16) {\n"
            "                    char buf[16];\n"
            "                    memcpy(buf, cur, tlen);\n"
            "                    buf[tlen] = '\\0';\n"
            "                    char* endp = NULL;\n"
            "                    unsigned long v = strtoul(buf, &endp, 0);\n"
            "                    if (endp && *endp == '\\0' && v == 0x5543ul) return true;\n"
            "                }\n"
            "                cur = comma ? (comma + 1) : end;\n"
            "            }\n"
            "        }\n"
            "        p = nl ? (nl + 1) : (p + strlen(p));\n"
            "    }\n"
            "    return false;\n"
            "}\n"
        )
        rtsp_text = replace_exact(rtsp_text, '#include "Limelight-internal.h"', rtsp_header, "RtspConnection.c include")
        rfi_anchor = 'ReferenceFrameInvalidationSupported = strstr(response.payload, "x-nv-video[0].refPicInvalidation") != NULL;'
        rtsp_text = replace_exact(
            rtsp_text,
            rfi_anchor,
            rfi_anchor
            + '\n        atomic_store(&g_hasFrameWarpControl, rlHasFrameWarpControl(response.payload));',
            "RtspConnection.c RFI anchor",
        )
        new_rtsp, count = re.subn(
            r"(int\s+performRtspHandshake\s*\(\s*PSERVER_INFORMATION\s+serverInfo\s*\)\s*\{)",
            r"\1\n    atomic_store(&g_hasFrameWarpControl, false);",
            rtsp_text,
            count=1,
        )
        if count != 1:
            raise RuntimeError("performRtspHandshake anchor not found in RtspConnection.c")
        rtsp_text = replace_exact(
            new_rtsp,
            "if (*error == ECONNREFUSED) {",
            "if (*error == ECONNREFUSED\n#ifdef __WASI_ERRNO_CONNREFUSED\n                || *error == __WASI_ERRNO_CONNREFUSED\n#endif\n            ) {",
            "RtspConnection.c ECONNREFUSED retry",
        )
        rtsp_path.write_text(rtsp_text, encoding="utf-8")
        print(f"Patched {rtsp_path}")

    # 3. ControlStream.c — receive 0x5544..=0x5546 (ctlHdr is PNVCTL_ENET_PACKET_HEADER_V1, must free(ctlHdr)!)
    ctrl_path = src / "ControlStream.c"
    ctrl_text = ctrl_path.read_text(encoding="utf-8")
    if "g_frameWarpCallback" not in ctrl_text:
        ctrl_header = (
            '#include "Limelight-internal.h"\n'
            "static FrameWarpPacketCallback g_frameWarpCallback = NULL;\n"
            "void LiSetFrameWarpCallback(FrameWarpPacketCallback callback) { g_frameWarpCallback = callback; }\n"
        )
        ctrl_text = replace_exact(ctrl_text, '#include "Limelight-internal.h"', ctrl_header, "ControlStream.c include")

        term_anchor = "else if (ctlHdr->type == packetTypes[IDX_TERMINATION]) {"
        fw_branch = """else if (ctlHdr->type == 0x5544 || ctlHdr->type == 0x5545 || ctlHdr->type == 0x5546) {
                if (g_frameWarpCallback != NULL && packetLength >= (int)sizeof(*ctlHdr)) {
                    g_frameWarpCallback(
                        ctlHdr->type,
                        ((const uint8_t*)ctlHdr) + sizeof(*ctlHdr),
                        (size_t)(packetLength - (int)sizeof(*ctlHdr)));
                }
                free(ctlHdr);
            }
            else if (ctlHdr->type == packetTypes[IDX_TERMINATION]) {"""
        ctrl_text = replace_exact(ctrl_text, term_anchor, fw_branch, "ControlStream.c IDX_TERMINATION anchor")

        send_fn = """
int LiSendFrameWarpRequest(const uint8_t* payload, size_t len) {
    if (!payload || len == 0 || len > 64) {
        return -1;
    }
    return sendMessageEnet(0x5543, (unsigned int)len, payload, CTRL_CHANNEL_GENERIC, ENET_PACKET_FLAG_RELIABLE, false) ? 0 : -1;
}
"""
        ctrl_text = ctrl_text + "\n" + send_fn
        ctrl_path.write_text(ctrl_text, encoding="utf-8")
        print(f"Patched {ctrl_path}")

    # 4. PlatformSockets.c — Samsung Tizen WRT Sockets Extension workarounds
    ps_path = src / "PlatformSockets.c"
    if ps_path.exists():
        ps_text = ps_path.read_text(encoding="utf-8")
        if "NIGHTJAR_TIZEN_SOCKETS_PATCH" not in ps_text:
            ps_text = "/* NIGHTJAR_TIZEN_SOCKETS_PATCH */\n" + ps_text
            ps_text = replace_exact(
                ps_text,
                "int setSocketNonBlocking(SOCKET s, bool enabled) {\n#if defined(__vita__) || defined(__HAIKU__)",
                "int setSocketNonBlocking(SOCKET s, bool enabled) {\n"
                "#if defined(__EMSCRIPTEN__)\n"
                "    (void)s;\n"
                "    (void)enabled;\n"
                "    return SOCKET_ERROR;\n"
                "#elif defined(__vita__) || defined(__HAIKU__)",
                "PlatformSockets.c setSocketNonBlocking",
            )
            ps_text = replace_exact(
                ps_text,
                "LastSocketError() == ETIMEDOUT)) {",
                "LastSocketError() == ETIMEDOUT\n"
                "#ifdef __WASI_ERRNO_AGAIN\n"
                "                     || LastSocketError() == __WASI_ERRNO_AGAIN\n"
                "#endif\n"
                "#ifdef __WASI_ERRNO_INTR\n"
                "                     || LastSocketError() == __WASI_ERRNO_INTR\n"
                "#endif\n"
                "#ifdef __WASI_ERRNO_TIMEDOUT\n"
                "                     || LastSocketError() == __WASI_ERRNO_TIMEDOUT\n"
                "#endif\n"
                "                    )) {",
                "PlatformSockets.c recvUdpSocket timeout/again",
            )
            ps_text = replace_exact(
                ps_text,
                "    } while (err < 0 && LastSocketError() == ECONNREFUSED);",
                "    } while (err < 0 && (LastSocketError() == ECONNREFUSED\n"
                "#ifdef __WASI_ERRNO_CONNREFUSED\n"
                "        || LastSocketError() == __WASI_ERRNO_CONNREFUSED\n"
                "#endif\n"
                "    ));",
                "PlatformSockets.c recvUdpSocket ECONNREFUSED",
            )
            ps_text = replace_exact(
                ps_text,
                "if (err != EWOULDBLOCK && err != EAGAIN && err != EINPROGRESS) {",
                "if (err != EWOULDBLOCK && err != EAGAIN && err != EINPROGRESS\n"
                "#ifdef __WASI_ERRNO_AGAIN\n"
                "            && err != __WASI_ERRNO_AGAIN\n"
                "#endif\n"
                "#ifdef __WASI_ERRNO_INPROGRESS\n"
                "            && err != __WASI_ERRNO_INPROGRESS\n"
                "#endif\n"
                "        ) {",
                "PlatformSockets.c connectTcpSocket inprogress",
            )
            ps_path.write_text(ps_text, encoding="utf-8")
            print(f"Patched {ps_path}")

    # 5. enet/unix.c — SOCK_NONBLOCK at socket() creation & WASI errno mapping
    enet_unix = enet_dir / "unix.c"
    if enet_unix.exists():
        eu_text = enet_unix.read_text(encoding="utf-8")
        if "NIGHTJAR_TIZEN_ENET_PATCH" not in eu_text:
            eu_text = "/* NIGHTJAR_TIZEN_ENET_PATCH */\n" + eu_text
            eu_text = replace_exact(
                eu_text,
                "ENetSocket\nenet_socket_create (int af, ENetSocketType type)\n{\n"
                "    ENetSocket sock = socket (af, type == ENET_SOCKET_TYPE_DATAGRAM ? SOCK_DGRAM : SOCK_STREAM, 0);",
                "ENetSocket\nenet_socket_create (int af, ENetSocketType type)\n{\n"
                "    int sock_flags = 0;\n"
                "#if defined(__EMSCRIPTEN__)\n"
                "    sock_flags = SOCK_NONBLOCK;\n"
                "#endif\n"
                "    ENetSocket sock = socket (af, (type == ENET_SOCKET_TYPE_DATAGRAM ? SOCK_DGRAM : SOCK_STREAM) | sock_flags, 0);",
                "enet/unix.c enet_socket_create",
            )
            eu_text = replace_exact(
                eu_text,
                "        case ENET_SOCKOPT_NONBLOCK:\n#ifdef HAS_FCNTL\n"
                "            result = fcntl (socket, F_SETFL, (value ? O_NONBLOCK : 0) | (fcntl (socket, F_GETFL, 0) & ~O_NONBLOCK));",
                "        case ENET_SOCKOPT_NONBLOCK:\n"
                "#if defined(__EMSCRIPTEN__)\n"
                "            result = 0;\n"
                "#elif defined(HAS_FCNTL)\n"
                "            result = fcntl (socket, F_SETFL, (value ? O_NONBLOCK : 0) | (fcntl (socket, F_GETFL, 0) & ~O_NONBLOCK));",
                "enet/unix.c ENET_SOCKOPT_NONBLOCK",
            )
            eu_text = replace_exact(
                eu_text,
                "    if (result == -1 && errno == EINPROGRESS)\n      return 0;",
                "    if (result == -1 && (errno == EINPROGRESS\n"
                "#ifdef __WASI_ERRNO_INPROGRESS\n"
                "        || errno == __WASI_ERRNO_INPROGRESS\n"
                "#endif\n"
                "    ))\n      return 0;",
                "enet/unix.c enet_socket_connect",
            )
            eu_text = replace_exact(
                eu_text,
                "        switch (errno)\n        {\n        case EWOULDBLOCK:\n            return 0;",
                "        switch (errno)\n        {\n        case EWOULDBLOCK:\n"
                "#if defined(__WASI_ERRNO_AGAIN) && (__WASI_ERRNO_AGAIN != EWOULDBLOCK)\n"
                "        case __WASI_ERRNO_AGAIN:\n"
                "#endif\n"
                "            return 0;",
                "enet/unix.c enet_socket_send",
            )
            eu_text = replace_exact(
                eu_text,
                "       if (errno == EWOULDBLOCK)\n         return 0;",
                "       if (errno == EWOULDBLOCK\n"
                "#ifdef __WASI_ERRNO_AGAIN\n"
                "           || errno == __WASI_ERRNO_AGAIN\n"
                "#endif\n"
                "       )\n         return 0;",
                "enet/unix.c enet_socket_receive",
                expected_count=2,
            )
            enet_unix.write_text(eu_text, encoding="utf-8")
            print(f"Patched {enet_unix}")


if __name__ == "__main__":
    main()
