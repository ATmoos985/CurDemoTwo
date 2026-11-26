package com.example.cutdemotwo.algorithm.geometry;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;

/**
 * 统一坐标系与工艺基准变换。
 * 收拢 {@code startCorner}（左/右、上/下）镜像与 {@code trimStart} 卷头修齐的双向映射，
 * 供原生直刀、纯 Java 直刀与横切引擎共用。
 */
public final class CoordinateFrame {
    private final double width;
    private final double height;
    private final double trimStart;
    private final double activeLength;
    private final boolean rightOrigin;
    private final boolean bottomOrigin;
    private final boolean sheet;
    private final boolean mirrorY;

    private CoordinateFrame(double width, double height, double trimStart, String startCorner, boolean sheet) {
        this.width = width;
        this.height = height;
        this.trimStart = Math.max(0.0, trimStart);
        this.activeLength = height - this.trimStart;
        String origin = EngineGeometry.normalizeStartCorner(startCorner);
        this.rightOrigin = origin.startsWith("right");
        this.bottomOrigin = origin.endsWith("bottom");
        this.sheet = sheet;
        // 连续送料沿 Y 正方向排料；整块材料（SHEET）允许按底部起刀基准镜像排列。
        this.mirrorY = sheet && bottomOrigin;
    }

    public static CoordinateFrame of(NestingProblem problem) {
        return new CoordinateFrame(
                problem.width(),
                problem.height(),
                problem.process().trimStart(),
                problem.process().startCorner(),
                problem.sheet()
        );
    }

    public static CoordinateFrame of(double width, double height, double trimStart, String startCorner, boolean sheet) {
        return new CoordinateFrame(width, height, trimStart, startCorner, sheet);
    }

    public double width() { return width; }
    public double height() { return height; }
    public double trimStart() { return trimStart; }
    public double activeLength() { return activeLength; }
    public boolean isRightOrigin() { return rightOrigin; }
    public boolean isBottomOrigin() { return bottomOrigin; }
    public boolean isSheet() { return sheet; }
    public boolean isMirrorY() { return mirrorY; }

    /** 物理坐标矩形左上角 X -> 求解器局部坐标 X。 */
    public double toLocalX(double physicalX, double rectWidth) {
        return rightOrigin ? (width - physicalX - rectWidth) : physicalX;
    }

    /** 物理坐标矩形左上角 Y -> 求解器局部坐标 Y（相对有效加工区 [0, activeLength]）。 */
    public double toLocalY(double physicalY, double rectHeight) {
        return mirrorY ? (height - physicalY - rectHeight - trimStart) : (physicalY - trimStart);
    }

    /** 求解器局部坐标矩形左上角 X -> 物理坐标 X（含零点舍入归一）。 */
    public double toPhysicalX(double localX, double rectWidth) {
        return EngineGeometry.normalizeZero(rightOrigin ? (width - localX - rectWidth) : localX);
    }

    /** 求解器局部坐标矩形左上角 Y -> 物理坐标 Y（含零点舍入归一）。 */
    public double toPhysicalY(double localY, double rectHeight) {
        return EngineGeometry.normalizeZero(mirrorY ? (height - localY - rectHeight - trimStart) : (localY + trimStart));
    }

    /** 求解器局部横切线 Y -> 物理横切线 Y。 */
    public double toPhysicalHorizontalCutY(double localY) {
        return mirrorY ? (height - localY - trimStart) : (localY + trimStart);
    }

    /** 求解器局部纵切线 X -> 物理纵切线 X。 */
    public double toPhysicalVerticalCutX(double localX) {
        return rightOrigin ? (width - localX) : localX;
    }

    /** 求解器局部 X 区间 [localStart, localEnd] -> 物理有序区间 [min, max]。 */
    public double[] toPhysicalXSpan(double localStart, double localEnd) {
        double a = rightOrigin ? (width - localEnd) : localStart;
        double b = rightOrigin ? (width - localStart) : localEnd;
        return new double[]{Math.min(a, b), Math.max(a, b)};
    }

    /** 求解器局部 Y 区间 [localStart, localEnd] -> 物理有序区间 [min, max]。 */
    public double[] toPhysicalYSpan(double localStart, double localEnd) {
        double a = mirrorY ? (height - localEnd - trimStart) : (localStart + trimStart);
        double b = mirrorY ? (height - localStart - trimStart) : (localEnd + trimStart);
        return new double[]{Math.min(a, b), Math.max(a, b)};
    }

    /** 卷头修齐料头在物理坐标系中的 Y 起点。 */
    public double trimRemnantY() {
        return mirrorY ? (height - trimStart) : 0.0;
    }

    /** 第 0 阶段卷头修齐横切线在物理坐标系中的 Y 位置。 */
    public double trimCutY() {
        return mirrorY ? (height - trimStart) : trimStart;
    }

    /** 刀路回零 X 坐标。 */
    public double homeX() {
        return rightOrigin ? width : 0.0;
    }

    /** 刀路回零 Y 坐标。 */
    public double homeY() {
        return bottomOrigin ? height : 0.0;
    }
}
