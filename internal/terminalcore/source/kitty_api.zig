
// Tessera Kitty graphics. Ghostty's implementation (src/terminal/kitty) keeps
// images and placements on each screen; the pinned API had no way to read
// them, so the browser draws from these, in Ghostty's three layers by z:
// under cell backgrounds (z < -1073741824), under text (other z < 0, and
// Unicode placeholder placements at -1) and over text. See
// scripts/patch-terminal-core.mjs for the build changes that enable it.

const tessera_kitty = @import("../kitty.zig").graphics;
const tessera_kitty_image = @import("../kitty/graphics_image.zig");

/// Visible placements with the viewport `viewport` rows back from the bottom,
/// as 13 i32s each: image id, image generation, column, viewport row (may be
/// negative for an image that starts above the viewport), z, width and height
/// (pixels at the host's cell size), x and y offset within the first cell,
/// and the source rectangle (x, y, width, height). Returns the number of
/// placements even when capacity is smaller.
pub fn kitty_placements(ptr: ?*anyopaque, viewport: u32, out: [*]i32, capacity: u32) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    const t = &w.terminal;
    const screen = t.screens.active;
    const storage = &screen.kitty_images;
    if (storage.placements.count() == 0) return 0;
    const pages = &screen.pages;
    const history: u32 = @intCast(@max(0, getScrollbackLength(ptr)));
    const top_y = history -| viewport;
    const bot_y = top_y + t.rows - 1;
    var count: u32 = 0;
    var virtual = false;
    var it = storage.placements.iterator();
    while (it.next()) |kv| {
        const p = kv.value_ptr;
        switch (p.location) {
            .pin => {},
            .virtual => {
                virtual = true;
                continue;
            },
        }
        const image = storage.imageById(kv.key_ptr.image_id) orelse continue;
        const rect = p.rect(image, t) orelse continue;
        const img_top = (pages.pointFromPin(.screen, rect.top_left) orelse continue).screen.y;
        const img_bot = (pages.pointFromPin(.screen, rect.bottom_right) orelse continue).screen.y;
        if (img_top > bot_y or img_bot < top_y) continue;
        const size = p.calculatedSize(image, t);
        if (size.width == 0 or size.height == 0) continue;
        const source_x = @min(image.width, p.source_x);
        const source_y = @min(image.height, p.source_y);
        const source_width = if (p.source_width > 0) @min(image.width - source_x, p.source_width) else image.width;
        const source_height = if (p.source_height > 0) @min(image.height - source_y, p.source_height) else image.height;
        if (count < capacity) out[count * 13 ..][0..13].* = .{
            @bitCast(image.id),                 @bitCast(@as(u32, @truncate(image.transmit_time))),
            @intCast(rect.top_left.x),          @as(i32, @intCast(img_top)) - @as(i32, @intCast(top_y)),
            p.z,                                @intCast(size.width),
            @intCast(size.height),              @intCast(p.x_offset),
            @intCast(p.y_offset),               @intCast(source_x),
            @intCast(source_y),                 @intCast(source_width),
            @intCast(source_height),
        };
        count += 1;
    }
    if (virtual) {
        const top = pages.pin(.{ .screen = .{ .y = top_y } }) orelse return count;
        const bot = pages.pin(.{ .screen = .{ .x = t.cols - 1, .y = bot_y } }) orelse return count;
        var v_it = tessera_kitty.unicode.placementIterator(top, bot);
        while (v_it.next()) |vp| {
            const image = storage.imageById(vp.image_id) orelse continue;
            const rp = vp.renderPlacement(storage, &image, w.sixel.cell_width, w.sixel.cell_height) catch continue;
            if (rp.dest_width == 0 or rp.dest_height == 0) continue;
            const y = (pages.pointFromPin(.screen, rp.top_left) orelse continue).screen.y;
            if (count < capacity) out[count * 13 ..][0..13].* = .{
                @bitCast(image.id),                 @bitCast(@as(u32, @truncate(image.transmit_time))),
                @intCast(rp.top_left.x),            @as(i32, @intCast(y)) - @as(i32, @intCast(top_y)),
                -1,                                 @intCast(rp.dest_width),
                @intCast(rp.dest_height),           @intCast(rp.offset_x),
                @intCast(rp.offset_y),              @intCast(rp.source_x),
                @intCast(rp.source_y),              @intCast(rp.source_width),
                @intCast(rp.source_height),
            };
            count += 1;
        }
    }
    return count;
}

/// An image on the active screen by id: writes its width, height, bytes per
/// pixel (1 gray, 2 gray and alpha, 3 RGB, 4 RGBA) and generation to out and
/// returns its pixels, or null when there is no such image.
pub fn kitty_image(ptr: ?*anyopaque, id: u32, out: [*]u32) callconv(.c) ?[*]const u8 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return null));
    const image = w.terminal.screens.active.kitty_images.imageById(id) orelse return null;
    const bytes: u32 = switch (image.format) {
        .gray => 1,
        .gray_alpha => 2,
        .rgb => 3,
        .rgba => 4,
        .png => return null,
    };
    if (image.data.len != @as(usize, image.width) * image.height * bytes) return null;
    out[0..4].* = .{ image.width, image.height, bytes, @truncate(image.transmit_time) };
    return image.data.ptr;
}

// Both screens' storage follows Tessera's image memory setting, as Sixel's
// does; a lower limit evicts.
fn tesseraKittyLimits(w: *TerminalWrapper) void {
    for ([_]@TypeOf(w.terminal.screens.active_key){ .primary, .alternate }) |key| {
        const screen = w.terminal.screens.get(key) orelse continue;
        if (screen.kitty_images.total_limit != w.sixel.memory_limit) {
            screen.kitty_images.setLimit(w.alloc, screen, w.sixel.memory_limit) catch {};
        }
    }
}

fn tesseraKittyClear(w: *TerminalWrapper) void {
    for ([_]@TypeOf(w.terminal.screens.active_key){ .primary, .alternate }) |key| {
        const screen = w.terminal.screens.get(key) orelse continue;
        const limit = screen.kitty_images.total_limit;
        screen.kitty_images.deinit(w.alloc, screen);
        screen.kitty_images = .{ .total_limit = limit, .dirty = true };
    }
}

// The APC string being received is kept (handler.apc_raw, up to this many
// bytes) so a snapshot taken inside one can restore it: the parser comes back
// inside the string, and the handler must be too.
pub const tessera_apc_raw_limit = 4 * 1024 * 1024;

fn tesseraKittyResumeApc(w: *TerminalWrapper, raw: []const u8, overflow: bool) !void {
    if (!overflow and raw.len >= 2 and raw[0] == 0x1b and raw[1] == '_') {
        // Replay the start of the string; it ends with the bytes still to come.
        w.stream.parser.state = .ground;
        try w.stream.nextSlice(raw);
        return;
    }
    // Too large to keep: the rest of the string is ignored, never printed.
    w.stream.handler.apc.start();
    w.stream.handler.apc.state = .{ .ignore = {} };
}

// Snapshots: images as they are stored (decoded pixels), placements with
// their pin as a screen point, and an image still arriving in chunks.
fn saveKittyImages(out: *snapshot.Writer, screen: *Screen) !void {
    const storage = &screen.kitty_images;
    try out.value(storage.loading != null);
    if (storage.loading) |loading| {
        try out.value(loading.image);
        try out.value(@as([]const u8, loading.data.items));
        try out.value(loading.display != null);
        if (loading.display) |display| try out.value(display);
        try out.value(loading.quiet);
    }
    try out.value(storage.next_image_id);
    try out.value(storage.next_internal_placement_id);
    try out.value(@as(u32, @intCast(storage.images.count())));
    var images = storage.images.iterator();
    while (images.next()) |kv| try out.value(kv.value_ptr.*);
    var placed: u32 = 0;
    var check = storage.placements.iterator();
    while (check.next()) |kv| switch (kv.value_ptr.location) {
        .virtual => placed += 1,
        .pin => |pin| if (screen.pages.pointFromPin(.screen, pin.*) != null) {
            placed += 1;
        },
    };
    try out.value(placed);
    var placements = storage.placements.iterator();
    while (placements.next()) |kv| {
        const p = kv.value_ptr;
        const at: ?[2]u32 = switch (p.location) {
            .virtual => null,
            .pin => |pin| if (screen.pages.pointFromPin(.screen, pin.*)) |pt| .{ @intCast(pt.screen.x), @intCast(pt.screen.y) } else continue,
        };
        try out.value(kv.key_ptr.image_id);
        try out.value(kv.key_ptr.placement_id.tag == .external);
        try out.value(kv.key_ptr.placement_id.id);
        try out.value(at != null);
        if (at) |xy| {
            try out.value(xy[0]);
            try out.value(xy[1]);
        }
        inline for (.{ "x_offset", "y_offset", "source_x", "source_y", "source_width", "source_height", "columns", "rows", "z" }) |name| {
            try out.value(@field(p.*, name));
        }
    }
}

fn loadKittyImages(input: *snapshot.Reader, screen: *Screen, limit: usize) !void {
    const storage = &screen.kitty_images;
    storage.total_limit = limit;
    if (try input.value(bool)) {
        const loading = try input.alloc.create(tessera_kitty_image.LoadingImage);
        errdefer input.alloc.destroy(loading);
        const image = try input.value(tessera_kitty.Image);
        errdefer input.alloc.free(image.data);
        const data = try input.value([]u8);
        errdefer input.alloc.free(data);
        if (data.len > limit) return error.InvalidSnapshot;
        const display: ?@TypeOf(loading.display.?) = if (try input.value(bool)) try input.value(@TypeOf(loading.display.?)) else null;
        loading.* = .{ .image = image, .data = .fromOwnedSlice(data), .display = display, .quiet = try input.value(@TypeOf(loading.quiet)) };
        storage.loading = loading;
    }
    storage.next_image_id = try input.value(u32);
    storage.next_internal_placement_id = try input.value(u32);
    const images = try input.value(u32);
    if (images > 65536) return error.InvalidSnapshot;
    for (0..images) |_| {
        const image = try input.value(tessera_kitty.Image);
        errdefer input.alloc.free(image.data);
        const bytes: usize = switch (image.format) {
            .gray => 1,
            .gray_alpha => 2,
            .rgb => 3,
            .rgba => 4,
            .png => return error.InvalidSnapshot,
        };
        if (image.data.len != @as(usize, image.width) * image.height * bytes) return error.InvalidSnapshot;
        // Later transmissions must be newer than any restored one.
        tessera_kitty_image.transmit_counter = @max(tessera_kitty_image.transmit_counter, image.transmit_time);
        storage.addImage(input.alloc, image) catch return error.InvalidSnapshot;
    }
    const placements = try input.value(u32);
    if (placements > 262144) return error.InvalidSnapshot;
    for (0..placements) |_| {
        const image_id = try input.value(u32);
        const external = try input.value(bool);
        const id = try input.value(u32);
        var p: tessera_kitty.ImageStorage.Placement = .{ .location = .{ .virtual = {} } };
        if (try input.value(bool)) {
            const x = try input.value(u32);
            const y = try input.value(u32);
            const pin = screen.pages.pin(.{ .screen = .{ .x = @intCast(x), .y = y } }) orelse return error.InvalidSnapshot;
            p.location = .{ .pin = try screen.pages.trackPin(pin) };
        }
        inline for (.{ "x_offset", "y_offset", "source_x", "source_y", "source_width", "source_height", "columns", "rows", "z" }) |name| {
            @field(p, name) = try input.value(@TypeOf(@field(p, name)));
        }
        if (storage.imageById(image_id) == null) {
            p.deinit(screen);
            return error.InvalidSnapshot;
        }
        const key: tessera_kitty.ImageStorage.PlacementKey = .{ .image_id = image_id, .placement_id = .{ .tag = if (external) .external else .internal, .id = id } };
        const gop = storage.placements.getOrPut(input.alloc, key) catch return error.OutOfMemory;
        if (gop.found_existing) gop.value_ptr.deinit(screen);
        gop.value_ptr.* = p;
    }
    storage.dirty = true;
}
