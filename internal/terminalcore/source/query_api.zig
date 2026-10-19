
// Tessera XTGETTCAP (DCS + q) and DECRQSS (DCS $ q), answered in the
// handler, and in-band size reports (mode 2048), sent from sixel_geometry
// after a resize.

/// The TERM programs run with, which XTGETTCAP reports as TN: at most 64
/// printable ASCII characters without spaces; anything else reports none.
pub fn set_term_name(ptr: ?*anyopaque, data: [*]const u8, len: u32) callconv(.c) void {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return));
    const handler = &w.stream.handler;
    handler.term_name_len = 0;
    if (len > handler.term_name.len) return;
    for (data[0..len]) |c| if (c < 0x21 or c > 0x7e) return;
    @memcpy(handler.term_name[0..len], data[0..len]);
    handler.term_name_len = @intCast(len);
}
