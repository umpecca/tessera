
// Tessera OSC 22. Programs set the mouse pointer's shape over the terminal
// (OSC 22 ; name ST). Ghostty parses the name and keeps the shape on the
// terminal, including in snapshots; the pinned API had no way to read it.

/// The pointer shape as its MouseShape value (0 default, 8 text, ...).
pub fn mouse_shape(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return @intCast(@intFromEnum(w.terminal.mouse_shape));
}
