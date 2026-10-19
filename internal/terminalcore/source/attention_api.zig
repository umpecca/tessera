
// Tessera focus reports (mode 1004), colour scheme reports (CSI ? 996 n and
// mode 2031), bells and desktop notifications (OSC 9 and OSC 777). The
// pinned API dropped all of them. Replies go to the response buffer like any
// other; the host's core is the one whose replies reach the shell.

/// Whether a browser has the pane focused. With mode 1004 on, a change is
/// reported to the program as CSI I or CSI O.
pub fn focus(ptr: ?*anyopaque, focused: u32) callconv(.c) void {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return));
    const value = focused != 0;
    if (w.terminal.flags.focused == value) return;
    w.terminal.flags.focused = value;
    if (w.terminal.modes.get(.focus_event)) w.stream.handler.reportFocus() catch {};
}

/// Counts BEL characters outside other sequences, wrapping.
pub fn bell_count(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return w.stream.handler.bell_count;
}

/// Drains queued notifications, each a little-endian u32 length and then
/// the title, a zero byte and the body.
pub fn notification_read(ptr: ?*anyopaque, out: [*]u8, capacity: u32) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    const buffer = &w.stream.handler.notifications;
    const count = @min(capacity, buffer.items.len);
    @memcpy(out[0..count], buffer.items[0..count]);
    std.mem.copyForwards(u8, buffer.items, buffer.items[count..]);
    buffer.shrinkRetainingCapacity(buffer.items.len - count);
    return @intCast(count);
}
