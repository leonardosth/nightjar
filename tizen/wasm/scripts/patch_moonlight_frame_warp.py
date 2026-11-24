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
    patch_file(
        src / "Limelight.h",
        "LiSetFrameWarpCallback",
        "#ifdef __cplusplus\n}\n#endif",
        """// Nightjar / Rubylight Frame Warp v1 hooks (0x5543..=0x5546)
typedef void (*FrameWarpPacketCallback)(uint16_t msgType, const uint8_t* data, size_t len);
void LiSetFrameWarpCallback(FrameWarpPacketCallback callback);
bool LiHasFrameWarpControl(void);
int LiSendFrameWarpRequest(const uint8_t* payload, size_t len);

#ifdef __cplusplus
}
#endif""",
    )

    # 2. RtspConnection.c — detect 0x5543 on a=x-rl-control in RTSP DESCRIBE response
    rtsp_path = src / "RtspConnection.c"
    rtsp_text = rtsp_path.read_text(encoding="utf-8")
    if "g_hasFrameWarpControl" not in rtsp_text:
        rtsp_text = (
            "static bool g_hasFrameWarpControl = false;\n"
            "bool LiHasFrameWarpControl(void) { return g_hasFrameWarpControl; }\n"
            + rtsp_text
        )
        # Detect a=x-rl-control line carrying 0x5543 during DESCRIBE parsing
        anchor = "if (!describe(ctx"
        if anchor not in rtsp_text:
            anchor = "performRtspHandshake("
        rtsp_path.write_text(rtsp_text, encoding="utf-8")
        # Hook right after DESCRIBE payload is received
        rtsp_text = rtsp_path.read_text(encoding="utf-8")
        desc_anchor = "strstr(response.payload, \"sprop-parameter-sets\")"
        if desc_anchor in rtsp_text:
            rtsp_text = rtsp_text.replace(
                desc_anchor,
                "(g_hasFrameWarpControl = (response.payload != NULL && strstr(response.payload, \"a=x-rl-control:\") != NULL && strstr(response.payload, \"0x5543\") != NULL)), "
                + desc_anchor,
                1,
            )
            rtsp_path.write_text(rtsp_text, encoding="utf-8")
        print(f"Patched {rtsp_path}")

    # 3. ControlStream.c — receive 0x5544..=0x5546 and send 0x5543 over SS_ENC_CONTROL_V2
    ctrl_path = src / "ControlStream.c"
    ctrl_text = ctrl_path.read_text(encoding="utf-8")
    if "g_frameWarpCallback" not in ctrl_text:
        header_add = """
static FrameWarpPacketCallback g_frameWarpCallback = NULL;
void LiSetFrameWarpCallback(FrameWarpPacketCallback callback) {
    g_frameWarpCallback = callback;
}
"""
        ctrl_text = ctrl_text.replace("#include \"Limelight-internal.h\"", "#include \"Limelight-internal.h\"\n" + header_add, 1)

        # Dispatch 0x5544, 0x5545, 0x5546 inside encrypted control receive handler
        recv_anchor = "case IDX_TERMINATION:"
        if recv_anchor in ctrl_text:
            fw_cases = """case 0x5544:
        case 0x5545:
        case 0x5546:
            if (g_frameWarpCallback != NULL && packetLength >= sizeof(NVCTL_ENET_PACKET_HEADER_V2)) {
                g_frameWarpCallback(
                    ctlHdr->type,
                    ((const uint8_t*)ctlHdr) + sizeof(NVCTL_ENET_PACKET_HEADER_V2),
                    packetLength - sizeof(NVCTL_ENET_PACKET_HEADER_V2));
            }
            break;
        case IDX_TERMINATION:"""
            ctrl_text = ctrl_text.replace(recv_anchor, fw_cases, 1)

        # Reliable send for 0x5543 FrameWarpRequest
        send_fn = """
int LiSendFrameWarpRequest(const uint8_t* payload, size_t len) {
    if (!payload || len == 0 || len > 64) {
        return -1;
    }
    return sendMessageEnet(0x5543, (short)len, payload, CTRL_CHANNEL_GENERIC, ENET_PACKET_FLAG_RELIABLE, false) ? 0 : -1;
}
"""
        ctrl_text = ctrl_text + "\n" + send_fn
        ctrl_path.write_text(ctrl_text, encoding="utf-8")
        print(f"Patched {ctrl_path}")

if __name__ == "__main__":
    main()
