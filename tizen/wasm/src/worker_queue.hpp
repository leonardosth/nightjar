#pragma once

#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>

namespace nightjar::tizen {

// Single persistent pthread worker queue for all Tizen Sockets Extension, OpenSSL,
// and moonlight-common-c lifecycle work so we never exhaust PTHREAD_POOL_SIZE or detach threads.
class WorkerQueue {
public:
    WorkerQueue() = default;

    ~WorkerQueue() {
        stop();
    }

    WorkerQueue(const WorkerQueue&) = delete;
    WorkerQueue& operator=(const WorkerQueue&) = delete;

    void enqueue(std::function<void()> fn) {
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (stopping_) return;
            if (!started_) {
                started_ = true;
                worker_ = std::thread([this]() { run(); });
            }
            queue_.push_back(std::move(fn));
        }
        cv_.notify_one();
    }

    void stop() {
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (!started_ || stopping_) return;
            stopping_ = true;
        }
        cv_.notify_all();
        if (worker_.joinable()) {
            worker_.join();
        }
    }

private:
    void run() {
        while (true) {
            std::function<void()> job;
            {
                std::unique_lock<std::mutex> lk(mu_);
                cv_.wait(lk, [this]() { return stopping_ || !queue_.empty(); });
                if (stopping_ && queue_.empty()) return;
                job = std::move(queue_.front());
                queue_.pop_front();
            }
            if (job) job();
        }
    }

    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<std::function<void()>> queue_;
    std::thread worker_;
    bool started_ = false;
    bool stopping_ = false;
};

} // namespace nightjar::tizen
