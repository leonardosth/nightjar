#!/usr/bin/env python3
"""
Surgically patches moonlight-common-c to expose Nightjar/Rubylight Frame Warp v1 hooks:
  - LiHasFrameWarpControl()         (RTSP DESCRIBE a=x-rl-control 0x5543 detection)
  - LiSetFrameWarpCallback(cb)      (ENet SS_ENC_CONTROL_V2 0x5544/0x5545/0x5546 receive)
  - LiSendFrameWarpRequest(ptr,len) (ENet SS_ENC_CONTROL_V2 0x5543 reliable send)
"""
import pathlib
import sys


def patch_file(path: pathlib.Path, marker: str, anchor: str, replacement: str) -> None:
    text = path.read_text(encoding="utf-8")
    if marker in text:
        return
    if anchor not in text:
        raise RuntimeError(f"Anchor not found in {path}: {anchor!r}")
    path.write_text(text.replace(anchor, replacement, 1), encoding="utf-8")
    print(f"Patched {path}")


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

    # 2. RtspConnection.c — detect 0x5543 on a=x-rl-control in RTSP DESCRIBE response
    rtsp_path = src / "RtspConnection.c"
    rtsp_text = rtsp_path.read_text(encoding="utf-8")
    if "g_hasFrameWarpControl" not in rtsp_text:
        rtsp_header = (
            '#include "Limelight-internal.h"\n'
            "static bool g_hasFrameWarpControl = false;\n"
            "bool LiHasFrameWarpControl(void) { return g_hasFrameWarpControl; }\n"
        )
        rtsp_text = rtsp_text.replace('#include "Limelight-internal.h"', rtsp_header, 1)
        rfi_anchor = 'ReferenceFrameInvalidationSupported = strstr(response.payload, "x-nv-video[0].refPicInvalidation") != NULL;'
        if rfi_anchor not in rtsp_text:
            raise RuntimeError("RFI anchor not found in RtspConnection.c")
        rtsp_text = rtsp_text.replace(
            rfi_anchor,
            rfi_anchor
            + '\n        g_hasFrameWarpControl = (strstr(response.payload, "a=x-rl-control:") != NULL && strstr(response.payload, "0x5543") != NULL);',
            1,
        )
        rtsp_path.write_text(rtsp_text, encoding="utf-8")
        print(f"Patched {rtsp_path}")

    # 3. ControlStream.c — receive 0x5544..=0x5546 and send 0x5543 over SS_ENC_CONTROL_V2
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
                if (g_frameWarpCallback != NULL) {
                    g_frameWarpCallback(ctlHdr->type, (const uint8_t*)(ctlHdr + 1), ctlHdr->payloadLength);
                }
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
