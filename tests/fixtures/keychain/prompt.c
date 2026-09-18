/* Synthetic libc fixture only: no Security framework, Keychain, or credentials. */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "wait") == 0) {
    for (;;) pause();
  }
  int terminal = open("/dev/tty", O_RDWR);
  if (terminal >= 0) { close(terminal); return 20; }
  if (getsid(0) != getpid()) return 21;
  char *first = getpass("Fixture value: ");
  if (!first) return 22;
  char *saved = strdup(first);
  if (!saved) return 23;
  char *second = getpass("Fixture confirmation: ");
  int matched = second && *saved && strcmp(saved, second) == 0;
  free(saved);
  if (!matched) return 24;
  puts("matched; session leader; no controlling terminal");
  return 0;
}
