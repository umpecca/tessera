const std = @import("std");
const sixel = @import("sixel");

const Budget = struct {
    peak: *usize,
    pub fn reserve(self: @This(), bytes: usize) error{TooLarge}!void {
        self.peak.* = @max(self.peak.*, bytes);
        std.debug.print("reserve {d} bytes ({d:.2} MiB)\n", .{ bytes, @as(f64, @floatFromInt(bytes)) / (1024 * 1024) });
        if (bytes > 64 * 1024 * 1024) return error.TooLarge;
    }
};

test "measure dense raster growth against the native 64 MiB budget" {
    const alloc = std.testing.allocator;
    var decoder: sixel.Decoder = .{};
    defer decoder.deinit(alloc);
    var palette = sixel.defaultPalette();
    var peak: usize = 0;
    const budget: Budget = .{ .peak = &peak };
    for ("\"1;1;1024;720#1;2;100;0;0") |ch| decoder.putBudget(alloc, &palette, ch, budget);
    for (0..120) |row| {
        const stripe = if (row % 2 == 0) "#1!1024~-" else "#2;2;0;100;0!1024~-";
        for (stripe) |ch| decoder.putBudget(alloc, &palette, ch, budget);
        if (decoder.failed) {
            std.debug.print("failed at stripe {d}, stride {d}, capacity_height {d}, peak {d} bytes\n", .{ row, decoder.stride, decoder.capacity_height, peak });
            break;
        }
    }
    decoder.finishBudget(alloc, &palette, budget);
    std.debug.print("accepted={any}, stride {d}, capacity_height {d}, peak {d} bytes\n", .{ !decoder.failed, decoder.stride, decoder.capacity_height, peak });
    try std.testing.expect(!decoder.failed);
    try std.testing.expectEqual(@as(u32, 1024), decoder.width);
    try std.testing.expectEqual(@as(u32, 720), decoder.height);
    try std.testing.expect(peak <= 5 * 1024 * 1024);
}
