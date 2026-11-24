#include <sys/timeb.h>
#include <sys/time.h>
#include <stdlib.h>

// Defined in header but unimplemented in Samsung Emscripten's libc; required by moonlight-common-c
int ftime(struct timeb* tp) {
    struct timeval tv;
    if (gettimeofday(&tv, NULL) < 0) {
        return -1;
    }
    tp->time = tv.tv_sec;
    tp->millitm = (unsigned short)(tv.tv_usec / 1000);
    tp->timezone = 0;
    tp->dstflag = 0;
    return 0;
}

// Required for Emscripten's libcurl port to link
unsigned alarm(unsigned seconds) {
    (void)seconds;
    return 0;
}
