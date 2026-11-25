#pragma once
// Tessera builds wuffs (Kitty graphics PNG decoding) for wasm32-freestanding,
// which has no libc. These declare the few functions wuffs calls; Zig's
// compiler-rt provides the mem* ones and shim.c the rest.
#include <stddef.h>
void *memcpy(void *restrict dest, const void *restrict src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *memset(void *dest, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);
int strcmp(const char *a, const char *b);
