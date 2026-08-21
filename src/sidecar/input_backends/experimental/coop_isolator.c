#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <errno.h>
#include <stdarg.h>
#include <unistd.h>

typedef int (*orig_open_f_type)(const char *pathname, int flags, ...);
typedef int (*orig_open64_f_type)(const char *pathname, int flags, ...);
typedef int (*orig_openat_f_type)(int dirfd, const char *pathname, int flags, ...);
typedef int (*orig_openat64_f_type)(int dirfd, const char *pathname, int flags, ...);

static orig_open_f_type orig_open = NULL;
static orig_open64_f_type orig_open64 = NULL;
static orig_openat_f_type orig_openat = NULL;
static orig_openat64_f_type orig_openat64 = NULL;

static void init_hooks() {
    if (!orig_open) orig_open = (orig_open_f_type)dlsym(RTLD_NEXT, "open");
    if (!orig_open64) orig_open64 = (orig_open64_f_type)dlsym(RTLD_NEXT, "open64");
    if (!orig_openat) orig_openat = (orig_openat_f_type)dlsym(RTLD_NEXT, "openat");
    if (!orig_openat64) orig_openat64 = (orig_openat64_f_type)dlsym(RTLD_NEXT, "openat64");
}

static int should_block(const char *pathname) {
    if (strncmp(pathname, "/dev/input/event", 16) == 0) {
        const char *allowed_name = getenv("NEARCADE_ALLOWED_DEVNAME");
        if (allowed_name && strlen(allowed_name) > 0) {
            const char *base_name = pathname + 16;
            char sysfs_path[256];
            snprintf(sysfs_path, sizeof(sysfs_path), "/sys/class/input/event%s/device/name", base_name);
            
            orig_open_f_type o_open = orig_open ? orig_open : (orig_open_f_type)dlsym(RTLD_NEXT, "open");
            int fd = o_open(sysfs_path, O_RDONLY, 0);
            if (fd >= 0) {
                char name_buf[256];
                memset(name_buf, 0, sizeof(name_buf));
                if (read(fd, name_buf, sizeof(name_buf) - 1) > 0) {
                    char *newline = strchr(name_buf, '\n');
                    if (newline) *newline = '\0';
                    if (strstr(allowed_name, name_buf) != NULL) {
                        close(fd);
                        return 0; // Allowed
                    }
                }
                close(fd);
            }
            return 1; // Blocked by devname
        }

        const char *allowed = getenv("NEARCADE_ALLOWED_EVDEV");
        if (allowed && strlen(allowed) > 0) {
            // Check if it's the exact allowed device or a comma separated list
            if (strstr(allowed, pathname) != NULL) {
                return 0; // Allowed
            }
            return 1; // Blocked!
        }
    }
    return 0; // Allow everything else
}

int open(const char *pathname, int flags, ...) {
    init_hooks();
    if (should_block(pathname)) {
        errno = ENOENT;
        return -1;
    }
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    return orig_open(pathname, flags, mode);
}

int open64(const char *pathname, int flags, ...) {
    init_hooks();
    if (should_block(pathname)) {
        errno = ENOENT;
        return -1;
    }
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    return orig_open64(pathname, flags, mode);
}

int openat(int dirfd, const char *pathname, int flags, ...) {
    init_hooks();
    if (should_block(pathname)) {
        errno = ENOENT;
        return -1;
    }
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    return orig_openat(dirfd, pathname, flags, mode);
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
    init_hooks();
    if (should_block(pathname)) {
        errno = ENOENT;
        return -1;
    }
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    return orig_openat64(dirfd, pathname, flags, mode);
}
