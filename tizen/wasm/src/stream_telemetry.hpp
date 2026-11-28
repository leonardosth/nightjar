#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>

namespace nightjar::tizen {

inline uint64_t steady_now_us() {
    using namespace std::chrono;
    return static_cast<uint64_t>(duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count());
}

/**
 * Shared wall-clock origin anchored on the first appended media packet (audio or video)
 * so both EMSS tracks share a single 0.0s timeline despite startup resync offsets.
 */
class SharedMediaClock {
public:
    void reset() {
        origin_us_.store(0, std::memory_order_release);
    }

    int64_t elapsed_us(uint64_t wall_us) {
        if (wall_us == 0) wall_us = 1;
        uint64_t expected = 0;
        if (!origin_us_.compare_exchange_strong(expected, wall_us, std::memory_order_acq_rel)) {
            return wall_us >= expected ? static_cast<int64_t>(wall_us - expected) : 0;
        }
        return 0;
    }

    bool is_started() const {
        return origin_us_.load(std::memory_order_acquire) != 0;
    }

private:
    std::atomic<uint64_t> origin_us_{0};
};

struct LatencySnapshot {
    uint32_t count = 0;
    double min_ms = 0.0;
    double avg_ms = 0.0;
    double max_ms = 0.0;
};

class LatencyWindow {
public:
    void add_us(uint64_t v) {
        std::lock_guard<std::mutex> lk(mu_);
        if (count_ == 0) {
            min_us_ = v;
            max_us_ = v;
        } else {
            min_us_ = std::min(min_us_, v);
            max_us_ = std::max(max_us_, v);
        }
        sum_us_ += v;
        ++count_;
    }

    LatencySnapshot roll() {
        std::lock_guard<std::mutex> lk(mu_);
        LatencySnapshot snap;
        if (count_ > 0) {
            snap.count = count_;
            snap.min_ms = static_cast<double>(min_us_) / 1000.0;
            snap.avg_ms = static_cast<double>(sum_us_) / (static_cast<double>(count_) * 1000.0);
            snap.max_ms = static_cast<double>(max_us_) / 1000.0;
        }
        count_ = 0;
        min_us_ = 0;
        max_us_ = 0;
        sum_us_ = 0;
        return snap;
    }

private:
    mutable std::mutex mu_;
    uint32_t count_ = 0;
    uint64_t min_us_ = 0;
    uint64_t max_us_ = 0;
    uint64_t sum_us_ = 0;
};

class PendingFrameQueue {
public:
    static constexpr size_t kCapacity = 64;

    struct Entry {
        uint32_t frame = 0;
        int64_t pts_us = 0;
        uint64_t submit_us = 0;
    };

    void push(const Entry& e) {
        std::lock_guard<std::mutex> lk(mu_);
        while (queue_.size() >= kCapacity) {
            queue_.pop_front();
        }
        queue_.push_back(e);
    }

    std::optional<Entry> resolve(std::optional<uint32_t> hint) {
        std::lock_guard<std::mutex> lk(mu_);
        if (queue_.empty()) {
            return std::nullopt;
        }
        if (hint.has_value()) {
            for (auto it = queue_.begin(); it != queue_.end(); ++it) {
                if (it->frame == *hint) {
                    Entry matched = *it;
                    queue_.erase(queue_.begin(), std::next(it));
                    return matched;
                }
            }
        }
        Entry front = queue_.front();
        queue_.pop_front();
        return front;
    }

    void clear() {
        std::lock_guard<std::mutex> lk(mu_);
        queue_.clear();
    }

    size_t size() const {
        std::lock_guard<std::mutex> lk(mu_);
        return queue_.size();
    }

private:
    mutable std::mutex mu_;
    std::deque<Entry> queue_;
};

} // namespace nightjar::tizen
