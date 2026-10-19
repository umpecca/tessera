
// Tessera command reports, from a shell's prompt marks: OSC 133;C starts a
// command (with the command line, if the shell sent cmdline or cmdline_url)
// and OSC 133;D ends it (with its exit status, if given). The host times
// them and tells people when a long one finishes.

/// Drains queued command events, each a little-endian u32 length, then a
/// kind (1 started, 2 finished with a status, 3 finished without one), the
/// status (0 unless kind 2), and for kind 1 the command line.
pub fn command_read(ptr: ?*anyopaque, out: [*]u8, capacity: u32) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    const buffer = &w.stream.handler.commands;
    const count = @min(capacity, buffer.items.len);
    @memcpy(out[0..count], buffer.items[0..count]);
    std.mem.copyForwards(u8, buffer.items, buffer.items[count..]);
    buffer.shrinkRetainingCapacity(buffer.items.len - count);
    return @intCast(count);
}
