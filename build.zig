const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const myzig = b.dependency("myzig", .{ .target = target, .optimize = optimize });

    const exe = b.addExecutable(.{
        .name = "zimika",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    exe.root_module.addImport("myzig", myzig.module("myzig"));
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    b.step("run", "Run Zimika").dependOn(&run.step);

    const unit = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    unit.root_module.addImport("myzig", myzig.module("myzig"));
    b.step("test", "Run unit tests").dependOn(&b.addRunArtifact(unit).step);
}
