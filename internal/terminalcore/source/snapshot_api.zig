
const snapshot = @import("snapshot.zig");
const Screen = @import("../Screen.zig");
const Page = @import("../page.zig").Page;
const terminal_fields = .{ "status_display", "rows", "cols", "width_px", "height_px", "scrolling_region", "colors", "previous_char", "modes", "mouse_shape", "flags" };
const screen_fields = .{ "no_scrollback", "saved_cursor", "charset", "protected_mode", "kitty_keyboard" };
const cursor_fields = .{ "x", "y", "cursor_style", "pending_wrap", "protected", "style", "style_id", "hyperlink_id", "hyperlink_implicit_id" };
const parser_fields = .{ "state", "intermediates", "intermediates_idx", "params", "params_sep", "params_idx", "param_acc", "param_acc_idx" };
const store_fields = .{ "palette", "active", "scrolling", "cell_width", "cell_height", "next_image", "revision", "memory_limit", "show_placeholders" };

fn saveScreen(out: *snapshot.Writer, screen: *Screen) !void {
    try out.fields(screen, screen_fields);
    try out.fields(screen.cursor, cursor_fields);
    try out.value(screen.cursor.hyperlink != null);
    if (screen.cursor.hyperlink) |link| try out.value(link.*);
    try out.value(@as(u32, @intCast(screen.pages.explicit_max_size)));
    var count: u32 = 0;
    var node = screen.pages.pages.first;
    while (node) |n| : (node = n.next) count += 1;
    try out.value(count);
    node = screen.pages.pages.first;
    while (node) |n| : (node = n.next) {
        try out.value(n.data.capacity);
        inline for (@typeInfo(Page).@"struct".fields) |f| {
            if (comptime !std.mem.eql(u8, f.name, "memory")) try out.value(@field(n.data, f.name));
        }
        try out.value(@as([]const u8, n.data.memory));
    }
}

fn loadScreen(input: *snapshot.Reader, screen: *Screen) !void {
    try input.fields(screen, screen_fields);
    try input.fields(&screen.cursor, cursor_fields);
    if (try input.value(bool)) {
        const Hyperlink = @import("../hyperlink.zig").Hyperlink;
        const link = try input.alloc.create(Hyperlink);
        errdefer input.alloc.destroy(link);
        link.* = try input.value(Hyperlink);
        screen.cursor.hyperlink = link;
    }
    screen.pages.explicit_max_size = try input.value(u32);
    const count = try input.value(u32);
    if (count == 0 or count > 16384) return error.InvalidSnapshot;
    while (screen.pages.pages.pop()) |node| screen.pages.destroyNode(node);
    screen.pages.total_rows = 0;
    for (0..count) |_| {
        const cap = try input.value(@import("../page.zig").Capacity);
        const allocation = Page.layout(cap).total_size;
        if (allocation > input.remaining_allocation) return error.InvalidSnapshot;
        input.remaining_allocation -= allocation;
        const node = try screen.pages.createPage(cap);
        screen.pages.pages.append(node);
        inline for (@typeInfo(Page).@"struct".fields) |f| {
            if (comptime !std.mem.eql(u8, f.name, "memory")) @field(node.data, f.name) = try input.value(f.type);
        }
        const size_bytes = try input.value(u32);
        if (size_bytes != node.data.memory.len or !std.meta.eql(cap, node.data.capacity)) return error.InvalidSnapshot;
        @memcpy(node.data.memory, try input.take(size_bytes));
        node.data.dirty = true;
        screen.pages.total_rows += node.data.size.rows;
    }
    if (screen.pages.total_rows < screen.pages.rows or screen.cursor.x >= screen.pages.cols or screen.cursor.y >= screen.pages.rows) return error.InvalidSnapshot;
    screen.pages.viewport = .active;
    screen.pages.viewport_pin.* = .{ .node = screen.pages.pages.first.? };
    const pin = screen.pages.pin(.{ .active = .{ .x = screen.cursor.x, .y = screen.cursor.y } }) orelse return error.InvalidSnapshot;
    screen.cursor.page_pin.* = pin;
    screen.cursor.page_row = pin.rowAndCell().row;
    screen.cursor.page_cell = pin.rowAndCell().cell;
}

fn saveState(w: *TerminalWrapper, out: *snapshot.Writer) !void {
    try out.value(@as(u32, 0x32535354)); // TSS2
    try out.value(@as(u32, w.terminal.cols));
    try out.value(@as(u32, w.terminal.rows));
    try out.value(@as(u32, @intCast(w.history_limit)));
    try out.fields(w.terminal, terminal_fields);
    try out.value(@as([]const u8, w.terminal.pwd.items));
    try out.value(w.terminal.tabstops);
    try out.value(w.terminal.screens.active_key);
    try saveScreen(out, w.terminal.screens.get(.primary).?);
    try out.value(w.terminal.screens.get(.alternate) != null);
    if (w.terminal.screens.get(.alternate)) |screen| try saveScreen(out, screen);
    try out.fields(w.stream.parser, parser_fields);
    try out.value(w.stream.utf8decoder);
    try out.value(@as([]const u8, w.stream.handler.osc_raw.items));
    try out.fields(w.sixel, store_fields);
    try out.value(w.sixel.decoder);
    try out.value(@as(u32, @intCast(w.sixel.images.count())));
    for (w.sixel.images.keys(), w.sixel.images.values()) |id, img| {
        try out.value(id);
        try out.value(img);
    }
    try out.value(@as([]const @import("sixel_store.zig").Tile, w.sixel.tiles.items));
}

pub fn sixel_snapshot_export(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    sixel_snapshot_release(ptr);
    var out: snapshot.Writer = .{ .alloc = w.alloc };
    defer out.deinit();
    saveState(w, &out) catch return 0;
    w.alloc.free(w.snapshot_data);
    w.snapshot_data = out.data.toOwnedSlice(w.alloc) catch return 0;
    return @intCast(w.snapshot_data.len);
}
pub fn sixel_snapshot_release(ptr: ?*anyopaque) callconv(.c) void {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return));
    w.alloc.free(w.snapshot_data);
    w.snapshot_data = &.{};
}
pub fn sixel_snapshot_data(ptr: ?*anyopaque) callconv(.c) ?[*]const u8 {
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr orelse return null));
    return w.snapshot_data.ptr;
}

pub fn sixel_snapshot_import(data: [*]const u8, len: u32) callconv(.c) ?*anyopaque {
    const alloc = if (builtin.target.cpu.arch.isWasm()) std.heap.wasm_allocator else std.heap.c_allocator;
    var input: snapshot.Reader = .{ .alloc = alloc, .data = data[0..len] };
    return loadState(&input) catch null;
}
fn loadState(input: *snapshot.Reader) !*anyopaque {
    if (try input.value(u32) != 0x32535354) return error.InvalidSnapshot;
    const cols = try input.value(u32);
    const rows = try input.value(u32);
    if (cols < 2 or rows < 1 or cols > 4096 or rows > 4096) return error.InvalidSnapshot;
    const ptr = new(@intCast(cols), @intCast(rows)) orelse return error.OutOfMemory;
    errdefer free(ptr);
    const w: *TerminalWrapper = @ptrCast(@alignCast(ptr));
    w.history_limit = try input.value(u32);
    if (w.history_limit > 100000) return error.InvalidSnapshot;
    try input.fields(&w.terminal, terminal_fields);
    const pwd = try input.value([]u8);
    w.terminal.pwd = .fromOwnedSlice(pwd);
    w.terminal.tabstops.deinit(w.alloc);
    w.terminal.tabstops = try input.value(@TypeOf(w.terminal.tabstops));
    const key = try input.value(@TypeOf(w.terminal.screens.active_key));
    try loadScreen(input, w.terminal.screens.get(.primary).?);
    if (try input.value(bool)) {
        const alt = try w.terminal.screens.getInit(w.alloc, .alternate, .{ .cols = @intCast(cols), .rows = @intCast(rows), .max_scrollback = 0 });
        try loadScreen(input, alt);
    }
    if (w.terminal.screens.get(key) == null) return error.InvalidSnapshot;
    w.terminal.screens.switchTo(key);
    try input.fields(&w.stream.parser, parser_fields);
    w.stream.utf8decoder = try input.value(@TypeOf(w.stream.utf8decoder));
    const osc_raw = try input.value([]u8);
    defer w.alloc.free(osc_raw);
    if (w.stream.parser.state == .osc_string and osc_raw.len > 0) {
        w.stream.parser.state = .ground;
        try w.stream.nextSlice(osc_raw);
    }
    try input.fields(&w.sixel, store_fields);
    if (w.sixel.memory_limit != 16 * 1024 * 1024 and w.sixel.memory_limit != 32 * 1024 * 1024 and w.sixel.memory_limit != 64 * 1024 * 1024) return error.InvalidSnapshot;
    w.sixel.decoder = try input.value(@TypeOf(w.sixel.decoder));
    const image_count = try input.value(u32);
    if (image_count > 262143) return error.InvalidSnapshot;
    for (0..image_count) |_| {
        const id = try input.value(u32);
        const img = try input.value(@import("sixel_store.zig").Image);
        try w.sixel.images.put(w.alloc, id, img);
    }
    w.sixel.tiles = .fromOwnedSlice(try input.value([]@import("sixel_store.zig").Tile));
    if (input.offset != input.data.len) return error.InvalidSnapshot;
    w.terminal.flags.dirty.clear = true;
    w.response_buffer.clearRetainingCapacity();
    return ptr;
}
