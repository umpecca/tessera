
// Tessera underline styles and colours. A cell read (viewport, one row, or
// a history line) puts the underline style (Ghostty's SGR enum: 1 single,
// 2 double, 3 curly, 4 dotted, 5 dashed) in bits 0-2 of the cell's spare
// byte, and sets bit 3 when the underline has its own colour (SGR 58). That
// colour, 0xRRGGBB, is at the cell's index in the read in
// tessera_underline_colors, valid until the next read.

fn tesseraUnderline(wrapper: *const TerminalWrapper, rs: anytype, sty: Style, index: usize) u8 {
    if (sty.flags.underline == .none) return 0;
    var value: u8 = @intFromEnum(sty.flags.underline);
    const rgb: ?color.RGB = switch (sty.underline_color) {
        .none => null,
        .palette => |i| rs.colors.palette[i],
        .rgb => |c| c,
    };
    if (rgb) |c| {
        const w: *TerminalWrapper = @constCast(wrapper);
        if (w.underline_colors.items.len <= index) w.underline_colors.resize(w.alloc, index + 1) catch return value;
        w.underline_colors.items[index] = (@as(u32, c.r) << 16) | (@as(u32, c.g) << 8) | c.b;
        value |= 8;
    }
    return value;
}

pub fn underline_colors(ptr: ?*anyopaque) callconv(.c) usize {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return if (w.underline_colors.items.len > 0) @intFromPtr(w.underline_colors.items.ptr) else 0;
}
