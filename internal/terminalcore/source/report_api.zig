
// Tessera XTVERSION (CSI > q), DECRQM (CSI ? Pm $ p), the title stack
// (CSI 22/23 t) and progress reports (OSC 9;4). The pinned API dropped all
// four. Replies go to the response buffer, which the host's core answers.

/// The version XTVERSION reports after "Tessera": at most 64 printable
/// ASCII characters without spaces; anything else reports none.
pub fn set_version(ptr: ?*anyopaque, data: [*]const u8, len: u32) callconv(.c) void {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return));
    const handler = &w.stream.handler;
    handler.version_len = 0;
    if (len > handler.version.len) return;
    for (data[0..len]) |c| if (c < 0x21 or c > 0x7e) return;
    @memcpy(handler.version[0..len], data[0..len]);
    handler.version_len = @intCast(len);
}

/// Counts progress reports, wrapping.
pub fn progress_revision(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return w.stream.handler.progress_revision;
}

/// The last progress report: its state (0 remove, 1 set, 2 error,
/// 3 indeterminate, 4 pause) and, shifted left 8, the percentage, or 255
/// when the report gave none.
pub fn progress(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return w.stream.handler.progress;
}

/// The Kitty keyboard protocol flags the program set on the active screen
/// (CSI > flags u and friends), which the browser encodes keys with.
pub fn kitty_keyboard_flags(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return w.terminal.screens.active.kitty_keyboard.current().int();
}
