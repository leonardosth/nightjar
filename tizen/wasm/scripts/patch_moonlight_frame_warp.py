#!/usr/bin/env python3
"""
Surgically patches moonlight-common-c to expose Nightjar/Rubylight Frame Warp v1 hooks:
  - LiHasFrameWarpControl()         (RTSP DESCRIBE a=x-rl-control 0x5543 detection)
  - LiSetFrameWarpCallback(cb)      (ENet SS_ENC_CONTROL_V2 0x5544/0x5545/0x5546 receive)
  - LiSendFrameWarpRequest(ptr,len) (ENet SS_ENC_CONTROL_V2 0x5543 reliable send)
"""
import pathlib
import re
import sys


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: patch_moonlight_frame_warp.py <moonlight-common-c-dir>", file=sys.stderr)
        sys.exit(2)

    root = pathlib.Path(sys.argv[1])
    src = root / "src"

    # 1. Limelight.h — public C API for Frame Warp v1
    limelight_h = src / "Limelight.h"
    h_text = limelight_h.read_text(encoding="utf-8")
    if "LiSetFrameWarpCallback" not in h_text:
        h_text = "#include <stdbool.h>\n#include <stddef.h>\n#include <stdint.h>\n" + h_text
        end_anchor = "#ifdef __cplusplus\n}\n#endif"
        if end_anchor not in h_text:
            raise RuntimeError("End anchor not found in Limelight.h")
        h_add = """// Nightjar / Rubylight Frame Warp v1 hooks (0x5543..=0x5546)
typedef void (*FrameWarpPacketCallback)(uint16_t msgType, const uint8_t* data, size_t len);
void LiSetFrameWarpCallback(FrameWarpPacketCallback callback);
bool LiHasFrameWarpControl(void);
int LiSendFrameWarpRequest(const uint8_t* payload, size_t len);

#ifdef __cplusplus
}
#endif"""
        h_text = h_text.replace(end_anchor, h_add, 1)
        limelight_h.write_text(h_text, encoding="utf-8")
        print(f"Patched {limelight_h}")

    # 2. RtspConnection.c — strict token parse of 0x5543 on a=x-rl-control in RTSP DESCRIBE response
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
        rtsp_text = rtsp_text.replace('#include "Limelight-internal.h"', rtsp_header, 1)
        rfi_anchor = 'ReferenceFrameInvalidationSupported = strstr(response.payload, "x-nv-video[0].refPicInvalidation") != NULL;'
        if rfi_anchor not in rtsp_text:
            raise RuntimeError("RFI anchor not found in RtspConnection.c")
        rtsp_text = rtsp_text.replace(
            rfi_anchor,
            rfi_anchor
            + '\n        atomic_store(&g_hasFrameWarpControl, rlHasFrameWarpControl(response.payload));',
            1,
        )
        new_rtsp, count = re.subn(
            r"(int\s+performRtspHandshake\s*\(\s*PSERVER_INFORMATION\s+serverInfo\s*\)\s*\{)",
            r"\1\n    atomic_store(&g_hasFrameWarpControl, false);",
            rtsp_text,
            count=1,
        )
        if count != 1:
            raise RuntimeError("performRtspHandshake anchor not found in RtspConnection.c")
        rtsp_text = new_rtsp
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
        ctrl_text = ctrl_text.replace('#include "Limelight-internal.h"', ctrl_header, 1)

        term_anchor = "else if (ctlHdr->type == packetTypes[IDX_TERMINATION]) {"
        if term_anchor not in ctrl_text:
            raise RuntimeError("IDX_TERMINATION anchor not found in ControlStream.c")
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
        ctrl_text = ctrl_text.replace(term_anchor, fw_branch, 1)

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


if __name__ == "__main__":
    main()
