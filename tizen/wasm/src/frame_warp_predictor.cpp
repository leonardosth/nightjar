#include "frame_warp_predictor.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace nightjar::frame_warp {

namespace {

bool after_u32(uint32_t a, uint32_t b) {
    return a != b && static_cast<uint32_t>(a - b) < 0x7FFFFFFFu;
}

uint32_t float_to_bits(float f) {
    uint32_t u = 0;
    std::memcpy(&u, &f, sizeof(u));
    return u;
}

float bits_to_float(uint32_t u) {
    float f = 0.0f;
    std::memcpy(&f, &u, sizeof(f));
    return f;
}

} // namespace

std::pair<std::array<float, 2>, std::array<float, 4>> lens_terms(
    std::array<float, 2> pixels, float focal, uint16_t width, uint16_t height) {
    if (!(std::isfinite(focal) && focal > 0.0f)) {
        return {pixels, kFlatLens};
    }
    float w = static_cast<float>(std::max<uint16_t>(1, width));
    float h = static_cast<float>(std::max<uint16_t>(1, height));
    float tx = std::tan(std::clamp(pixels[0] / focal, -1.4f, 1.4f));
    float ty = std::tan(std::clamp(pixels[1] / focal, -1.4f, 1.4f));
    return {
        {tx * focal, ty * focal},
        {tx * w / focal, ty * h / focal, std::sqrt(1.0f + ty * ty), std::sqrt(1.0f + tx * tx)},
    };
}

void FrameRing::note(int64_t pts_us, uint32_t frame_number) {
    entries_[next_] = Entry{pts_us, frame_number, true};
    next_ = (next_ + 1) % kCapacity;
}

std::optional<uint32_t> FrameRing::lookup(int64_t pts_us) const {
    for (size_t i = 0; i < kCapacity; ++i) {
        size_t idx = (next_ + kCapacity - 1 - i) % kCapacity;
        if (entries_[idx].valid && entries_[idx].pts_us == pts_us) {
            return entries_[idx].frame;
        }
    }
    return std::nullopt;
}

std::optional<uint32_t> FrameRing::lookup_nearest(int64_t pts_us, int64_t tolerance_us) const {
    std::optional<uint32_t> best;
    int64_t best_diff = tolerance_us + 1;
    for (size_t i = 0; i < kCapacity; ++i) {
        size_t idx = (next_ + kCapacity - 1 - i) % kCapacity;
        if (!entries_[idx].valid) continue;
        int64_t diff = entries_[idx].pts_us >= pts_us
            ? (entries_[idx].pts_us - pts_us)
            : (pts_us - entries_[idx].pts_us);
        if (diff <= tolerance_us && diff < best_diff) {
            best_diff = diff;
            best = entries_[idx].frame;
            if (diff == 0) break;
        }
    }
    return best;
}

void FrameRing::clear() {
    entries_.fill(Entry{});
    next_ = 0;
}

Predictor::Predictor(std::optional<uint8_t> controller) : controller_(controller) {}

void Predictor::reset() {
    model_.reset();
    fading_.reset();
    weight_ = 0.0f;
    weight_at_us_.reset();
    tags_.fill(std::nullopt);
    newest_.reset();
    mouse_x_ = 0;
    mouse_y_ = 0;
    mouse_offset_x_ = 0;
    mouse_offset_y_ = 0;
    last_mouse_us_.reset();
    controller_seq_ = 0;
    seq_offset_ = 0;
    last_controller_us_.reset();
    stick_.clear();
    mask_generation_.reset();
    mask_cells_ = 0;
    last_ = {0.0f, 0.0f};
    peaks_.clear();
    warped_ = 0;
    extrapolated_ = 0;
    untagged_ = 0;
}

void Predictor::note_mouse(int16_t dx, int16_t dy, uint64_t now_us) {
    if (dx == 0 && dy == 0) return;
    mouse_x_ = static_cast<int32_t>(static_cast<uint32_t>(mouse_x_) + static_cast<uint32_t>(static_cast<int32_t>(dx)));
    mouse_y_ = static_cast<int32_t>(static_cast<uint32_t>(mouse_y_) + static_cast<uint32_t>(static_cast<int32_t>(dy)));
    last_mouse_us_ = now_us;
}

void Predictor::note_controller(uint16_t number, int16_t rx, int16_t ry, uint64_t now_us) {
    if (!controller_.has_value() || static_cast<uint16_t>(*controller_) != number) return;
    controller_seq_ += 1u;
    last_controller_us_ = now_us;
    uint64_t at_us = stick_.empty() ? now_us : std::max(now_us, stick_.back().at_us);
    stick_.push_back(StickSample{at_us, controller_seq_, rx, ry});
    while (stick_.size() > kStickSamples ||
           (stick_.size() > 1 && at_us - stick_[1].at_us > kStickHistoryUs)) {
        stick_.pop_front();
    }
}

void Predictor::on_model(const Model& model) {
    if (model.locked()) fading_ = model;
    model_ = model;
}

void Predictor::on_mask(std::optional<uint16_t> generation, size_t cells) {
    mask_generation_ = generation;
    mask_cells_ = cells;
}

void Predictor::on_tags(const Tags& tags, uint64_t now_us) {
    std::optional<Tag> newest;
    for (const Tag& t : tags.tags) {
        tags_[t.frame % kTagSlots] = t;
        if (!newest.has_value() || after_u32(t.frame, newest->frame)) {
            newest = t;
        }
    }
    if (!newest.has_value()) return;
    if (newest_.has_value() && !after_u32(newest->frame, *newest_)) return;
    newest_ = newest->frame;

    auto is_idle = [now_us](std::optional<uint64_t> last) {
        return !last.has_value() || (now_us >= *last && (now_us - *last) >= kRebaseIdleUs);
    };
    if (is_idle(last_mouse_us_)) {
        mouse_offset_x_ = static_cast<int32_t>(static_cast<uint32_t>(mouse_x_) - static_cast<uint32_t>(newest->mouse_x));
        mouse_offset_y_ = static_cast<int32_t>(static_cast<uint32_t>(mouse_y_) - static_cast<uint32_t>(newest->mouse_y));
    }
    if (is_idle(last_controller_us_)) {
        seq_offset_ = controller_seq_ - newest->controller_seq;
    }
}

std::optional<std::pair<Tag, bool>> Predictor::lookup_tag(uint32_t frame) const {
    auto slot = [this](uint32_t f) -> std::optional<Tag> {
        const auto& t = tags_[f % kTagSlots];
        if (t.has_value() && t->frame == f) return t;
        return std::nullopt;
    };
    if (auto exact = slot(frame)) return std::make_pair(*exact, false);

    auto prev = [&](uint32_t before, uint32_t within) -> std::optional<Tag> {
        for (uint32_t back = 1; back <= within; ++back) {
            if (auto found = slot(before - back)) return found;
        }
        return std::nullopt;
    };

    auto a = prev(frame, kMaxExtrapolation);
    if (!a.has_value()) return std::nullopt;
    auto b = prev(a->frame, kMaxExtrapolation);
    if (!b.has_value()) {
        Tag copy = *a;
        copy.frame = frame;
        return std::make_pair(copy, true);
    }

    int64_t ahead = static_cast<int64_t>(static_cast<uint32_t>(frame - a->frame));
    int64_t span  = static_cast<int64_t>(static_cast<uint32_t>(a->frame - b->frame));
    auto step = [ahead, span](int32_t av, int32_t bv) {
        int64_t rate = static_cast<int64_t>(static_cast<int32_t>(static_cast<uint32_t>(av) - static_cast<uint32_t>(bv)));
        int32_t delta = static_cast<int32_t>((rate * ahead) / span);
        return static_cast<int32_t>(static_cast<uint32_t>(av) + static_cast<uint32_t>(delta));
    };

    Tag out = *a;
    out.frame = frame;
    out.mouse_x = step(a->mouse_x, b->mouse_x);
    out.mouse_y = step(a->mouse_y, b->mouse_y);
    return std::make_pair(out, true);
}

const Predictor::StickSample* Predictor::stick_sample(uint32_t seq) const {
    if (stick_.empty()) return nullptr;
    uint32_t back = stick_.back().seq - seq;
    if (back >= stick_.size()) return nullptr;
    const StickSample& s = stick_[stick_.size() - 1 - back];
    return s.seq == seq ? &s : nullptr;
}

std::array<float, 2> Predictor::stick_unreflected(const Tag& tag, const Model& model, uint64_t now_us) const {
    if (stick_.empty()) return {0.0f, 0.0f};
    uint64_t earliest = now_us > kMaxStickWindowUs ? now_us - kMaxStickWindowUs : 0;
    uint32_t host_seq = tag.controller_seq + seq_offset_;
    const StickSample& newest = stick_.back();
    if (host_seq != newest.seq && after_u32(host_seq, newest.seq)) {
        return {0.0f, 0.0f};
    }

    uint64_t start = earliest;
    if (tag.controller_held_us != kHeldNone && tag.controller_seq != 0) {
        if (const StickSample* sample = stick_sample(host_seq)) {
            start = sample->at_us + static_cast<uint64_t>(tag.controller_held_us);
        }
    }
    start = std::clamp(start, earliest, now_us);

    size_t first = 0;
    for (size_t i = stick_.size(); i-- > 0;) {
        if (stick_[i].at_us <= start) {
            first = i;
            break;
        }
    }

    std::array<float, 2> sum = {0.0f, 0.0f};
    for (size_t i = first; i < stick_.size(); ++i) {
        const StickSample& s = stick_[i];
        uint64_t end = std::min(i + 1 < stick_.size() ? stick_[i + 1].at_us : now_us, now_us);
        uint64_t from = std::max(s.at_us, start);
        if (end <= from) continue;
        float held = static_cast<float>(end - from) / 1000000.0f;
        auto curve = stick_curve(s.rx, s.ry, model.stick_deadzone, model.stick_exponent);
        sum[0] += curve[0] * held;
        sum[1] += curve[1] * held;
    }
    return sum;
}

void Predictor::update_weight(bool locked, uint64_t now_us) {
    float target = locked ? 1.0f : 0.0f;
    uint64_t elapsed = (weight_at_us_.has_value() && now_us > *weight_at_us_) ? (now_us - *weight_at_us_) : 0;
    weight_at_us_ = now_us;
    float step = static_cast<float>(elapsed) / static_cast<float>(kFadeUs);
    weight_ = weight_ < target ? std::min(weight_ + step, target) : std::max(weight_ - step, target);
}

Warp Predictor::warp(uint32_t frame, uint64_t now_us) {
    return compute_shift(frame, now_us, true);
}

Warp Predictor::peek(uint32_t frame, uint64_t now_us) {
    return compute_shift(frame, now_us, false);
}

Warp Predictor::compute_shift(uint32_t frame, uint64_t now_us, bool drawn) {
    bool locked = model_.has_value() && model_->locked();
    update_weight(locked, now_us);
    std::optional<Model> active_model = locked ? model_ : fading_;
    if (!active_model.has_value() || weight_ <= 0.0f) {
        if (drawn) record({0.0f, 0.0f}, now_us);
        return Warp{};
    }

    auto found = lookup_tag(frame);
    if (!found.has_value()) {
        if (drawn) {
            ++untagged_;
            record({0.0f, 0.0f}, now_us);
        }
        return Warp{};
    }
    if (found->second && drawn) ++extrapolated_;
    const Tag& tag = found->first;
    const Model& model = *active_model;

    std::array<float, 2> shift = {0.0f, 0.0f};
    if (model.mouse_locked) {
        int32_t dx = static_cast<int32_t>(static_cast<uint32_t>(mouse_x_) - static_cast<uint32_t>(tag.mouse_x) - static_cast<uint32_t>(mouse_offset_x_));
        int32_t dy = static_cast<int32_t>(static_cast<uint32_t>(mouse_y_) - static_cast<uint32_t>(tag.mouse_y) - static_cast<uint32_t>(mouse_offset_y_));
        if (std::abs(static_cast<int64_t>(dx)) < kMouseSanity && std::abs(static_cast<int64_t>(dy)) < kMouseSanity) {
            shift[0] += model.mouse_gain[0] * static_cast<float>(dx);
            shift[1] += model.mouse_gain[1] * static_cast<float>(dy);
        }
    }
    if (model.stick_locked && controller_.has_value()) {
        auto sec = stick_unreflected(tag, model, now_us);
        shift[0] += model.stick_gain[0] * sec[0];
        shift[1] += model.stick_gain[1] * sec[1];
    }

    shift[0] = std::clamp(shift[0], -model.max_offset[0], model.max_offset[0]) * weight_;
    shift[1] = std::clamp(shift[1], -model.max_offset[1], model.max_offset[1]) * weight_;

    auto [pixels, lens] = (model.focal > 0.0f)
        ? lens_terms(shift, model.focal, model.picture_width, model.picture_height)
        : std::make_pair(shift, kFlatLens);

    if (drawn) {
        ++warped_;
        record(pixels, now_us);
    }

    bool active = std::fabs(pixels[0]) >= 0.01f || std::fabs(pixels[1]) >= 0.01f;
    Warp out;
    out.pixels = pixels;
    out.uv = {
        pixels[0] / static_cast<float>(model.picture_width),
        pixels[1] / static_cast<float>(model.picture_height),
    };
    out.lens = active ? lens : kFlatLens;
    out.active = active;
    out.mask_generation = active ? mask_generation_ : std::nullopt;
    return out;
}

void Predictor::record(std::array<float, 2> shift, uint64_t now_us) {
    last_ = shift;
    float length = std::hypot(shift[0], shift[1]);
    while (!peaks_.empty() && now_us > peaks_.front().first && (now_us - peaks_.front().first) > 1000000) {
        peaks_.pop_front();
    }
    if (length > 0.0f) {
        peaks_.emplace_back(now_us, length);
        if (peaks_.size() > 2048) peaks_.pop_front();
    }
}

Status Predictor::status(uint64_t now_us) const {
    float peak = 0.0f;
    for (const auto& [at, len] : peaks_) {
        if (now_us >= at && (now_us - at) <= 1000000 && len > peak) peak = len;
    }
    return Status{model_, last_, peak, warped_, extrapolated_, untagged_, mask_cells_};
}

FrameWarp::FrameWarp(std::optional<uint8_t> controller, uint16_t mask_max_width)
    : controller_(controller), mask_max_width_(mask_max_width), predictor_(controller) {}

FrameWarpRequest FrameWarp::request(bool enabled, bool lens) {
    if (started_.exchange(enabled, std::memory_order_acq_rel) != enabled && enabled) {
        std::lock_guard<std::mutex> lock(mu_);
        predictor_.reset();
        mask_.reset();
        frame_ring_.clear();
        deadzone_bits_.store(float_to_bits(0.0f), std::memory_order_release);
    }
    return FrameWarpRequest{enabled, controller_, mask_max_width_, lens};
}

void FrameWarp::note_mouse(int16_t dx, int16_t dy, uint64_t now_us) {
    {
        std::lock_guard<std::mutex> lock(mu_);
        predictor_.note_mouse(dx, dy, now_us);
    }
    if (dx != 0 || dy != 0) input_seq_.fetch_add(1u, std::memory_order_acq_rel);
}

void FrameWarp::note_controller(uint16_t number, int16_t rx, int16_t ry, uint64_t now_us) {
    {
        std::lock_guard<std::mutex> lock(mu_);
        predictor_.note_controller(number, rx, ry, now_us);
    }
    if (controller_.has_value() && static_cast<uint16_t>(*controller_) == number) {
        uint32_t packed = (static_cast<uint32_t>(static_cast<uint16_t>(rx)) << 16) |
                          static_cast<uint32_t>(static_cast<uint16_t>(ry));
        stick_packed_.store(packed, std::memory_order_release);
        input_seq_.fetch_add(1u, std::memory_order_acq_rel);
    }
}

void FrameWarp::on_model(const Model& model) {
    std::lock_guard<std::mutex> lock(mu_);
    predictor_.on_model(model);
    deadzone_bits_.store(float_to_bits(model.stick_deadzone), std::memory_order_release);
}

void FrameWarp::on_tags(const Tags& tags, uint64_t now_us) {
    std::lock_guard<std::mutex> lock(mu_);
    predictor_.on_tags(tags, now_us);
}

void FrameWarp::on_mask(Mask mask) {
    size_t cells = mask.count();
    uint16_t gen = mask.generation;
    bool clear = mask.is_clear();
    std::lock_guard<std::mutex> lock(mu_);
    if (clear) {
        mask_.reset();
        predictor_.on_mask(std::nullopt, 0);
    } else {
        mask_ = std::make_shared<const Mask>(std::move(mask));
        predictor_.on_mask(gen, cells);
    }
}

Warp FrameWarp::warp(uint32_t frame, uint64_t now_us) {
    std::lock_guard<std::mutex> lock(mu_);
    return predictor_.warp(frame, now_us);
}

Warp FrameWarp::peek(uint32_t frame, uint64_t now_us) {
    std::lock_guard<std::mutex> lock(mu_);
    return predictor_.peek(frame, now_us);
}

Status FrameWarp::status(uint64_t now_us) {
    std::lock_guard<std::mutex> lock(mu_);
    return predictor_.status(now_us);
}

bool FrameWarp::mask_since(std::optional<uint16_t> known_gen, std::shared_ptr<const Mask>& out) {
    std::lock_guard<std::mutex> lock(mu_);
    std::optional<uint16_t> cur = mask_ ? std::optional<uint16_t>(mask_->generation) : std::nullopt;
    if (cur == known_gen) return false;
    out = mask_;
    return true;
}

bool FrameWarp::stick_deflected() const {
    if (!controller_.has_value()) return false;
    uint32_t packed = stick_packed_.load(std::memory_order_acquire);
    int16_t rx = static_cast<int16_t>(static_cast<uint16_t>(packed >> 16));
    int16_t ry = static_cast<int16_t>(static_cast<uint16_t>(packed & 0xFFFFu));
    float dz = bits_to_float(deadzone_bits_.load(std::memory_order_acquire));
    auto c = stick_curve(rx, ry, dz, 1.0f);
    return c[0] != 0.0f || c[1] != 0.0f;
}

void FrameWarp::note_frame_pts(int64_t pts_us, uint32_t frame_number) {
    std::lock_guard<std::mutex> lock(mu_);
    frame_ring_.note(pts_us, frame_number);
}

std::optional<uint32_t> FrameWarp::lookup_frame_pts(int64_t pts_us) {
    std::lock_guard<std::mutex> lock(mu_);
    return frame_ring_.lookup(pts_us);
}

std::optional<uint32_t> FrameWarp::lookup_frame_pts_nearest(int64_t pts_us, int64_t tolerance_us) {
    std::lock_guard<std::mutex> lock(mu_);
    return frame_ring_.lookup_nearest(pts_us, tolerance_us);
}

} // namespace nightjar::frame_warp
