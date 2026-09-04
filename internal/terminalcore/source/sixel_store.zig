//! Cell attachments move with Ghostty's existing copy, erase and reflow paths.
const std = @import("std");
const Terminal = @import("../Terminal.zig");
const codec = @import("sixel.zig");
const Allocator = std.mem.Allocator;

pub const Tile = struct {
    image: u32 = 0,
    x: u32 = 0,
    y: u32 = 0,
    underneath: u18 = 0,
    marked: bool = false,
};
pub const Image = struct {
    pixels: []u32,
    width: u32,
    height: u32,
    stride: u32,
    cell_width: u32,
    cell_height: u32,
};

pub const Store = struct {
    decoder: codec.Decoder = .{},
    palette: [codec.palette_size]u32 = codec.defaultPalette(),
    active: bool = false,
    scrolling: bool = true,
    cell_width: u32 = 8,
    cell_height: u32 = 16,
    memory_limit: usize = codec.storage_limit,
    show_placeholders: bool = true,
    images: std.AutoArrayHashMapUnmanaged(u32, Image) = .{},
    tiles: std.ArrayList(Tile) = .{},
    free_tiles: std.ArrayList(u18) = .{},
    next_image: u32 = 1,
    revision: u32 = 1,

    pub fn deinit(self: *Store, alloc: Allocator) void {
        self.decoder.deinit(alloc);
        for (self.images.values()) |img| alloc.free(img.pixels);
        self.images.deinit(alloc);
        self.tiles.deinit(alloc);
        self.free_tiles.deinit(alloc);
        self.* = .{};
    }

    pub fn begin(self: *Store, alloc: Allocator, t: *Terminal, dcs: anytype) void {
        self.decoder.deinit(alloc);
        self.active = dcs.final == 'q' and dcs.intermediates.len == 0;
        if (!self.active) return;
        if (dcs.params.len < 2 or dcs.params[1] != 1) {
            const bg = t.colors.background.get() orelse @import("../color.zig").RGB{ .r = 0, .g = 0, .b = 0 };
            self.decoder.background = @as(u32, bg.r) | (@as(u32, bg.g) << 8) | (@as(u32, bg.b) << 16) | 0xff000000;
        }
    }

    pub fn clearImages(self: *Store, alloc: Allocator, t: *Terminal) void {
        self.decoder.deinit(alloc);
        // Keep consuming an interrupted DCS, but never place its old pixels.
        self.decoder.failed = self.active;
        for (self.images.values()) |img| alloc.free(img.pixels);
        self.images.deinit(alloc);
        self.images = .{};
        self.tiles.deinit(alloc);
        self.tiles = .{};
        self.free_tiles.deinit(alloc);
        self.free_tiles = .{};
        var screens = t.screens.all.iterator();
        while (screens.next()) |entry| {
            var node = entry.value.*.pages.pages.first;
            while (node) |n| : (node = n.next) {
                const page = &n.data;
                for (page.rows.ptr(page.memory)[0..page.size.rows]) |*row| {
                    for (row.cells.ptr(page.memory)[0..page.size.cols]) |*cell| cell.sixel = 0;
                    row.dirty = true;
                }
                page.dirty = true;
            }
        }
        self.revision +%= 1;
        t.flags.dirty.clear = true;
    }

    pub fn configureImages(self: *Store, alloc: Allocator, t: *Terminal, limit: usize, placeholders: bool) void {
        self.memory_limit = limit;
        self.show_placeholders = placeholders;
        if (self.decoder.pixels.len * 4 > limit) {
            self.decoder.deinit(alloc);
            self.decoder.failed = self.active;
        }
        self.enforceBudget(alloc, self.decoder.pixels.len * 4);
        self.revision +%= 1;
        t.flags.dirty.clear = true;
    }

    pub fn put(self: *Store, alloc: Allocator, ch: u8) void {
        if (!self.active) return;
        self.decoder.putBudget(alloc, &self.palette, ch, Budget{ .store = self, .alloc = alloc });
    }

    const Budget = struct {
        store: *Store,
        alloc: Allocator,
        pub fn reserve(self: @This(), bytes: usize) error{TooLarge}!void {
            if (bytes > self.store.memory_limit) return error.TooLarge;
            self.store.enforceBudget(self.alloc, bytes);
        }
    };

    fn enforceBudget(self: *Store, alloc: Allocator, construction_bytes: usize) void {
        var bytes = construction_bytes;
        for (self.images.values()) |img| bytes += img.pixels.len * 4;
        for (self.images.values()) |*img| {
            if (bytes <= self.memory_limit) break;
            if (img.pixels.len == 0) continue;
            bytes -= img.pixels.len * 4;
            alloc.free(img.pixels);
            // Retain only dimensions and cell attachments for the placeholder.
            img.pixels = &.{};
            self.revision +%= 1;
        }
    }

    pub fn end(self: *Store, alloc: Allocator, t: *Terminal) !void {
        if (!self.active) return;
        self.active = false;
        self.decoder.finishBudget(alloc, &self.palette, Budget{ .store = self, .alloc = alloc });
        defer self.decoder.deinit(alloc);
        if (self.decoder.failed or self.decoder.width == 0 or self.decoder.height == 0) return;
        self.enforceBudget(alloc, self.decoder.pixels.len * 4);
        try self.collect(alloc, t);
        const d = &self.decoder;
        const cursor = t.screens.active.cursor;
        const start_x: u32 = if (self.scrolling) cursor.x else 0;
        const start_y: u32 = if (self.scrolling) cursor.y else 0;
        const cols = @min((d.width + self.cell_width - 1) / self.cell_width, t.cols - start_x);
        const rows = (d.height + self.cell_height - 1) / self.cell_height;
        const required = @as(u64, cols) * rows;
        const tile_limit = std.math.maxInt(u18) - 1;
        if (required > tile_limit) return;
        while (self.tiles.items.len - self.free_tiles.items.len + required > tile_limit and self.images.count() > 0) {
            alloc.free(self.images.values()[0].pixels);
            _ = self.images.orderedRemove(self.images.keys()[0]);
            self.revision +%= 1;
            try self.collect(alloc, t);
        }
        const image_id = self.next_image;
        self.next_image +%= 1;
        if (self.next_image == 0) self.next_image = 1;
        try self.images.put(alloc, image_id, .{
            .pixels = d.pixels, .width = d.width, .height = d.height, .stride = d.stride,
            .cell_width = self.cell_width, .cell_height = self.cell_height,
        });
        d.pixels = &.{};
        if (self.tiles.items.len == 0) try self.tiles.append(alloc, .{});
        for (0..rows) |row| {
            if (self.scrolling and row > 0) try t.index();
            const y = if (self.scrolling) t.screens.active.cursor.y else start_y + @as(u32, @intCast(row));
            if (y >= t.rows) break;
            const pin = t.screens.active.pages.pin(.{ .active = .{ .y = @intCast(y) } }) orelse break;
            const cells = pin.cells(.all);
            for (0..cols) |col| {
                const tile: Tile = .{ .image = image_id, .x = @intCast(col * self.cell_width), .y = @intCast(row * self.cell_height), .underneath = cells[start_x + col].sixel };
                const id: u18 = if (self.free_tiles.pop()) |id| id else blk: {
                    if (self.tiles.items.len >= std.math.maxInt(u18)) break;
                    try self.tiles.append(alloc, .{});
                    break :blk @intCast(self.tiles.items.len - 1);
                };
                self.tiles.items[id] = tile;
                cells[start_x + col].sixel = id;
            }
            pin.rowAndCell().row.dirty = true;
        }
        if (self.scrolling) {
            // index() already preserves the image's first column. Do not use
            // CUP here: it would apply origin-mode margins a second time.
            t.screens.active.cursor.pending_wrap = false;
        }
        self.revision +%= 1;
        t.flags.dirty.clear = true;
    }

    pub fn collect(self: *Store, alloc: Allocator, t: *Terminal) !void {
        if (self.images.count() == 0 and self.tiles.items.len == 0) return;
        for (self.tiles.items) |*tile| tile.marked = false;
        var screens = t.screens.all.iterator();
        while (screens.next()) |entry| {
            var node = entry.value.*.pages.pages.first;
            while (node) |n| : (node = n.next) {
                const page = &n.data;
                for (page.rows.ptr(page.memory)[0..page.size.rows]) |*row| {
                    for (row.cells.ptr(page.memory)[0..page.size.cols]) |*cell| {
                        // Unlink descriptors removed to reclaim fragment capacity.
                        var previous: u18 = 0;
                        var id = cell.sixel;
                        while (id != 0 and id < self.tiles.items.len) {
                            const tile = &self.tiles.items[id];
                            if (!self.images.contains(tile.image)) {
                                if (previous == 0) cell.sixel = tile.underneath else self.tiles.items[previous].underneath = tile.underneath;
                                id = tile.underneath;
                                continue;
                            }
                            if (tile.marked) break;
                            tile.marked = true;
                            previous = id;
                            id = tile.underneath;
                        }
                    }
                }
            }
        }
        self.free_tiles.clearRetainingCapacity();
        var live: std.AutoHashMapUnmanaged(u32, void) = .{};
        defer live.deinit(alloc);
        for (self.tiles.items, 0..) |*tile, id| {
            if (id == 0) continue;
            if (tile.marked) {
                try live.put(alloc, tile.image, {});
            } else {
                tile.* = .{};
                try self.free_tiles.append(alloc, @intCast(id));
            }
        }
        var i: usize = 0;
        while (i < self.images.count()) {
            const id = self.images.keys()[i];
            if (live.contains(id)) {
                i += 1;
            } else {
                alloc.free(self.images.values()[i].pixels);
                _ = self.images.orderedRemove(id);
                self.revision +%= 1;
            }
        }
        if (self.images.count() == 0) {
            self.tiles.deinit(alloc);
            self.tiles = .{};
            self.free_tiles.deinit(alloc);
            self.free_tiles = .{};
            self.images.deinit(alloc);
            self.images = .{};
        }
    }
};
