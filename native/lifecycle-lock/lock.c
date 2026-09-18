#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <stdio.h>

/* Pin every ancestor instead of trusting a path-based parent check. */
static int open_parent(char *path, char **name) {
  if (path[0] != '/') return -1;
  int parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (parent < 0) return -1;
  char *save = NULL, *part = strtok_r(path, "/", &save);
  while (part != NULL) {
    char *next = strtok_r(NULL, "/", &save);
    if (!strcmp(part, ".") || !strcmp(part, "..")) break;
    if (next == NULL) { *name = part; return parent; }
    int fd = openat(parent, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) break;
    close(parent); parent = fd; part = next;
  }
  close(parent); return -1;
}

static int held_fd = -1;

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, "CONVO_CADDY_LOCK", message);
  return NULL;
}

static napi_value acquire(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) return fail(env, "Lock path is required.");
  size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok || length == 0 || length > 4096) return fail(env, "Lock path is invalid.");
  char path[4097];
  if (napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &length) != napi_ok) return fail(env, "Lock path is invalid.");
  if (held_fd >= 0) return fail(env, "Lifecycle lock is already held by this main process.");
  if (strlen(path) != length) return fail(env, "Lock path contains a null byte.");
  /* The fixed Darwin /var alias is the only permitted system alias. */
  char expanded[4105];
  if (!strncmp(path, "/var/", 5)) snprintf(expanded, sizeof(expanded), "/private%s", path);
  else snprintf(expanded, sizeof(expanded), "%s", path);
  char *name = NULL;
  int parent = open_parent(expanded, &name);
  if (parent < 0) return fail(env, "Unsafe lifecycle lock ancestor.");
  struct stat directory;
  if (fstat(parent, &directory) != 0 || directory.st_uid != getuid() || (directory.st_mode & 077) != 0) {
    close(parent); return fail(env, "Unsafe lifecycle control directory.");
  }
  int fd = openat(parent, name, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, S_IRUSR | S_IWUSR);
  if (fd < 0) { close(parent); return fail(env, "Unable to open the lifecycle lock."); }
  struct stat st, current;
  if (fstat(fd, &st) != 0 || st.st_uid != getuid() || st.st_nlink != 1 || !S_ISREG(st.st_mode) || (st.st_mode & 077) != 0) { close(parent); close(fd); return fail(env, "Lifecycle lock inode failed ownership validation."); }
  if (flock(fd, LOCK_SH | LOCK_NB) != 0) { close(parent); close(fd); return fail(env, "Maintenance is in progress."); }
  if (fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) != 0 || current.st_dev != st.st_dev || current.st_ino != st.st_ino) {
    close(parent); close(fd); return fail(env, "Lifecycle lock changed during acquisition.");
  }
  close(parent);
  held_fd = fd;
  napi_value result; napi_get_boolean(env, true, &result); return result;
}

static napi_value release(napi_env env, napi_callback_info info) {
  if (held_fd >= 0) { flock(held_fd, LOCK_UN); close(held_fd); held_fd = -1; }
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value acquire_fn, release_fn;
  napi_create_function(env, "acquire", NAPI_AUTO_LENGTH, acquire, NULL, &acquire_fn);
  napi_create_function(env, "release", NAPI_AUTO_LENGTH, release, NULL, &release_fn);
  napi_set_named_property(env, exports, "acquire", acquire_fn);
  napi_set_named_property(env, exports, "release", release_fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
