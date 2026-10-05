const initialCapacity = 8 * 1024;
const maximumCapacity = 64 * 1024;

export class TerminalInputBuffer {
  constructor() {
    this.ptr = 0;
    this.capacity = 0;
    this.inUse = false;
    this.closed = false;
    this.buffer = null;
    this.exports = null;
  }

  attach(buffer) {
    if (this.closed || this.buffer === buffer) return;
    if (this.buffer) {
      if (this.ownWrite) this.buffer.write = this.originalWrite;
      else delete this.buffer.write;
      this.buffer = null;
    }
    const e = buffer?.exports;
    if (typeof buffer?.write !== "function" || !e?.memory || !e.ghostty_terminal_write) return;
    if (this.exports && this.exports !== e) {
      if (this.ptr) this.exports.ghostty_wasm_free_u8_array(this.ptr, this.capacity);
      this.ptr = 0; this.capacity = 0;
    }
    this.exports = e;
    this.buffer = buffer;
    this.originalWrite = buffer.write;
    this.ownWrite = Object.hasOwn(buffer, "write");
    buffer.write = data => this.write(buffer.handle, data);
  }

  write(handle, data) {
    if (this.closed) return;
    let bytes = typeof data === "string" ? (this.encoder ??= new TextEncoder()).encode(data) : data;
    if (!bytes.length) return;
    const e = this.exports, length = bytes.length;
    // Growing native memory can detach a caller's borrowed WASM view.
    if (bytes.buffer === e.memory.buffer) bytes = bytes.slice();
    const temporary = this.inUse || length > maximumCapacity;
    let ptr, capacity;
    if (temporary) {
      capacity = length;
      ptr = e.ghostty_wasm_alloc_u8_array(capacity);
      if (!ptr) throw new Error("Terminal input allocation failed");
    } else {
      if (length > this.capacity) {
        capacity = initialCapacity;
        while (capacity < length) capacity *= 2;
        ptr = e.ghostty_wasm_alloc_u8_array(capacity);
        if (!ptr) throw new Error("Terminal input allocation failed");
        if (this.ptr) e.ghostty_wasm_free_u8_array(this.ptr, this.capacity);
        this.ptr = ptr; this.capacity = capacity;
      }
      ptr = this.ptr;
      this.inUse = true;
    }
    try {
      // Keep pointers rather than typed views: parsing can grow WASM memory.
      new Uint8Array(e.memory.buffer).set(bytes, ptr);
      e.ghostty_terminal_write(handle, ptr, length);
    } finally {
      if (temporary) e.ghostty_wasm_free_u8_array(ptr, capacity);
      else this.inUse = false;
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    if (this.buffer) {
      if (this.ownWrite) this.buffer.write = this.originalWrite;
      else delete this.buffer.write;
      this.buffer = null;
    }
    if (this.ptr) this.exports.ghostty_wasm_free_u8_array(this.ptr, this.capacity);
    this.ptr = 0; this.capacity = 0;
  }
}
