
// Tessera OSC 7. Shells report their working directory as a file:// URL
// (OSC 7 ; url ST). The pinned API parsed the report and dropped it; the
// handler now keeps the last one and the pane reads it, as for titles.

pub fn pwd_revision(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return w.stream.handler.pwd_revision;
}
pub fn pwd_length(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return @intCast(w.stream.handler.pwd.items.len);
}
pub fn pwd_data(ptr: ?*anyopaque) callconv(.c) ?[*]const u8 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return null));
    return w.stream.handler.pwd.items.ptr;
}
