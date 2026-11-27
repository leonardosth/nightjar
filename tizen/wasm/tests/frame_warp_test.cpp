#include "codec_capabilities.hpp"
#include "frame_warp_predictor.hpp"
#include "frame_warp_protocol.hpp"
#include "host_http_client.hpp"
#include "stream_telemetry.hpp"
#include "tizen_audio_decoder.hpp"
#include "tizen_video_decoder.hpp"
#include "worker_queue.hpp"

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <future>
#include <iostream>
#include <vector>

#undef assert
#define assert(cond) do { \
    if (!(cond)) { \
        std::cerr << "Assertion failed: " #cond " at " << __FILE__ << ":" << __LINE__ << "\n"; \
        std::abort(); \
    } \
} while (0)

using namespace nightjar::frame_warp;
using namespace nightjar::tizen;

int main() {
    // 1. Request encode/decode
    FrameWarpRequest req{true, 3, 960, true};
    auto req_bytes = req.encode();
    assert(req_bytes[0] == 1 && req_bytes[1] == 1 && req_bytes[2] == 3 && req_bytes[3] == 1);
    auto req_dec = FrameWarpRequest::decode(req_bytes.data(), req_bytes.size());
    assert(req_dec.has_value() && req_dec->enabled && req_dec->controller == 3 && req_dec->mask_max_width == 960 && req_dec->lens);

    // 2. Model 52B & 48B decode
    Model m;
    m.generation = 7;
    m.mouse_locked = true;
    m.stick_locked = true;
    m.picture_width = 1920;
    m.picture_height = 1080;
    m.mouse_gain = {-2.0f, -2.0f};
    m.stick_gain = {-600.0f, 600.0f};
    m.stick_deadzone = 0.1f;
    m.stick_exponent = 2.0f;
    m.max_offset = {300.0f, 200.0f};
    m.lag_us = 25000;
    m.confidence = 0.95f;
    m.focal = 960.0f;
    auto m_bytes = m.encode();
    assert(m_bytes.has_value());
    auto m_dec = Model::decode(m_bytes->data(), m_bytes->size());
    assert(m_dec.has_value() && std::fabs(m_dec->focal - 960.0f) < 1e-4f);
    auto m_flat = Model::decode(m_bytes->data(), kModelFlatBytes);
    assert(m_flat.has_value() && m_flat->focal == 0.0f);

    // 3. HUD Mask LEB128 RLE + pack_r8 + halved
    Mask mask = Mask::create(2, 64, 32);
    mask.set(0, 0, true);
    mask.set(63, 31, true);
    mask.set(10, 5, true);
    auto mask_bytes = mask.encode();
    assert(mask_bytes.has_value());
    auto mask_dec = Mask::decode(mask_bytes->data(), mask_bytes->size());
    assert(mask_dec.has_value() && mask_dec->count() == 3 && mask_dec->get(0, 0) && mask_dec->get(63, 31));
    auto r8 = mask_dec->pack_r8();
    assert(r8.size() == 64 * 32 && r8[0] == 255 && r8[31 * 64 + 63] == 255 && r8[1] == 0);
    auto half = mask_dec->halved();
    assert(half.width == 32 && half.height == 16 && half.get(0, 0) && half.get(31, 15));

    // 4. Predictor shift + fade + lens
    Predictor pred(0);
    pred.on_model(m);
    pred.note_mouse(50, 0, 10000);
    Tags tags{7, {Tag{10, 20, 0, 0, kHeldNone}}};
    pred.on_tags(tags, 10000);
    (void)pred.warp(10, 10000);
    auto w = pred.warp(10, 160000);
    assert(w.active);
    assert(w.pixels[0] < -59.0f && w.pixels[0] > -61.5f);

    // 5. XML parsing for /serverinfo (<FrameWarpVersion>) & /applist
    std::string server_xml = "<root><hostname>Rubylight-PC</hostname><FrameWarpVersion>1</FrameWarpVersion></root>";
    assert(HostHttpClient::parse_frame_warp_version(server_xml) == 1);
    assert(HostHttpClient::parse_frame_warp_version("<root><FrameWarpVersion>0</FrameWarpVersion></root>") == 0);
    assert(HostHttpClient::parse_frame_warp_version("<root></root>") == 0);

    std::string apps_xml = "<root><App><ID>101</ID><AppTitle>Desktop</AppTitle><IsHdrSupported>1</IsHdrSupported></App></root>";
    auto apps = HostHttpClient::parse_applist_xml(apps_xml);
    assert(apps.size() == 1 && apps[0].id == 101 && apps[0].title == "Desktop" && apps[0].hdr_supported);

    // 6. Codec MIME levels for 4K60, 4K120, HDR10
    assert(build_video_mime("hevc", 3840, 2160, 60, false) == "video/mp4; codecs=\"hev1.1.6.L153.B0\"");
    assert(build_video_mime("hevc", 3840, 2160, 120, false) == "video/mp4; codecs=\"hev1.1.6.L156.B0\"");
    assert(build_video_mime("hevc", 3840, 2160, 120, true) == "video/mp4; codecs=\"hev1.2.4.L156.B0\"");
    assert(build_video_mime("av1", 3840, 2160, 120, false) == "video/mp4; codecs=\"av01.0.13M.08\"");
    assert(build_video_mime("av1", 3840, 2160, 120, true) == "video/mp4; codecs=\"av01.0.13M.10\"");
    assert(build_video_mime("h264", 1920, 1080, 120, false) == "video/mp4; codecs=\"avc1.640032\"");

    // 7. Strict RTSP DESCRIBE control parsing
    assert(sdp_offers_frame_warp("a=x-rl-control:0x5530, 0x5543, 0x5544\r\n"));
    assert(sdp_offers_frame_warp("a=x-rl-control:21827\n"));
    assert(!sdp_offers_frame_warp("a=x-other:0x5543\r\n"));
    assert(!sdp_offers_frame_warp("a=x-rl-control:0x55430\r\n"));

    // 8. ServerCodecModeSupport & non-constant random unique_id
    assert(HostHttpClient::parse_server_codec_mode_support(
               "<root><ServerCodecModeSupport>262915</ServerCodecModeSupport></root>") == 262915u);
    HostHttpClient c1, c2;
    c1.init_identity("", "", "");
    c2.init_identity("", "", "");
    assert(c1.identity().unique_id.size() == 16 && c1.identity().unique_id != "0123456789ABCDEF");
    assert(c1.identity().unique_id != c2.identity().unique_id);
    c1.set_pinned_server_cert("192.168.1.50", "CERT_PEM");
    assert(c1.pinned_server_cert("192.168.1.50") == "CERT_PEM");

    // 9. WorkerQueue executes 50 jobs in strict FIFO order on a single worker thread
    {
        WorkerQueue wq;
        std::vector<int> order;
        std::mutex order_mu;
        std::promise<void> done_promise;
        for (int i = 0; i < 50; ++i) {
            wq.enqueue([&, i]() {
                {
                    std::lock_guard<std::mutex> lk(order_mu);
                    order.push_back(i);
                }
                if (i == 49) done_promise.set_value();
            });
        }
        done_promise.get_future().wait();
        assert(order.size() == 50);
        for (int i = 0; i < 50; ++i) assert(order[static_cast<size_t>(i)] == i);
    }

    // 10. TizenAudioDecoder advances monotonic audio PTS safely in host-test mode
    {
        TizenAudioDecoder audio;
        AudioConfig acfg;
        acfg.sample_rate = 48000;
        acfg.channel_count = 2;
        acfg.samples_per_frame = 240;
        assert(audio.initialize(acfg, nullptr));
        const uint8_t dummy[4] = {0, 0, 0, 0};
        audio.decode_and_play(dummy, sizeof(dummy));
        audio.decode_and_play(dummy, sizeof(dummy));
        assert(std::fabs(audio.current_pts_sec() - (480.0 / 48000.0)) < 1e-6);
        audio.shutdown();
    }

    // 11. FrameRing nearest PTS lookup within half-frame tolerance
    {
        FrameRing ring;
        ring.note(0, 100);
        ring.note(8333, 101);
        ring.note(16666, 102);
        assert(ring.lookup_nearest(8330, 4000) == 101u);
        assert(!ring.lookup_nearest(50000, 4000).has_value());
    }

    // 12. TextureRing keeps displayed texture un-recycled across 120 Hz inter-frame redraws
    {
        TextureRing tr;
        tr.init({11u, 22u, 33u});
        auto s0 = tr.acquire_for_fill();
        assert(s0.has_value() && *s0 == 0u);
        tr.mark_filled(*s0, 500u);

        uint32_t f = 0;
        std::optional<GLuint> recycle;
        assert(tr.swap_to_display(f, recycle) && f == 500u && !recycle.has_value());
        assert(tr.current_display_texture() == 11u);
        assert(!tr.swap_to_display(f, recycle));
        assert(tr.current_display_texture() == 11u);

        auto s1 = tr.acquire_for_fill();
        assert(s1.has_value() && *s1 == 1u);
        tr.mark_filled(*s1, 501u);
        assert(tr.swap_to_display(f, recycle) && f == 501u && recycle == 11u);
        assert(tr.current_display_texture() == 22u);

        // Overwriting an unconsumed ready_ slot must recycle the superseded texture and never leak a slot
        auto s2 = tr.acquire_for_fill();
        assert(s2.has_value());
        std::optional<GLuint> superseded;
        tr.mark_filled(*s2, 502u, superseded);
        assert(!superseded.has_value());
        auto s3 = tr.acquire_for_fill();
        assert(s3.has_value());
        tr.mark_filled(*s3, 503u, superseded);
        assert(superseded.has_value()); // slot s2 was returned to Free and its texture handed back to recycle

        // Generation guard rejects stale in-flight callbacks after reset()
        uint64_t stale_gen = tr.generation();
        tr.reset();
        auto s4 = tr.acquire_for_fill();
        assert(s4.has_value());
        tr.mark_filled(*s4, 999u, superseded, stale_gen);
        assert(!tr.swap_to_display(f, recycle)); // stale callback ignored

        // filled_us timestamp round-trips through mark_filled -> swap_to_display
        auto s5 = tr.acquire_for_fill();
        assert(s5.has_value());
        std::optional<GLuint> sup5;
        bool tagged5 = false;
        uint64_t filled5 = 0;
        tr.mark_filled(*s5, 777u, sup5, std::nullopt, true, 123456789ull);
        assert(tr.swap_to_display(f, recycle, &tagged5, &filled5));
        assert(f == 777u && tagged5 && filled5 == 123456789ull);
    }

    // 15. LatencyWindow and PendingFrameQueue telemetry primitives
    {
        LatencyWindow lw;
        lw.add_us(1000);
        lw.add_us(3000);
        lw.add_us(2000);
        auto snap1 = lw.roll();
        assert(snap1.count == 3);
        assert(std::fabs(snap1.min_ms - 1.0) < 1e-6);
        assert(std::fabs(snap1.avg_ms - 2.0) < 1e-6);
        assert(std::fabs(snap1.max_ms - 3.0) < 1e-6);
        auto snap2 = lw.roll();
        assert(snap2.count == 0);

        PendingFrameQueue q;
        q.push({10, 0, 100});
        q.push({11, 8333, 200});
        q.push({12, 16666, 300});
        auto r1 = q.resolve(std::nullopt);
        assert(r1.has_value() && r1->frame == 10);
        auto r2 = q.resolve(12);
        assert(r2.has_value() && r2->frame == 12);
        assert(q.size() == 0);

        for (uint32_t i = 0; i < 70; ++i) {
            q.push({i, static_cast<int64_t>(i) * 1000, i});
        }
        assert(q.size() == PendingFrameQueue::kCapacity);
        auto oldest = q.resolve(std::nullopt);
        assert(oldest.has_value() && oldest->frame == 6); // 0..5 dropped

        q.clear();
        q.push({5, 0, 50});
        auto fallback = q.resolve(999);
        assert(fallback.has_value() && fallback->frame == 5);
        assert(!q.resolve(std::nullopt).has_value());
    }

    // 14. TizenAudioDecoder::open_track_on_main_thread and reconfigure_opus are split cleanly
    {
        TizenAudioDecoder audio;
        assert(audio.open_track_on_main_thread(48000, false, nullptr));
        AudioConfig acfg;
        acfg.sample_rate = 48000;
        acfg.channel_count = 2;
        acfg.samples_per_frame = 240;
        assert(audio.reconfigure_opus(acfg));
        audio.shutdown();
    }

    // 13. Golden malformed 0x5546 HUD mask RLE rejection (network fuzz edge cases)
    {
        // Truncated varint
        const uint8_t trunc_varint[] = {1, 1, 1, 0, 8, 0, 1, 0, 0x80};
        assert(!Mask::decode(trunc_varint, sizeof(trunc_varint)).has_value());
        // Zero middle run (forbidden except first run of a row)
        const uint8_t zero_mid[] = {1, 1, 1, 0, 8, 0, 1, 0, 4, 0, 4};
        assert(!Mask::decode(zero_mid, sizeof(zero_mid)).has_value());
        // Row sum exceeds width
        const uint8_t over_row[] = {1, 1, 1, 0, 8, 0, 1, 0, 9};
        assert(!Mask::decode(over_row, sizeof(over_row)).has_value());
        // Width > 2048
        const uint8_t wide_mask[] = {1, 1, 1, 0, 0x01, 0x08, 1, 0, 1};
        assert(!Mask::decode(wide_mask, sizeof(wide_mask)).has_value());
        // Payload > 48 KiB
        std::vector<uint8_t> huge(49153, 0);
        huge[0] = 1; huge[1] = 1; huge[4] = 8; huge[6] = 1;
        assert(!Mask::decode(huge.data(), huge.size()).has_value());
    }

    std::cout << "All C++ Frame Warp & HostHttpClient tests passed!\n";
    return 0;
}
