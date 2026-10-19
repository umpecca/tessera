
// Tessera OSC 133. Shells mark where a prompt, its input and a command's
// output begin. Ghostty records the mark on the row the cursor is on; the
// pinned API had no way to read it.

/// Copies the semantic mark of up to count rows of the active screen,
/// starting at row, rows counted from the oldest scrollback line as
/// ghostty-web's buffer counts them: 0 unknown, 1 prompt, 2 prompt
/// continuation, 3 input, 4 command output (its first row), plus 8 when the
/// row continues the one above it (a soft wrap; ghostty-web reports that
/// only for the screen, not scrollback). Returns the number of rows copied.
pub fn semantic_rows(ptr: ?*anyopaque, row: u32, count: u32, out: [*]u8) callconv(.c) u32 {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    const start = w.terminal.screens.active.pages.pin(.{ .screen = .{ .x = 0, .y = row } }) orelse return 0;
    var it = start.rowIterator(.right_down, null);
    var n: u32 = 0;
    while (n < count) : (n += 1) {
        const pin = it.next() orelse break;
        const r = pin.rowAndCell().row;
        out[n] = @as(u8, @intFromEnum(r.semantic_prompt)) | (if (r.wrap_continuation) @as(u8, 8) else 0);
    }
    return n;
}
