
// Tessera OSC 8 hyperlinks. The pinned API reported every hyperlinked cell as
// id 1 and had no way to read a link's URI, so ghostty-web could neither tell
// links apart nor open one.

/// The id rendered cells report: a hash of the link's OSC 8 id and URI, the
/// same on every row and page the link spans and different between links.
fn tesseraHyperlinkId(page: *const @import("../page.zig").Page, cell: *const @import("../page.zig").Cell) u16 {
    if (!cell.hyperlink) return 0;
    const id = page.lookupHyperlink(cell) orelse return 1;
    const hash: u16 = @truncate(page.hyperlink_set.get(page.memory, id).hash(page.memory));
    return if (hash == 0) 1 else hash;
}

/// Copies the URI of the hyperlink on a cell of the active screen, rows
/// counted from the oldest scrollback line as ghostty-web's buffer counts
/// them. Returns the URI's full length, which may exceed capacity, or 0 when
/// the cell has no hyperlink.
pub fn hyperlink_uri(ptr: ?*anyopaque, row: u32, col: u32, out: [*]u8, capacity: u32) callconv(.c) u32 {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    if (col >= w.terminal.cols) return 0;
    const pin = w.terminal.screens.active.pages.pin(.{ .screen = .{ .x = @intCast(col), .y = row } }) orelse return 0;
    const cell = pin.rowAndCell().cell;
    if (!cell.hyperlink) return 0;
    const page = &pin.node.data;
    const id = page.lookupHyperlink(cell) orelse return 0;
    const uri = page.hyperlink_set.get(page.memory, id).uri.slice(page.memory);
    const n = @min(uri.len, capacity);
    @memcpy(out[0..n], uri[0..n]);
    return @intCast(uri.len);
}
