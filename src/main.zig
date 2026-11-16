//! Zimika — a lightweight YouTube Music player built on MyZig.
const std = @import("std");
const builtin = @import("builtin");
const myzig = @import("myzig");

const frontend = [_]myzig.FrontendFile{
    .{ .path = "index.html", .mime = "text/html; charset=utf-8", .data = @embedFile("index.html") },
    .{ .path = "styles.css", .mime = "text/css; charset=utf-8", .data = @embedFile("styles.css") },
    .{ .path = "app.js", .mime = "text/javascript; charset=utf-8", .data = @embedFile("app.js") },
};

const default_settings =
    "{\"theme\":\"auto\",\"accent\":\"#d9a441\",\"accentFromArt\":false,\"zoom\":100," ++
    "\"volume\":80,\"repeat\":\"off\",\"shuffle\":false,\"scrobbles\":[],\"autoRadio\":true," ++
    "\"recent\":[],\"queue\":[],\"index\":0,\"history\":[],\"playlists\":[],\"liked\":[]," ++
    "\"followed\":[],\"savedAlbums\":[],\"cookiesBrowser\":\"\",\"cacheCount\":20," ++
    "\"lyricsSource\":\"auto\",\"shortcuts\":{},\"lastfm\":{\"key\":\"\",\"secret\":\"\",\"session\":\"\"}}";

const yt_name = if (builtin.os.tag == .windows) "yt-dlp.exe" else "yt-dlp";
const mpv_name = if (builtin.os.tag == .windows) "mpv.exe" else "mpv";
const curl_name = if (builtin.os.tag == .windows) "curl.exe" else "curl";

const Player = struct {
    child: *std.process.Child,
    gen: u64,
};

const State = struct {
    app: *myzig.App,
    gpa: std.mem.Allocator,
    io: std.Io,
    settings_path: []const u8,
    data_dir: []const u8,
    cache_dir: []const u8,
    mutex: std.Io.Mutex = .init,
    player: ?Player = null,
    next_gen: u64 = 1,
    quit: std.atomic.Value(bool) = .init(false),
    window: ?myzig.Window = null,
    ready: bool = false,
};

var reply: std.ArrayListUnmanaged(u8) = .empty;
var text_buf: std.ArrayListUnmanaged(u8) = .empty;
var str_buf: std.ArrayListUnmanaged(u8) = .empty;

const J = struct {
    list: *std.ArrayListUnmanaged(u8),
    gpa: std.mem.Allocator,
    fn raw(self: J, s: []const u8) void {
        self.list.appendSlice(self.gpa, s) catch {};
    }
    fn str(self: J, s: []const u8) void {
        appendJsonString(self.list, self.gpa, s) catch {};
    }
    fn num(self: J, v: anytype) void {
        var b: [32]u8 = undefined;
        self.raw(std.fmt.bufPrint(&b, "{d}", .{v}) catch return);
    }
};

fn begin(gpa: std.mem.Allocator) J {
    reply.clearRetainingCapacity();
    return .{ .list = &reply, .gpa = gpa };
}

fn replyString(gpa: std.mem.Allocator, text: []const u8) myzig.ipc.Result {
    str_buf.clearRetainingCapacity();
    str_buf.appendSlice(gpa, text) catch return failed(error.OutOfMemory);
    return myzig.ipc.Result.success(.{ .string = str_buf.items });
}

fn failed(e: anyerror) myzig.ipc.Result {
    myzig.log.err("zimika: {s}", .{@errorName(e)});
    return myzig.ipc.Result.fail(.internal, @errorName(e));
}

fn stateOf(ctx: ?*anyopaque) *State {
    return @ptrCast(@alignCast(ctx.?));
}

fn appendJsonString(buf: *std.ArrayListUnmanaged(u8), gpa: std.mem.Allocator, text: []const u8) !void {
    try buf.append(gpa, '"');
    for (text) |c| switch (c) {
        '"' => try buf.appendSlice(gpa, "\\\""),
        '\\' => try buf.appendSlice(gpa, "\\\\"),
        '\n' => try buf.appendSlice(gpa, "\\n"),
        '\r' => try buf.appendSlice(gpa, "\\r"),
        '\t' => try buf.appendSlice(gpa, "\\t"),
        else => if (c < 0x20) {
            var esc: [6]u8 = undefined;
            try buf.appendSlice(gpa, std.fmt.bufPrint(&esc, "\\u{x:0>4}", .{c}) catch continue);
        } else try buf.append(gpa, c),
    };
    try buf.append(gpa, '"');
}

fn dataDir(gpa: std.mem.Allocator) ![]const u8 {
    if (myzig.env.get("ZIMIKA_DATA_DIR")) |d| return gpa.dupe(u8, d);
    if (myzig.env.get("XDG_DATA_HOME")) |x| return std.fs.path.join(gpa, &.{ x, "zimika" });
    const home = myzig.env.get("HOME") orelse myzig.env.get("USERPROFILE") orelse return error.NoHomeDirectory;
    return std.fs.path.join(gpa, &.{ home, ".local", "share", "zimika" });
}
fn configPath(gpa: std.mem.Allocator) ![]const u8 {
    if (myzig.env.get("ZIMIKA_DATA_DIR")) |d| return std.fs.path.join(gpa, &.{ d, "settings.json" });
    if (myzig.env.get("XDG_CONFIG_HOME")) |x| return std.fs.path.join(gpa, &.{ x, "zimika", "settings.json" });
    if (myzig.env.get("APPDATA")) |x| return std.fs.path.join(gpa, &.{ x, "zimika", "settings.json" });
    const home = myzig.env.get("HOME") orelse myzig.env.get("USERPROFILE") orelse return error.NoHomeDirectory;
    return std.fs.path.join(gpa, &.{ home, ".config", "zimika", "settings.json" });
}
fn toolVersion(state: *State, name: []const u8) []const u8 {
    const result = std.process.run(state.gpa, state.io, .{
        .argv = &.{ name, "--version" },
        .stdout_limit = .limited(4096),
        .stderr_limit = .limited(8192),
    }) catch return "";
    defer state.gpa.free(result.stdout);
    defer state.gpa.free(result.stderr);
    if (!result.term.success()) return "";
    const clean = std.mem.trim(u8, result.stdout, " \t\r\n");
    return state.gpa.dupe(u8, clean) catch "";
}

// ------------------------------------------------------------------ services

fn appStatus(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    _ = args;
    const state = stateOf(ctx);
    const j = begin(state.gpa);
    const ytv = toolVersion(state, yt_name);
    const mpvv = toolVersion(state, mpv_name);
    const curlv = toolVersion(state, curl_name);
    j.raw("{\"ytdlp\":");
    j.str(ytv);
    j.raw(",\"mpv\":");
    j.str(mpvv);
    j.raw(",\"curl\":");
    j.str(curlv);
    j.raw(",\"data\":");
    j.str(state.data_dir);
    j.raw(",\"cache\":");
    j.str(state.cache_dir);
    j.raw("}");
    return myzig.ipc.Result.successRaw(reply.items);
}

fn settingsLoad(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    _ = args;
    const state = stateOf(ctx);
    const content = std.Io.Dir.cwd().readFileAlloc(state.io, state.settings_path, state.gpa, .limited(8 * 1024 * 1024)) catch |e| switch (e) {
        error.FileNotFound => {
            text_buf.clearRetainingCapacity();
            text_buf.appendSlice(state.gpa, default_settings) catch {};
            return myzig.ipc.Result.successRaw(text_buf.items);
        },
        else => return failed(e),
    };
    defer state.gpa.free(content);
    text_buf.clearRetainingCapacity();
    text_buf.appendSlice(state.gpa, content) catch return failed(error.OutOfMemory);
    return myzig.ipc.Result.successRaw(text_buf.items);
}

fn settingsSave(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    const state = stateOf(ctx);
    var a = args;
    const content = a.stringBounded(8 * 1024 * 1024) catch |e| return myzig.ipc.Args.toResult(e);
    if (std.fs.path.dirname(state.settings_path)) |parent|
        std.Io.Dir.cwd().createDirPath(state.io, parent) catch |e| return failed(e);
    std.Io.Dir.cwd().writeFile(state.io, .{ .sub_path = state.settings_path, .data = content }) catch |e| return failed(e);
    return myzig.ipc.Result.success(.null);
}

fn fsRead(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    const state = stateOf(ctx);
    var a = args;
    const path = a.stringBounded(16 * 1024) catch |e| return myzig.ipc.Args.toResult(e);
    const data = std.Io.Dir.cwd().readFileAlloc(state.io, path, state.gpa, .limited(16 * 1024 * 1024)) catch |e| return failed(e);
    defer state.gpa.free(data);
    if (!std.unicode.utf8ValidateSlice(data)) return myzig.ipc.Result.fail(.invalid_argument, "not text");
    text_buf.clearRetainingCapacity();
    text_buf.appendSlice(state.gpa, data) catch return failed(error.OutOfMemory);
    return myzig.ipc.Result.success(.{ .string = text_buf.items });
}

fn fsWrite(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    const state = stateOf(ctx);
    var a = args;
    const path = a.stringBounded(16 * 1024) catch |e| return myzig.ipc.Args.toResult(e);
    const data = a.stringBounded(16 * 1024 * 1024) catch |e| return myzig.ipc.Args.toResult(e);
    std.Io.Dir.cwd().writeFile(state.io, .{ .sub_path = path, .data = data }) catch |e| return failed(e);
    return myzig.ipc.Result.success(.null);
}

fn fieldText(v: myzig.json.Value, key: []const u8) []const u8 {
    const f = v.get(key) orelse return "";
    return switch (f) {
        .string => |s| s,
        else => "",
    };
}
fn fieldNum(v: myzig.json.Value, key: []const u8) f64 {
    const f = v.get(key) orelse return 0;
    return switch (f) {
        .number => |n| std.fmt.parseFloat(f64, n) catch 0,
        else => 0,
    };
}

fn runYtdlp(state: *State, argv: []const []const u8, max: usize) ![]u8 {
    const result = try std.process.run(state.gpa, state.io, .{
        .argv = argv,
        .stdout_limit = .limited(max),
        .stderr_limit = .limited(128 * 1024),
    });
    defer state.gpa.free(result.stderr);
    if (!result.term.success()) {
        state.gpa.free(result.stdout);
        return error.YtdlpFailed;
    }
    return result.stdout;
}

fn simplifyTracks(state: *State, raw: []const u8) ![]u8 {
    var parser = myzig.json.Parser.init(state.gpa, raw);
    defer parser.deinit();
    const root = parser.parse() catch return error.BadJson;
    const entries: []const myzig.json.Value = switch (root) {
        .array => |a| a,
        .object => blk: {
            const e = root.get("entries") orelse return error.BadJson;
            break :blk switch (e) {
                .array => |a| a,
                else => return error.BadJson,
            };
        },
        else => return error.BadJson,
    };
    const j = begin(state.gpa);
    j.raw("[");
    var first = true;
    for (entries) |e| {
        if (e == .null) continue;
        const id = fieldText(e, "id");
        const title = fieldText(e, "title");
        if (title.len == 0) continue;
        const uploader = fieldText(e, "channel");
        const kind = fieldText(e, "_type");
        var thumb: []const u8 = "";
        if (e.get("thumbnails")) |thumbs| {
            if (thumbs == .array and thumbs.array.len > 0) {
                const last = thumbs.array[thumbs.array.len - 1];
                thumb = fieldText(last, "url");
            }
        }
        if (!first) j.raw(",");
        first = false;
        j.raw("{\"id\":");
        j.str(id);
        j.raw(",\"title\":");
        j.str(title);
        j.raw(",\"artist\":");
        j.str(if (uploader.len > 0) uploader else fieldText(e, "uploader"));
        j.raw(",\"duration\":");
        j.num(@as(i64, @intFromFloat(fieldNum(e, "duration"))));
        j.raw(",\"thumb\":");
        j.str(thumb);
        j.raw(",\"url\":");
        j.str(fieldText(e, "webpage_url"));
        j.raw(",\"kind\":");
        j.str(if (kind.len > 0) kind else "video");
        j.raw(",\"live\":");
        j.raw(if (fieldBoolValue(e, "live_status", "is_live")) "true" else "false");
        j.raw("}");
    }
    j.raw("]");
    return state.gpa.dupe(u8, reply.items);
}

fn fieldBoolValue(v: myzig.json.Value, key1: []const u8, key2: []const u8) bool {
    for ([_][]const u8{ key1, key2 }) |k| {
        const f = v.get(k) orelse continue;
        switch (f) {
            .bool => |b| if (b) return true,
            .string => |s| if (std.mem.eql(u8, s, "is_live") or std.mem.eql(u8, s, "true")) return true,
            else => {},
        }
    }
    return false;
}

fn musicSearch(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    const state = stateOf(ctx);
    var a = args;
    const query = a.stringBounded(2048) catch |e| return myzig.ipc.Args.toResult(e);
    const filter = a.stringBounded(32) catch |e| return myzig.ipc.Args.toResult(e);
    _ = filter;
    if (std.mem.trim(u8, query, " \t\r\n").len == 0)
        return myzig.ipc.Result.fail(.invalid_argument, "empty query");
    // yt-dlp's current extractors use ytsearch:N; the old ytmsearch: prefix is
    // no longer recognised. Music results are filtered by the page.
    const prefix: []const u8 = "ytsearch20:";
    const search = std.fmt.allocPrint(state.gpa, "{s}{s}", .{ prefix, query }) catch |e| return failed(e);
    defer state.gpa.free(search);
    const argv = [_][]const u8{ yt_name, "--flat-playlist", "--no-warnings", "--dump-single-json", search };
    const raw = runYtdlp(state, &argv, 16 * 1024 * 1024) catch |e| return failed(e);
    defer state.gpa.free(raw);
    const out = simplifyTracks(state, raw) catch |e| return failed(e);
    defer state.gpa.free(out);
    text_buf.clearRetainingCapacity();
    text_buf.appendSlice(state.gpa, out) catch return failed(error.OutOfMemory);
    return myzig.ipc.Result.successRaw(text_buf.items);
}

fn musicDetails(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    const state = stateOf(ctx);
    var a = args;
    const url = a.stringBounded(8192) catch |e| return myzig.ipc.Args.toResult(e);
    const argv = [_][]const u8{ yt_name, "--no-warnings", "--dump-single-json", url };
    const raw = runYtdlp(state, &argv, 16 * 1024 * 1024) catch |e| return failed(e);
    defer state.gpa.free(raw);
    text_buf.clearRetainingCapacity();
    text_buf.appendSlice(state.gpa, std.mem.trim(u8, raw, " \t\r\n")) catch return failed(error.OutOfMemory);
    return myzig.ipc.Result.successRaw(text_buf.items);
}

// --------------------------------------------------------------------- player

fn playerWorker(state: *State, child: *std.process.Child, gen: u64) void {
    defer state.gpa.destroy(child);
    var buf: [8192]u8 = undefined;
    var reader = child.stdout.?.reader(state.io, &buf);
    while (state.quit.load(.acquire) == false) {
        const line = reader.interface.takeDelimiterExclusive('\n') catch break;
        const clean = std.mem.trim(u8, line, " \t\r");
        if (std.mem.startsWith(u8, clean, "ZIMIKA ")) {
            _ = state.app.emit("player:status", .{ .string = clean[7..] });
        } else if (std.mem.startsWith(u8, clean, "PLAYING ")) {
            _ = state.app.emit("player:playing", .{ .string = clean[8..] });
        }
    }
    const term = child.wait(state.io) catch null;
    state.mutex.lockUncancelable(state.io);
    if (state.player != null and state.player.?.gen == gen) state.player = null;
    state.mutex.unlock(state.io);
    _ = state.app.emit("player:ended", .{ .string = if (term != null and term.?.success()) "ok" else "stopped" });
}

fn playerPlay(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    const state = stateOf(ctx);
    var a = args;
    const url = a.stringBounded(8192) catch |e| return myzig.ipc.Args.toResult(e);
    const title = a.stringBounded(1024) catch |e| return myzig.ipc.Args.toResult(e);
    const volume = a.int(i64, .{ .min = 0, .max = 100 }) catch 80;
    if (url.len == 0) return myzig.ipc.Result.fail(.invalid_argument, "empty url");

    state.mutex.lockUncancelable(state.io);
    if (state.player) |old| old.child.kill(state.io);
    state.player = null;
    const gen = state.next_gen;
    state.next_gen += 1;
    state.mutex.unlock(state.io);

    const vol = std.fmt.allocPrint(state.gpa, "--volume={d}", .{volume}) catch |e| return failed(e);
    defer state.gpa.free(vol);
    const title_arg = std.fmt.allocPrint(state.gpa, "--term-playing-msg=PLAYING {s}", .{title}) catch |e| return failed(e);
    defer state.gpa.free(title_arg);
    const status = "--term-status-msg=ZIMIKA ${time-pos}|${duration}|${pause}|${volume}";
    const selftest = myzig.env.get("ZIMIKA_SELFTEST") != null;
    var argv = std.ArrayListUnmanaged([]const u8).empty;
    defer argv.deinit(state.gpa);
    argv.appendSlice(state.gpa, &.{ mpv_name, "--no-config", "--no-video", "--force-window=no", "--input-terminal=yes", "--really-quiet=no", status, title_arg, vol }) catch |e| return failed(e);
    if (selftest) argv.append(state.gpa, "--ao=null") catch |e| return failed(e);
    argv.append(state.gpa, url) catch |e| return failed(e);

    const child = state.gpa.create(std.process.Child) catch |e| return failed(e);
    child.* = std.process.spawn(state.io, .{
        .argv = argv.items,
        .stdin = .pipe,
        .stdout = .pipe,
        .stderr = .ignore,
        .create_no_window = true,
    }) catch |e| {
        state.gpa.destroy(child);
        return failed(e);
    };

    state.mutex.lockUncancelable(state.io);
    state.player = .{ .child = child, .gen = gen };
    state.mutex.unlock(state.io);

    const thread = std.Thread.spawn(.{}, playerWorker, .{ state, child, gen }) catch |e| {
        child.kill(state.io);
        return failed(e);
    };
    thread.detach();

    const g = std.fmt.allocPrint(state.gpa, "{d}", .{gen}) catch |e| return failed(e);
    defer state.gpa.free(g);
    return replyString(state.gpa, g);
}

fn playerCommand(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    const state = stateOf(ctx);
    var a = args;
    const cmd = a.stringBounded(128) catch |e| return myzig.ipc.Args.toResult(e);
    const value = a.stringBounded(256) catch |e| return myzig.ipc.Args.toResult(e);
    const allowed = [_][]const u8{ "pause", "seek", "volume", "stop", "quit", "af" };
    var ok = false;
    for (allowed) |x| if (std.mem.eql(u8, x, cmd)) {
        ok = true;
        break;
    };
    if (!ok) return myzig.ipc.Result.fail(.invalid_argument, "command not allowed");

    state.mutex.lockUncancelable(state.io);
    const player = state.player;
    state.mutex.unlock(state.io);
    if (player == null) return myzig.ipc.Result.success(.null);
    const line = if (std.mem.eql(u8, cmd, "volume") and value.len > 0)
        std.fmt.allocPrint(state.gpa, "set_property volume {s}\n", .{value}) catch |e| return failed(e)
    else if (std.mem.eql(u8, cmd, "seek") and value.len > 0)
        std.fmt.allocPrint(state.gpa, "seek {s} absolute\n", .{value}) catch |e| return failed(e)
    else if (std.mem.eql(u8, cmd, "af") and value.len > 0)
        std.fmt.allocPrint(state.gpa, "af set {s}\n", .{value}) catch |e| return failed(e)
    else if (value.len > 0)
        std.fmt.allocPrint(state.gpa, "{s} {s}\n", .{ cmd, value }) catch |e| return failed(e)
    else
        std.fmt.allocPrint(state.gpa, "cycle {s}\n", .{cmd}) catch |e| return failed(e);
    defer state.gpa.free(line);
    const file = player.?.child.stdin.?;
    file.writeStreamingAll(state.io, line) catch |e| return failed(e);
    return myzig.ipc.Result.success(.null);
}

fn playerStop(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    _ = args;
    const state = stateOf(ctx);
    state.mutex.lockUncancelable(state.io);
    if (state.player) |p| p.child.kill(state.io);
    state.player = null;
    state.mutex.unlock(state.io);
    return myzig.ipc.Result.success(.null);
}

// --------------------------------------------------------------------- lyrics

fn lyricsGet(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    const state = stateOf(ctx);
    var a = args;
    const artist = a.stringBounded(512) catch |e| return myzig.ipc.Args.toResult(e);
    const title = a.stringBounded(512) catch |e| return myzig.ipc.Args.toResult(e);
    if (artist.len == 0 or title.len == 0) return myzig.ipc.Result.fail(.invalid_argument, "missing metadata");
    const argv = [_][]const u8{
        curl_name,          "-sS",                                                                                  "--max-time",       "8",                                                                                  "-G",
        "--data-urlencode", std.fmt.allocPrint(state.gpa, "artist_name={s}", .{artist}) catch |e| return failed(e), "--data-urlencode", std.fmt.allocPrint(state.gpa, "track_name={s}", .{title}) catch |e| return failed(e), "https://lrclib.net/api/get",
    };
    const result = std.process.run(state.gpa, state.io, .{
        .argv = &argv,
        .stdout_limit = .limited(2 * 1024 * 1024),
        .stderr_limit = .limited(64 * 1024),
    }) catch |e| return failed(e);
    defer state.gpa.free(result.stdout);
    defer state.gpa.free(result.stderr);
    if (!result.term.success() or result.stdout.len < 2) return myzig.ipc.Result.successRaw("{\"plain\":\"\",\"synced\":\"\"}");
    var parser = myzig.json.Parser.init(state.gpa, result.stdout);
    defer parser.deinit();
    const root = parser.parse() catch return myzig.ipc.Result.successRaw("{\"plain\":\"\",\"synced\":\"\"}");
    const j = begin(state.gpa);
    j.raw("{\"plain\":");
    j.str(fieldText(root, "plainLyrics"));
    j.raw(",\"synced\":");
    j.str(fieldText(root, "syncedLyrics"));
    j.raw("}");
    return myzig.ipc.Result.successRaw(reply.items);
}

// --------------------------------------------------------------------- cache

fn cacheSave(ctx: ?*anyopaque, args: myzig.ipc.Args) myzig.ipc.Result {
    const state = stateOf(ctx);
    var a = args;
    const url = a.stringBounded(8192) catch |e| return myzig.ipc.Args.toResult(e);
    const name = a.stringBounded(512) catch |e| return myzig.ipc.Args.toResult(e);
    const out = std.fmt.allocPrint(state.gpa, "{s}/%(title)s.%(ext)s", .{state.cache_dir}) catch |e| return failed(e);
    defer state.gpa.free(out);
    const argv = [_][]const u8{ yt_name, "-x", "--audio-format", "mp3", "-o", out, url };
    const result = std.process.run(state.gpa, state.io, .{
        .argv = &argv,
        .stdout_limit = .limited(1024),
        .stderr_limit = .limited(4096),
    }) catch |e| return failed(e);
    defer state.gpa.free(result.stdout);
    defer state.gpa.free(result.stderr);
    _ = name;
    return myzig.ipc.Result.success(.{ .bool = result.term.success() });
}

// ---------------------------------------------------------------------- loops

fn onBeforeQuit(ev: *myzig.App.QuitEvent, ctx: ?*anyopaque) void {
    _ = ev;
    const state = stateOf(ctx);
    state.quit.store(true, .release);
    state.mutex.lockUncancelable(state.io);
    if (state.player) |p| p.child.kill(state.io);
    state.player = null;
    state.mutex.unlock(state.io);
}

fn onPageReady(state: *State, window: u32, payload: myzig.json.Value) void {
    _ = window;
    _ = payload;
    if (state.window) |w| state.app.showWindow(w, true);
}

pub fn main(init: std.process.Init) !void {
    var gpa_state = std.heap.DebugAllocator(.{}){};
    defer _ = gpa_state.deinit();
    const gpa = gpa_state.allocator();
    const io = init.io;
    const data = try dataDir(gpa);
    defer gpa.free(data);
    const settings = try configPath(gpa);
    defer gpa.free(settings);
    const cache = try std.fs.path.join(gpa, &.{ data, "cache" });
    defer gpa.free(cache);
    try std.Io.Dir.cwd().createDirPath(io, cache);

    var app = try myzig.App.init(gpa, .{
        .name = "Zimika",
        .app_id = "dev.myzig.zimika",
        .frontend = &frontend,
        .io = io,
        .single_instance = true,
    });
    defer app.deinit();

    var state = State{
        .app = &app,
        .gpa = gpa,
        .io = io,
        .settings_path = settings,
        .data_dir = data,
        .cache_dir = cache,
    };

    try app.bind(.{ .name = "App.status", .invoke = appStatus, .ctx = &state, .arity = 0 });
    try app.bind(.{ .name = "Settings.load", .invoke = settingsLoad, .ctx = &state, .arity = 0 });
    try app.bind(.{ .name = "Settings.save", .invoke = settingsSave, .ctx = &state, .arity = 1 });
    try app.bind(.{ .name = "Fs.read", .invoke = fsRead, .ctx = &state, .arity = 1 });
    try app.bind(.{ .name = "Fs.write", .invoke = fsWrite, .ctx = &state, .arity = 2 });
    try app.bind(.{ .name = "Music.search", .invoke = musicSearch, .ctx = &state, .arity = 2 });
    try app.bind(.{ .name = "Music.details", .invoke = musicDetails, .ctx = &state, .arity = 1 });
    try app.bind(.{ .name = "Player.play", .invoke = playerPlay, .ctx = &state, .arity = 3 });
    try app.bind(.{ .name = "Player.command", .invoke = playerCommand, .ctx = &state, .arity = 2 });
    try app.bind(.{ .name = "Player.stop", .invoke = playerStop, .ctx = &state, .arity = 0 });
    try app.bind(.{ .name = "Lyrics.get", .invoke = lyricsGet, .ctx = &state, .arity = 2 });
    try app.bind(.{ .name = "Cache.save", .invoke = cacheSave, .ctx = &state, .arity = 2 });

    try app.onBeforeQuit(onBeforeQuit, &state);
    try app.onPageEvent(State, "zimika:ready", &state, onPageReady);

    const url: []const u8 = if (myzig.env.get("ZIMIKA_SELFTEST") != null)
        "myzig://app/index.html?selftest=1"
    else
        "";

    state.window = try app.createWindow(.{
        .title = "Zimika — Music",
        .width = 1280,
        .height = 820,
        .state_key = "zimika-main",
        .url = url,
        .hidden = false,
        .background = 0x141415ff,
    });
    state.ready = true;
    try app.run();
}

test "frontend is embedded" {
    try std.testing.expectEqual(@as(usize, 3), frontend.len);
    for (frontend) |f| try std.testing.expect(f.data.len > 0);
}
