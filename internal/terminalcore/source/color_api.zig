
// Tessera OSC 4/104 and 10-19/110-119. The pinned API parsed colour
// operations and dropped them. The handler now sets, resets and reports the
// palette and the foreground, background and cursor colours on the terminal
// (which snapshots carry), and keeps the selection colours (17 and 19)
// itself. A revision counts every change for the browser, which reads the
// colours a program set to recolour what it draws from its theme.

fn tesseraPackRGB(rgb: color.RGB) u32 {
    return 0x1000000 | (@as(u32, rgb.r) << 16) | (@as(u32, rgb.g) << 8) | rgb.b;
}

fn tesseraUnpackRGB(value: u32) ?color.RGB {
    if (value == 0) return null;
    return .{ .r = @truncate(value >> 16), .g = @truncate(value >> 8), .b = @truncate(value) };
}

pub fn color_revision(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return w.stream.handler.color_revision;
}

/// Writes the colours a program set, in order foreground, background,
/// cursor, selection background, selection foreground: 0x1RRGGBB each, or 0
/// where the program set none and the pane's own colour applies.
pub fn dynamic_colors(ptr: ?*anyopaque, out: [*]u32) callconv(.c) void {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return));
    const c = &w.terminal.colors;
    out[0] = if (c.foreground.override) |rgb| tesseraPackRGB(rgb) else 0;
    out[1] = if (c.background.override) |rgb| tesseraPackRGB(rgb) else 0;
    out[2] = if (c.cursor.override) |rgb| tesseraPackRGB(rgb) else 0;
    out[3] = w.stream.handler.highlight_background;
    out[4] = w.stream.handler.highlight_foreground;
}
