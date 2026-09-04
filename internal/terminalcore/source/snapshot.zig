//! Versioned logical core state. Pointer-bearing objects are reconstructed;
//! pages contain only relative offsets and are carried as relocatable payloads.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Writer = struct {
    alloc: Allocator,
    data: std.ArrayList(u8) = .{},
    pub fn deinit(self: *Writer) void { self.data.deinit(self.alloc); }
    pub fn value(self: *Writer, v: anytype) Allocator.Error!void {
        const T = @TypeOf(v);
        switch (@typeInfo(T)) {
            .void => {},
            .bool => try self.data.append(self.alloc, @intFromBool(v)),
            .int => |i| {
                const U = std.meta.Int(.unsigned, i.bits);
                const bits: U = @bitCast(v);
                inline for (0..(i.bits + 7) / 8) |n| try self.data.append(self.alloc, @truncate(@as(u64, bits >> (n * 8))));
            },
            .@"enum" => try self.value(@intFromEnum(v)),
            .array => for (v) |item| try self.value(item),
            .optional => { try self.value(v != null); if (v) |item| try self.value(item); },
            .@"struct" => |s| inline for (s.fields) |f| {
                // Hyperlink lookup context is transient and is rebound by each
                // page operation; its page pointers must never leave the core.
                const transient = comptime T == @import("../hyperlink.zig").Set and std.mem.eql(u8, f.name, "context");
                if (!f.is_comptime and !transient) try self.value(@field(v, f.name));
            },
            .@"union" => |u| {
                const Tag = u.tag_type orelse @compileError("untagged union is not a snapshot value: " ++ @typeName(T));
                const tag: Tag = v;
                try self.value(tag);
                inline for (u.fields) |f| if (tag == @field(Tag, f.name)) { try self.value(@field(v, f.name)); return; };
            },
            .pointer => |p| {
                if (p.size != .slice) @compileError("snapshot must not contain pointers: " ++ @typeName(T));
                try self.value(@as(u32, @intCast(v.len)));
                if (p.child == u8) try self.data.appendSlice(self.alloc, v) else for (v) |item| try self.value(item);
            },
            else => @compileError("unsupported snapshot type: " ++ @typeName(T)),
        }
    }
    pub fn fields(self: *Writer, object: anytype, comptime names: anytype) Allocator.Error!void {
        inline for (names) |name| try self.value(@field(object, name));
    }
};

pub const Reader = struct {
    alloc: Allocator,
    data: []const u8,
    offset: usize = 0,
    remaining_allocation: usize = 192 * 1024 * 1024,
    pub const Error = error{InvalidSnapshot} || Allocator.Error;

    pub fn take(self: *Reader, n: usize) Error![]const u8 {
        if (n > self.data.len - self.offset) return error.InvalidSnapshot;
        defer self.offset += n;
        return self.data[self.offset..][0..n];
    }
    pub fn value(self: *Reader, comptime T: type) Error!T {
        switch (@typeInfo(T)) {
            .void => return {},
            .bool => { const b = (try self.take(1))[0]; if (b > 1) return error.InvalidSnapshot; return b == 1; },
            .int => |i| {
                const U = std.meta.Int(.unsigned, i.bits);
                const bytes = try self.take((i.bits + 7) / 8);
                var bits: U = 0;
                inline for (0..(i.bits + 7) / 8) |n| bits |= @as(U, @truncate(@as(u64, bytes[n]))) << (n * 8);
                return @bitCast(bits);
            },
            .@"enum" => |e| return std.meta.intToEnum(T, try self.value(e.tag_type)) catch error.InvalidSnapshot,
            .array => |a| { var v: T = undefined; for (&v) |*item| item.* = try self.value(a.child); return v; },
            .optional => |o| return if (try self.value(bool)) try self.value(o.child) else null,
            .@"struct" => |s| {
                var v: T = undefined;
                inline for (s.fields) |f| if (!f.is_comptime) {
                    const transient = comptime T == @import("../hyperlink.zig").Set and std.mem.eql(u8, f.name, "context");
                    @field(v, f.name) = if (transient) .{} else try self.value(f.type);
                };
                return v;
            },
            .@"union" => |u| {
                const Tag = u.tag_type orelse @compileError("untagged union in snapshot");
                const tag = try self.value(Tag);
                inline for (u.fields) |f| if (tag == @field(Tag, f.name)) return @unionInit(T, f.name, try self.value(f.type));
                return error.InvalidSnapshot;
            },
            .pointer => |p| {
                if (p.size != .slice) @compileError("snapshot must not reconstruct raw pointers");
                const len = try self.value(u32);
                const bytes = std.math.mul(usize, len, @sizeOf(p.child)) catch return error.InvalidSnapshot;
                if (bytes > self.remaining_allocation) return error.InvalidSnapshot;
                self.remaining_allocation -= bytes;
                const result = try self.alloc.alloc(p.child, len);
                errdefer self.alloc.free(result);
                if (p.child == u8) {
                    @memcpy(result, try self.take(len));
                } else {
                    for (result) |*item| item.* = try self.value(p.child);
                }
                return result;
            },
            else => @compileError("unsupported snapshot type: " ++ @typeName(T)),
        }
    }
    pub fn fields(self: *Reader, object: anytype, comptime names: anytype) Error!void {
        inline for (names) |name| @field(object, name) = try self.value(@TypeOf(@field(object, name)));
    }
};
