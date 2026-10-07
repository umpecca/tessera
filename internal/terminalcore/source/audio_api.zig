pub fn audio_read(ptr: ?*anyopaque, out: [*]u8, capacity: u32) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return @intCast(w.stream.handler.audio.read(out, capacity));
}
