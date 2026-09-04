//! Incremental SIXEL raster decoder. No terminal or platform dependencies.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const pixel_limit = 16_000_000;
pub const byte_limit = 32 * 1024 * 1024;
pub const storage_limit = 64 * 1024 * 1024;
pub const palette_size = 256;

pub fn defaultPalette() [palette_size]u32 {
    var result: [palette_size]u32 = @splat(0xff000000);
    const colors = [_]u32{ 0x000000, 0x3333cc, 0xcc2121, 0x33cc33, 0xcc33cc, 0x33cccc, 0xcccc33, 0x878787, 0x424242, 0x545499, 0x994242, 0x549954, 0x995499, 0x549999, 0x999954, 0xcccccc };
    for (colors, 0..) |rgb, i| result[i] = rgba(@truncate(rgb >> 16), @truncate(rgb >> 8), @truncate(rgb));
    const levels = [_]u8{ 0, 95, 135, 175, 215, 255 };
    for (16..232) |i| {
        const n = i - 16;
        result[i] = rgba(levels[n / 36], levels[n / 6 % 6], levels[n % 6]);
    }
    for (232..256) |i| {
        const value: u8 = @intCast(8 + (i - 232) * 10);
        result[i] = rgba(value, value, value);
    }
    return result;
}

fn rgba(r: u8, g: u8, b: u8) u32 {
    // Little-endian WASM memory can be read directly as ImageData RGBA bytes.
    return @as(u32, r) | (@as(u32, g) << 8) | (@as(u32, b) << 16) | 0xff000000;
}

pub const Decoder = struct {
    pixels: []u32 = &.{},
    stride: u32 = 0,
    capacity_height: u32 = 0,
    width: u32 = 0,
    height: u32 = 0,
    declared_width: u32 = 0,
    declared_height: u32 = 0,
    x: u32 = 0,
    y: u32 = 0,
    background: u32 = 0,
    color: u8 = 0,
    bytes: usize = 0,
    // A total painting budget prevents a tiny input from repeatedly repainting
    // the same enormous raster. Rejected images are consumed, never printed.
    painted: usize = 0,
    failed: bool = false,
    command: u8 = 0,
    params: [5]u32 = @splat(0),
    param: usize = 0,
    has_param: bool = false,
    repeat: u32 = 1,

    const Unlimited = struct { pub fn reserve(_: @This(), _: usize) error{TooLarge}!void {} };

    pub fn deinit(self: *Decoder, alloc: Allocator) void {
        alloc.free(self.pixels);
        self.* = .{};
    }

    pub fn put(self: *Decoder, alloc: Allocator, palette: *[palette_size]u32, ch: u8) void {
        self.putBudget(alloc, palette, ch, Unlimited{});
    }

    pub fn putBudget(self: *Decoder, alloc: Allocator, palette: *[palette_size]u32, ch: u8, budget: anytype) void {
        if (self.failed) return;
        self.bytes += 1;
        if (self.bytes > byte_limit) self.failed = true;
        if (self.failed) return;
        self.consume(alloc, palette, ch, budget) catch {
            self.failed = true;
            alloc.free(self.pixels);
            self.pixels = &.{};
        };
    }

    fn consume(self: *Decoder, alloc: Allocator, palette: *[palette_size]u32, ch: u8, budget: anytype) !void {
        if (self.command != 0) {
            if (ch >= '0' and ch <= '9') {
                self.params[self.param] = @min(pixel_limit + 1, self.params[self.param] *| 10 +| (ch - '0'));
                self.has_param = true;
                return;
            }
            if (ch == ';' and self.command != '!') {
                if (self.param == self.params.len - 1) return error.BadParameters;
                self.param += 1;
                return;
            }
            try self.finishCommand(palette);
        }
        switch (ch) {
            '!', '"', '#' => {
                self.command = ch;
                self.params = @splat(0);
                self.param = 0;
                self.has_param = false;
            },
            '$' => self.x = 0,
            '-' => {
                self.x = 0;
                self.y +|= 6;
                if (self.y > pixel_limit) return error.TooLarge;
            },
            '?'...'~' => {
                const count = self.repeat;
                self.repeat = 1;
                const right = self.x +| count;
                if (right > pixel_limit) return error.TooLarge;
                const width = if (self.declared_width > 0) @min(right, self.declared_width) else right;
                const bottom = self.y +| 6;
                const height = if (self.declared_height > 0) @min(bottom, self.declared_height) else bottom;
                if (@as(u64, width) * height > pixel_limit) return error.TooLarge;
                if (self.x < width and self.y < height) {
                    const work = @as(usize, width - self.x) * (height - self.y);
                    self.painted += work;
                    if (self.painted > pixel_limit * 4 or work > 1024 * 1024) return error.TooMuchWork;
                    try self.ensureSize(alloc, width, height, budget);
                    const bits = ch - '?';
                    for (self.y..height) |y| {
                        if (bits & (@as(u8, 1) << @as(u3, @intCast(y - self.y))) != 0) {
                            @memset(self.pixels[y * self.stride + self.x .. y * self.stride + width], palette[self.color]);
                        }
                    }
                    self.width = @max(self.width, width);
                    self.height = @max(self.height, height);
                }
                self.x = right;
            },
            else => {}, // permitted controls and unrecognized data are ignored
        }
    }

    fn finishCommand(self: *Decoder, palette: *[palette_size]u32) !void {
        const command = self.command;
        self.command = 0;
        const p = self.params;
        switch (command) {
            '!' => {
                self.repeat = @max(1, p[0]);
                if (self.repeat > pixel_limit) return error.TooLarge;
            },
            '"' => {
                if (self.param >= 3) {
                    if (@as(u64, p[2]) * p[3] > pixel_limit or p[2] > pixel_limit or p[3] > pixel_limit) return error.TooLarge;
                    self.declared_width = p[2];
                    self.declared_height = p[3];
                }
            },
            '#' => {
                if (p[0] >= palette_size) return error.BadColor;
                self.color = @intCast(p[0]);
                if (self.param == 4) {
                    if (p[1] == 2) {
                        palette[self.color] = rgba(percent(p[2]), percent(p[3]), percent(p[4]));
                    } else if (p[1] == 1) {
                        palette[self.color] = hls(p[2], p[3], p[4]);
                    }
                }
            },
            else => {},
        }
    }

    pub fn finish(self: *Decoder, alloc: Allocator, palette: *[palette_size]u32) void {
        self.finishBudget(alloc, palette, Unlimited{});
    }

    pub fn finishBudget(self: *Decoder, alloc: Allocator, palette: *[palette_size]u32, budget: anytype) void {
        if (self.failed) return;
        self.finishCommand(palette) catch {
            self.failed = true;
            return;
        };
        const width = @max(self.width, self.declared_width);
        const height = @max(self.height, self.declared_height);
        self.ensureSize(alloc, width, height, budget) catch {
            self.failed = true;
            return;
        };
        self.width = width;
        self.height = height;
    }

    fn ensureSize(self: *Decoder, alloc: Allocator, width: u32, height: u32, budget: anytype) !void {
        if (width == 0 or height == 0) return;
        if (@as(u64, width) * height > pixel_limit) return error.TooLarge;
        if (width <= self.stride and height <= self.capacity_height) return;
        var stride = @max(width, self.stride);
        var rows = @max(height, self.capacity_height);
        // Geometric growth avoids quadratic copies for dimensionless images.
        const wider = @max(stride, self.stride * 2);
        const taller = @max(rows, self.capacity_height * 2);
        if (@as(u64, wider) * taller <= pixel_limit) {
            stride = wider;
            rows = taller;
        }
        // Account for both rasters during growth, before allocating a copy.
        try budget.reserve((@as(usize, stride) * rows + self.pixels.len) * 4);
        const pixels = try alloc.alloc(u32, @as(usize, stride) * rows);
        @memset(pixels, self.background);
        for (0..self.capacity_height) |y| {
            @memcpy(pixels[y * stride .. y * stride + self.stride], self.pixels[y * self.stride ..][0..self.stride]);
        }
        alloc.free(self.pixels);
        self.pixels = pixels;
        self.stride = stride;
        self.capacity_height = rows;
    }
};

fn percent(value: u32) u8 {
    return @intCast((@as(u32, @min(value, 100)) * 255 + 50) / 100);
}

fn hls(hue: u32, lightness: u32, saturation: u32) u32 {
    // DEC's hue wheel starts at blue: 0=blue, 120=red, 240=green.
    const h: f64 = @as(f64, @floatFromInt((hue +| 240) % 360)) / 60;
    const l: f64 = @as(f64, @floatFromInt(@min(lightness, 100))) / 100;
    const s: f64 = @as(f64, @floatFromInt(@min(saturation, 100))) / 100;
    const c = (1 - @abs(2 * l - 1)) * s;
    const x = c * (1 - @abs(@mod(h, 2) - 1));
    const m = l - c / 2;
    const rgb: [3]f64 = switch (@as(u3, @intFromFloat(h))) {
        0 => .{ c, x, 0 }, 1 => .{ x, c, 0 }, 2 => .{ 0, c, x },
        3 => .{ 0, x, c }, 4 => .{ x, 0, c }, else => .{ c, 0, x },
    };
    return rgba(@intFromFloat(@round((rgb[0] + m) * 255)), @intFromFloat(@round((rgb[1] + m) * 255)), @intFromFloat(@round((rgb[2] + m) * 255)));
}

test "raster, repetition, RGB and transparent background" {
    var d: Decoder = .{};
    defer d.deinit(std.testing.allocator);
    var palette = defaultPalette();
    for ("\"1;1;3;6#1;2;100;0;0!3@") |ch| d.put(std.testing.allocator, &palette, ch);
    d.finish(std.testing.allocator, &palette);
    try std.testing.expect(!d.failed);
    try std.testing.expectEqual(@as(u32, 3), d.width);
    try std.testing.expectEqual(@as(u32, 6), d.height);
    try std.testing.expectEqual(rgba(255, 0, 0), d.pixels[0]);
    try std.testing.expectEqual(rgba(255, 0, 0), d.pixels[2]);
    try std.testing.expectEqual(@as(u32, 0), d.pixels[d.stride]);
}

test "palette changes do not recolor existing pixels" {
    var d: Decoder = .{};
    defer d.deinit(std.testing.allocator);
    var palette = defaultPalette();
    for ("#1;2;100;0;0@#1;2;0;100;0@") |ch| d.put(std.testing.allocator, &palette, ch);
    d.finish(std.testing.allocator, &palette);
    try std.testing.expectEqual(rgba(255, 0, 0), d.pixels[0]);
    try std.testing.expectEqual(rgba(0, 255, 0), d.pixels[1]);
}

test "HLS primary colors" {
    try std.testing.expectEqual(rgba(0, 0, 255), hls(0, 50, 100));
    try std.testing.expectEqual(rgba(255, 0, 0), hls(120, 50, 100));
    try std.testing.expectEqual(rgba(0, 255, 0), hls(240, 50, 100));
}

test "oversized raster and repeat are rejected before allocation" {
    for ([_][]const u8{ "\"1;1;100000;100000~", "!999999999999999999~" }) |data| {
        var d: Decoder = .{};
        defer d.deinit(std.testing.allocator);
        var palette = defaultPalette();
        for (data) |ch| d.put(std.testing.allocator, &palette, ch);
        try std.testing.expect(d.failed);
        try std.testing.expectEqual(@as(usize, 0), d.pixels.len);
    }
}
