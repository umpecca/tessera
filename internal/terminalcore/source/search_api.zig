
// Tessera scrollback search, with Ghostty's own searcher (search/screen.zig):
// ASCII case-insensitive, matches that wrap across rows, and results that
// stay put as output arrives and history is trimmed. One search per
// terminal, of the screen being shown.

/// Starts a search for the needle (1 to 1024 bytes of UTF-8), replacing any
/// other, and selects the newest match. Returns the number of matches; an
/// empty or oversized needle ends the search and returns 0.
pub fn search_start(ptr: ?*anyopaque, data: [*]const u8, len: u32) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    const handler = &w.stream.handler;
    handler.endSearch();
    if (len == 0 or len > 1024) return 0;
    handler.search = @import("../search.zig").Screen.init(handler.alloc, w.terminal.screens.active, data[0..len]) catch return 0;
    const s = &handler.search.?;
    s.searchAll() catch {};
    _ = s.select(.next) catch false;
    return @intCast(s.matchesLen());
}

/// Brings the search up to date with output since it last ran, and starts
/// it again on the screen being shown if a program switched screens.
/// Returns the number of matches.
pub fn search_update(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    const s = if (w.stream.handler.search) |*s| s else return 0;
    if (s.screen != w.terminal.screens.active) {
        var needle: [1024]u8 = undefined;
        const n = s.needle().len;
        @memcpy(needle[0..n], s.needle());
        return search_start(ptr, &needle, @intCast(n));
    }
    s.reloadActive() catch {};
    s.searchAll() catch {};
    if (s.selected == null) _ = s.select(.next) catch false;
    return @intCast(s.matchesLen());
}

/// Selects the next older match (older = 1) or the next newer one (0).
/// Returns whether there was one; it doesn't wrap.
pub fn search_select(ptr: ?*anyopaque, older: u32) callconv(.c) bool {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return false));
    const s = if (w.stream.handler.search) |*s| s else return false;
    return s.select(if (older != 0) .next else .prev) catch false;
}

/// The selected match's index, newest first, or -1.
pub fn search_selected(ptr: ?*anyopaque) callconv(.c) i32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return -1));
    const s = if (w.stream.handler.search) |*s| s else return -1;
    const selected = s.selected orelse return -1;
    return @intCast(selected.idx);
}

/// Writes up to capacity matches, newest first, as four u32s each: start row,
/// start column, end row, end column (inclusive), with rows counted from the
/// top of the history. A match no longer on the screen has start row
/// 0xFFFFFFFF. Returns how many were written.
pub fn search_matches(ptr: ?*anyopaque, out: [*]u32, capacity: u32) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    const s = if (w.stream.handler.search) |*s| s else return 0;
    const all = s.matches(w.stream.handler.alloc) catch return 0;
    defer w.stream.handler.alloc.free(all);
    const count: u32 = @intCast(@min(all.len, capacity));
    for (all[0..count], 0..) |hl, i| {
        const pins = hl.untracked();
        const start = s.screen.pages.pointFromPin(.screen, pins.start);
        const end = s.screen.pages.pointFromPin(.screen, pins.end);
        if (start == null or end == null) {
            out[i * 4] = 0xFFFFFFFF;
            continue;
        }
        out[i * 4] = start.?.screen.y;
        out[i * 4 + 1] = start.?.screen.x;
        out[i * 4 + 2] = end.?.screen.y;
        out[i * 4 + 3] = end.?.screen.x;
    }
    return count;
}

/// Ends the search.
pub fn search_end(ptr: ?*anyopaque) callconv(.c) void {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return));
    w.stream.handler.endSearch();
}
