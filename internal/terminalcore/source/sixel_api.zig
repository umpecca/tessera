
// Tessera Sixel API. Appended to the pinned terminal C wrapper.
pub fn sixel_version() callconv(.c) u32 { return 2; }

pub fn sixel_image_settings(ptr: ?*anyopaque, memory_mib: u32, placeholders: u32) callconv(.c) bool {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return false));
    if ((memory_mib != 16 and memory_mib != 32 and memory_mib != 64) or placeholders > 1) return false;
    w.sixel.configureImages(w.alloc, &w.terminal, memory_mib * 1024 * 1024, placeholders == 1);
    return true;
}

pub fn sixel_image_settings_read(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return @as(u32, @intCast(w.sixel.memory_limit / (1024 * 1024))) | (@as(u32, @intFromBool(w.sixel.show_placeholders)) << 8);
}

pub fn sixel_clear_images(ptr: ?*anyopaque) callconv(.c) void {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return));
    w.sixel.clearImages(w.alloc, &w.terminal);
}

pub fn sixel_configure(ptr: ?*anyopaque, light: u32) callconv(.c) void {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return));
    const fg: color.RGB = if (light != 0) .{ .r = 0, .g = 0, .b = 0 } else .{ .r = 229, .g = 229, .b = 229 };
    const bg: color.RGB = if (light != 0) .{ .r = 255, .g = 255, .b = 255 } else .{ .r = 0, .g = 0, .b = 0 };
    w.terminal.colors.foreground.default = fg;
    w.terminal.colors.background.default = bg;
    w.terminal.colors.cursor.default = fg;
    const ansi = [_]u32{ 0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5, 0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff };
    var palette = w.terminal.colors.palette.original;
    for (ansi, 0..) |rgb, i| palette[i] = .{ .r = @truncate(rgb >> 16), .g = @truncate(rgb >> 8), .b = @truncate(rgb) };
    w.terminal.colors.palette.changeDefault(palette);
    w.terminal.flags.dirty.clear = true;
}

fn trimHistory(w: *TerminalWrapper) void {
    const pages = &w.terminal.screens.get(.primary).?.pages;
    const history = pages.total_rows -| pages.rows;
    if (history > w.history_limit) pages.eraseRows(.{ .history = .{} }, .{ .history = .{ .y = @intCast(history - w.history_limit - 1) } });
}

pub fn sixel_clipboard_read(ptr: ?*anyopaque, out: [*]u8, capacity: u32) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    const buffer = &w.stream.handler.clipboard;
    const count = @min(capacity, buffer.items.len);
    @memcpy(out[0..count], buffer.items[0..count]);
    std.mem.copyForwards(u8, buffer.items, buffer.items[count..]);
    buffer.shrinkRetainingCapacity(buffer.items.len - count);
    return @intCast(count);
}

pub fn sixel_geometry(ptr: ?*anyopaque, width: u32, height: u32) callconv(.c) void {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return));
    if (width == 0 or width > 4096 or height == 0 or height > 4096) return;
    w.sixel.cell_width = width;
    w.sixel.cell_height = height;
    w.terminal.width_px = @as(u32, w.terminal.cols) * width;
    w.terminal.height_px = @as(u32, w.terminal.rows) * height;
    trimHistory(w);
    w.sixel.collect(w.alloc, &w.terminal) catch {};
}

pub fn sixel_image_count(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    return @intCast(w.sixel.images.count());
}

pub fn sixel_image_info(ptr: ?*anyopaque, index: u32, out: [*]u32) callconv(.c) bool {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return false));
    if (index >= w.sixel.images.count()) return false;
    const img = w.sixel.images.values()[index];
    out[0..7].* = .{ w.sixel.images.keys()[index], img.width, img.height, img.stride, img.cell_width, img.cell_height, w.sixel.revision };
    return true;
}

pub fn sixel_image_pixels(ptr: ?*anyopaque, id: u32) callconv(.c) ?[*]const u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return null));
    const img = w.sixel.images.get(id) orelse return null;
    if (img.pixels.len == 0) return null;
    return img.pixels.ptr;
}

// Records: image id, column, viewport row, source x/y, cell width/height.
// For overlapping transparent images, records are newest first per cell;
// the browser paints that cell's records in reverse order.
pub fn sixel_tiles(ptr: ?*anyopaque, viewport: u32, out: [*]u32, capacity: u32) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    const t = &w.terminal;
    const pages = &t.screens.active.pages;
    const history: u32 = @intCast(@max(0, getScrollbackLength(ptr)));
    const top = history -| viewport;
    var count: u32 = 0;
    for (0..t.rows) |y| {
        const pin = pages.pin(.{ .screen = .{ .y = @intCast(top + y) } }) orelse continue;
        for (pin.cells(.all), 0..) |cell, x| {
            var id = cell.sixel;
            while (id != 0 and id < w.sixel.tiles.items.len) {
                const tile = w.sixel.tiles.items[id];
                if (w.sixel.images.get(tile.image)) |img| {
                    if (count < capacity) {
                        out[count * 7 ..][0..7].* = .{ tile.image, @intCast(x), @intCast(y), tile.x, tile.y, img.cell_width, img.cell_height };
                    }
                    count += 1;
                }
                id = tile.underneath;
            }
        }
    }
    return count;
}
