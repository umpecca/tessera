//! Transient audio effects. OSC parsing stays in the shared terminal stream.
const std = @import("std");

pub const prefix = "\x1b]777;tessera-audio;1;";
pub const maximum_command = 699_200; // 512 KiB base64 plus bounded metadata.
const maximum_bytes = 2 * 1024 * 1024;
const maximum_events = 8;

pub const Effects = struct {
    bytes: std.ArrayList(u8) = .{},
    offset: usize = 0,
    count: usize = 0,

    pub fn deinit(self: *Effects, alloc: std.mem.Allocator) void {
        self.bytes.deinit(alloc);
        self.* = .{};
    }

    pub fn push(self: *Effects, alloc: std.mem.Allocator, command: []const u8) !void {
        if (command.len > maximum_command) return;
        if (self.count >= maximum_events or self.bytes.items.len + command.len + 4 > maximum_bytes) {
            self.bytes.clearRetainingCapacity();
            self.offset = 0;
            self.count = 0;
            try self.push(alloc, "reset");
        }
        var length: [4]u8 = undefined;
        std.mem.writeInt(u32, &length, @intCast(command.len), .little);
        try self.bytes.appendSlice(alloc, &length);
        try self.bytes.appendSlice(alloc, command);
        self.count += 1;
    }

    pub fn request(self: *Effects, alloc: std.mem.Allocator, command: []const u8) !void {
        if (!std.mem.startsWith(u8, command, "play;") and !std.mem.startsWith(u8, command, "stop;") and !std.mem.startsWith(u8, command, "query;")) return;
        try self.push(alloc, command);
    }

    pub fn read(self: *Effects, out: [*]u8, capacity: usize) usize {
        const count = @min(capacity, self.bytes.items.len - self.offset);
        @memcpy(out[0..count], self.bytes.items[self.offset..][0..count]);
        self.offset += count;
        if (self.offset == self.bytes.items.len) {
            self.bytes.clearRetainingCapacity();
            self.offset = 0;
            self.count = 0;
        }
        return count;
    }
};
