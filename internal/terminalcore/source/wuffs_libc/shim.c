#include <stddef.h>
// The only libc wuffs needs beyond what Zig's compiler-rt provides. Ghostty's
// wrapper allocates wuffs' structs with Zig's allocator, so the C allocation
// helpers that call calloc are never used; this one always fails.
int strcmp(const char *a, const char *b) {
  while (*a && *a == *b) { a++; b++; }
  return (unsigned char)*a - (unsigned char)*b;
}
void *calloc(size_t count, size_t size) { (void)count; (void)size; return NULL; }
