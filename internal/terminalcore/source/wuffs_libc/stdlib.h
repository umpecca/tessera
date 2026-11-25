#pragma once
// Tessera builds wuffs (Kitty graphics PNG decoding) for wasm32-freestanding,
// which has no libc. These declare the few functions wuffs calls; Zig's
// compiler-rt provides the mem* ones and shim.c the rest.
#include <stddef.h>
void *malloc(size_t size);
void free(void *ptr);
void *calloc(size_t count, size_t size);
