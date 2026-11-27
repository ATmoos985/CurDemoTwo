package com.example.cutdemotwo.business.exports;

import com.example.cutdemotwo.algorithm.api.ToolpathOptimizer;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.exports.CamSchemeGeometryAdapter.CamContext;
import com.example.cutdemotwo.business.exports.CamSchemeGeometryAdapter.PieceGeometry;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan;
import com.example.cutdemotwo.contracts.geometry.ContourToolpathPlan.ContourLoop;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;

import java.awt.geom.Line2D;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;

/**
 * 生产级 CNC G-Code (.nc) 导出渲染器：
 * <ul>
 *   <li>复用 {@link ToolpathOptimizer} 实现先内孔后外轮廓、小件优先、引入线、微连接与共边去重；</li>
 *   <li>支持 {@code overcutMm} 切线延长过切补偿（严格夹在工位范围内）；</li>
 *   <li>支持多刀头切换（{@code M06} + {@code cutTool}/{@code punchTool}/{@code creaseTool}）；</li>
 *   <li>支持多顶点圆形/圆弧轮廓自动拟合输出 {@code G02}/{@code G03}（{@code I}/{@code J} 增量圆心）与常规直线 {@code G01}。</li>
 * </ul>
 */
final class GCodeExportRenderer {
    private static final double CUT_FEED = 4000.0;
    private static final double RAPID_FEED = 15000.0;
    private static final double SMALL_PUNCH_AREA_MM2 = 900.0;
    private static final double CIRCLE_FIT_TOLERANCE_MM = 0.05;

    private final ToolpathOptimizer toolpathOptimizer;

    GCodeExportRenderer(ToolpathOptimizer toolpathOptimizer) {
        this.toolpathOptimizer = Objects.requireNonNull(toolpathOptimizer, "toolpathOptimizer");
    }

    String render(CamContext ctx, CamExportOptions options) {
        CamExportOptions opt = options == null ? CamExportOptions.defaults() : options;
        StringBuilder sb = new StringBuilder(16384);
        writeHeader(sb, ctx, opt);

        ToolState toolState = new ToolState();
        double lastX = ctx.homeX();
        double lastY = ctx.homeY();
        double totalCutDist = 0.0;
        double totalAirDist = 0.0;

        if (!ctx.cutSteps().isEmpty()) {
            List<CutStep> steps = opt.deduplicateCommonEdges()
                    ? toolpathOptimizer.deduplicateCommonEdges(ctx.cutSteps(), 0.05)
                    : ctx.cutSteps();
            steps = toolpathOptimizer.optimizeAndChain(steps, ctx.homeX(), ctx.homeY(), true);
            ensureTool(sb, toolState, opt.cutTool(), "Main Straight Cut");
            for (CutStep step : steps) {
                double sx = step.getStartX() != null ? step.getStartX() : 0.0;
                double sy = step.getStartY() != null ? step.getStartY() : 0.0;
                double ex = step.getEndX() != null ? step.getEndX() : 0.0;
                double ey = step.getEndY() != null ? step.getEndY() : 0.0;
                if (opt.overcutMm() > 1e-6) {
                    double[] extended = extendSegmentWithOvercut(sx, sy, ex, ey, opt.overcutMm(), ctx.widthMm(), ctx.bedLengthMm());
                    sx = extended[0];
                    sy = extended[1];
                    ex = extended[2];
                    ey = extended[3];
                }
                totalAirDist += Math.hypot(sx - lastX, sy - lastY);
                totalCutDist += Math.hypot(ex - sx, ey - sy);
                sb.append(String.format(Locale.ROOT, "(--- STEP %d: %s ---)%n", step.getStep(), CamSchemeGeometryAdapter.sanitizeDxfText(step.getType())));
                sb.append(String.format(Locale.ROOT, "G00 X%.3f Y%.3f Z10.000%n", sx, sy));
                sb.append("M03 S1\nG04 P200\n");
                sb.append(String.format(Locale.ROOT, "G01 X%.3f Y%.3f Z0.000 F%.0f%n", ex, ey, CUT_FEED));
                sb.append("M05\nG04 P100\n\n");
                lastX = ex;
                lastY = ey;
            }
        } else if (!ctx.placements().isEmpty()) {
            ContourToolpathPlan plan = toolpathOptimizer.optimizeContourToolpath(
                    ctx.placements(),
                    new ContourToolpathPlan.Options(
                            ctx.homeX(), ctx.homeY(),
                            opt.leadInMm(), opt.microJointWidthMm(),
                            true, opt.deduplicateCommonEdges(), 0.05
                    )
            );
            RenderCursor cursor = new RenderCursor(lastX, lastY, totalCutDist, totalAirDist);
            if (opt.deduplicateCommonEdges()) {
                // 1. 几何识别与工艺语义解耦：内孔与纯圆外轮廓一律走独立工艺通道，仅非圆外轮廓进共边去重
                List<ContourLoop> outerNonCircleLoops = new ArrayList<>();
                for (ContourLoop loop : plan.loops()) {
                    if (loop.pathPoints().size() < 3) continue;
                    CircleFit circle = fitCircle(loop.pathPoints());
                    if (loop.hole() || circle != null) {
                        renderContourLoop(sb, ctx, opt, toolState, cursor, loop, circle);
                    } else {
                        outerNonCircleLoops.add(loop);
                    }
                }
                // 2. 非圆外轮廓切割边经共边去重与最短空程串联后输出（含废料区安全引入线与开放链防碰撞过切）
                List<CutStep> outerRawSteps = buildOuterCutSteps(outerNonCircleLoops);
                if (!outerRawSteps.isEmpty()) {
                    List<CutStep> deduped = toolpathOptimizer.deduplicateCommonEdges(outerRawSteps, 0.05);
                    List<CutStep> chained = toolpathOptimizer.optimizeAndChain(deduped, cursor.x, cursor.y, false);
                    renderChainedOuterSteps(sb, ctx, opt, toolState, cursor, chained);
                }
            } else {
                for (ContourLoop loop : plan.loops()) {
                    if (loop.pathPoints().size() < 3) continue;
                    renderContourLoop(sb, ctx, opt, toolState, cursor, loop, fitCircle(loop.pathPoints()));
                }
            }
            lastX = cursor.x;
            lastY = cursor.y;
            totalCutDist = cursor.cutDist;
            totalAirDist = cursor.airDist;
        }

        sb.append("(--- RETURN TO HOME AND FINISH ---)\n");
        sb.append(String.format(Locale.ROOT, "G00 X%.3f Y%.3f Z50.000 F%.0f%n", ctx.homeX(), ctx.homeY(), RAPID_FEED));
        sb.append("M09\nM30\n");
        sb.append(String.format(Locale.ROOT, "(TOTAL CUT DISTANCE: %.1f mm | TOTAL AIR DISTANCE: %.1f mm)%n", totalCutDist, totalAirDist));
        return sb.toString();
    }

    private void writeHeader(StringBuilder sb, CamContext ctx, CamExportOptions opt) {
        sb.append("(------------------------------------------------------------------)\n");
        sb.append("( CAD/CAM FABRIC CUTTING PROGRAM - CNC G-CODE                      )\n");
        sb.append(String.format(Locale.ROOT, "( SCHEME ID     : %s )%n", CamSchemeGeometryAdapter.sanitizeDxfText(ctx.scheme().id())));
        sb.append(String.format(Locale.ROOT, "( BED STATION   : %.1f x %.1f mm (Global Y Start: %.1f mm) )%n",
                ctx.widthMm(), ctx.bedLengthMm(), ctx.windowStartY()));
        sb.append(String.format(Locale.ROOT, "( OPTIONS       : overcut=%.2fmm leadIn=%.2fmm microJoint=%.2fmm dedup=%s )%n",
                opt.overcutMm(), opt.leadInMm(), opt.microJointWidthMm(), opt.deduplicateCommonEdges()));
        sb.append(String.format(Locale.ROOT, "( TOOLS         : CUT=%s PUNCH=%s CREASE=%s )%n",
                opt.cutTool(), opt.punchTool(), opt.creaseTool()));
        sb.append("(------------------------------------------------------------------)\n\n");
        sb.append("G21\nG90\nG17\nG94\nM08\nG04 P500\n");
        sb.append(String.format(Locale.ROOT, "G00 X%.3f Y%.3f Z50.000 F%.0f%n%n", ctx.homeX(), ctx.homeY(), RAPID_FEED));
    }

    private static final class ToolState {
        String currentTool = "";
    }

    private static void ensureTool(StringBuilder sb, ToolState state, String targetTool, String comment) {
        if (!targetTool.equals(state.currentTool)) {
            sb.append("M06 ").append(targetTool).append(" (Tool Change: ").append(comment).append(")\n");
            state.currentTool = targetTool;
        }
    }

    private static final class RenderCursor {
        double x;
        double y;
        double cutDist;
        double airDist;

        RenderCursor(double x, double y, double cutDist, double airDist) {
            this.x = x;
            this.y = y;
            this.cutDist = cutDist;
            this.airDist = airDist;
        }
    }

    private void renderContourLoop(
            StringBuilder sb, CamContext ctx, CamExportOptions opt,
            ToolState toolState, RenderCursor cursor, ContourLoop loop, CircleFit circle
    ) {
        List<Point> pts = loop.pathPoints();
        // 内孔切下的是废料，强制免除微连接以免挂刀；外轮廓保留成品防飞料微连接
        double effectiveJoint = loop.hole() ? 0.0 : loop.microJointWidthMm();
        String desiredTool = (loop.hole() && loop.areaMm2() <= SMALL_PUNCH_AREA_MM2) ? opt.punchTool() : opt.cutTool();
        ensureTool(sb, toolState, desiredTool, loop.hole() ? "Inner Hole" : "Outer Contour");

        String kindTag = loop.hole() ? ("INNER HOLE #" + (loop.holeIndex() + 1)) : "OUTER CONTOUR";
        sb.append(String.format(Locale.ROOT, "(--- CONTOUR %d: %s [%s] ---)%n",
                loop.sequence(), CamSchemeGeometryAdapter.sanitizeDxfText(loop.partName()), kindTag));

        double entryX = pts.get(0).x(), entryY = pts.get(0).y();
        Point safePierce = computeSafeContourLeadIn(loop, entryX, entryY, ctx);
        double pierceX = safePierce != null ? safePierce.x() : entryX;
        double pierceY = safePierce != null ? safePierce.y() : entryY;
        boolean emitLeadIn = safePierce != null;

        cursor.airDist += Math.hypot(pierceX - cursor.x, pierceY - cursor.y);
        sb.append(String.format(Locale.ROOT, "G00 X%.3f Y%.3f Z10.000%nM03 S1%nG04 P200%n", pierceX, pierceY));

        double curX = pierceX, curY = pierceY;
        if (emitLeadIn) {
            cursor.cutDist += Math.hypot(entryX - curX, entryY - curY);
            sb.append(String.format(Locale.ROOT, "G01 X%.3f Y%.3f Z0.000 F%.0f (Lead-In)%n", entryX, entryY, CUT_FEED));
            curX = entryX;
            curY = entryY;
        }

        if (circle != null) {
            Point startPt = pts.get(0);
            if (Math.hypot(startPt.x() - curX, startPt.y() - curY) > 1e-3) {
                cursor.cutDist += Math.hypot(startPt.x() - curX, startPt.y() - curY);
                sb.append(String.format(Locale.ROOT, "G01 X%.3f Y%.3f Z0.000 F%.0f%n", startPt.x(), startPt.y(), CUT_FEED));
            }
            double iOff = circle.cx() - startPt.x(), jOff = circle.cy() - startPt.y();
            double r0 = Math.hypot(iOff, jOff);
            double startAngle = Math.atan2(startPt.y() - circle.cy(), startPt.x() - circle.cx());
            double circumference = 2.0 * Math.PI * r0;
            String gCmd = circle.ccw() ? "G03" : "G02";
            if (effectiveJoint > 1e-4 && r0 > 1e-6) {
                double actualJoint = Math.min(effectiveJoint, 0.45 * circumference);
                double endAngle = circle.ccw() ? (startAngle - actualJoint / r0) : (startAngle + actualJoint / r0);
                double endX = circle.cx() + r0 * Math.cos(endAngle), endY = circle.cy() + r0 * Math.sin(endAngle);
                sb.append(String.format(Locale.ROOT, "%s X%.3f Y%.3f I%.3f J%.3f Z0.000 F%.0f (Circular Contour R=%.2f, Micro-Joint %.2fmm)%n",
                        gCmd, endX, endY, iOff, jOff, CUT_FEED, r0, actualJoint));
                cursor.cutDist += circumference - actualJoint;
                curX = endX;
                curY = endY;
            } else {
                sb.append(String.format(Locale.ROOT, "%s X%.3f Y%.3f I%.3f J%.3f Z0.000 F%.0f (Circular Contour R=%.2f)%n",
                        gCmd, startPt.x(), startPt.y(), iOff, jOff, CUT_FEED, r0));
                cursor.cutDist += circumference;
                curX = startPt.x();
                curY = startPt.y();
                if (opt.overcutMm() > 1e-6 && r0 > 1e-6) {
                    double safeOvercut = clampCircularOvercutToBounds(circle.cx(), circle.cy(), r0, startAngle, circle.ccw(),
                            Math.min(opt.overcutMm(), 0.25 * circumference), ctx.widthMm(), ctx.bedLengthMm());
                    if (safeOvercut > 1e-6) {
                        double overAngle = circle.ccw() ? (startAngle + safeOvercut / r0) : (startAngle - safeOvercut / r0);
                        double ox = circle.cx() + r0 * Math.cos(overAngle), oy = circle.cy() + r0 * Math.sin(overAngle);
                        sb.append(String.format(Locale.ROOT, "%s X%.3f Y%.3f I%.3f J%.3f Z0.000 F%.0f (Overcut %.2fmm)%n",
                                gCmd, ox, oy, iOff, jOff, CUT_FEED, safeOvercut));
                        cursor.cutDist += safeOvercut;
                        curX = ox;
                        curY = oy;
                    }
                }
            }
        } else {
            int n = pts.size();
            for (int i = 0; i < n; i++) {
                Point a = pts.get(i), b = pts.get((i + 1) % n);
                double edgeLen = Math.hypot(b.x() - a.x(), b.y() - a.y());
                if (edgeLen <= 1e-6) continue;
                double ex = b.x(), ey = b.y();
                if (i == n - 1 && effectiveJoint > 1e-4) {
                    double ratio = Math.max(0.0, (edgeLen - effectiveJoint) / edgeLen);
                    ex = a.x() + (b.x() - a.x()) * ratio;
                    ey = a.y() + (b.y() - a.y()) * ratio;
                }
                cursor.cutDist += Math.hypot(ex - curX, ey - curY);
                sb.append(String.format(Locale.ROOT, "G01 X%.3f Y%.3f Z0.000 F%.0f%n", ex, ey, CUT_FEED));
                curX = ex;
                curY = ey;
            }
            if (effectiveJoint <= 1e-4 && opt.overcutMm() > 1e-6 && pts.size() >= 2) {
                Point p0 = pts.get(0), p1 = pts.get(1);
                double firstEdgeLen = Math.hypot(p1.x() - p0.x(), p1.y() - p0.y());
                if (firstEdgeLen > 1e-6) {
                    double ux = (p1.x() - p0.x()) / firstEdgeLen, uy = (p1.y() - p0.y()) / firstEdgeLen;
                    double tMax = clampRayToBounds(p0.x(), p0.y(), ux, uy, Math.min(opt.overcutMm(), firstEdgeLen), ctx.widthMm(), ctx.bedLengthMm());
                    if (tMax > 1e-6) {
                        double ox = p0.x() + ux * tMax, oy = p0.y() + uy * tMax;
                        cursor.cutDist += Math.hypot(ox - curX, oy - curY);
                        sb.append(String.format(Locale.ROOT, "G01 X%.3f Y%.3f Z0.000 F%.0f (Overcut %.2fmm)%n", ox, oy, CUT_FEED, tMax));
                        curX = ox;
                        curY = oy;
                    }
                }
            }
        }

        sb.append("M05\nG04 P100\n\n");
        cursor.x = curX;
        cursor.y = curY;
    }

    private static List<CutStep> buildOuterCutSteps(List<ContourLoop> outerLoops) {
        List<CutStep> steps = new ArrayList<>();
        int seq = 1;
        for (ContourLoop loop : outerLoops) {
            List<Point> pts = loop.pathPoints();
            int n = pts.size();
            for (int i = 0; i < n; i++) {
                Point a = pts.get(i), b = pts.get((i + 1) % n);
                double edgeLen = Math.hypot(b.x() - a.x(), b.y() - a.y());
                if (edgeLen <= 1e-6) continue;
                double ex = b.x(), ey = b.y();
                if (i == n - 1 && loop.microJointWidthMm() > 1e-4) {
                    double ratio = Math.max(0.0, (edgeLen - loop.microJointWidthMm()) / edgeLen);
                    ex = a.x() + (b.x() - a.x()) * ratio;
                    ey = a.y() + (b.y() - a.y()) * ratio;
                }
                double segLen = Math.hypot(ex - a.x(), ey - a.y());
                if (segLen <= 1e-6) continue;
                CutStep step = new CutStep();
                step.setStep(seq++);
                step.setType("轮廓切");
                step.setPos(0.0);
                step.setStart(0.0);
                step.setEnd(segLen);
                step.setStartX(a.x());
                step.setStartY(a.y());
                step.setEndX(ex);
                step.setEndY(ey);
                step.setStage(Math.max(1, loop.sequence()));
                step.setDesc(CamSchemeGeometryAdapter.sanitizeDxfText(loop.partName()));
                steps.add(step);
            }
        }
        return steps;
    }

    private void renderChainedOuterSteps(
            StringBuilder sb, CamContext ctx, CamExportOptions opt,
            ToolState toolState, RenderCursor cursor, List<CutStep> chained
    ) {
        if (chained.isEmpty()) return;
        ensureTool(sb, toolState, opt.cutTool(), "Deduplicated Outer Contour Cut");
        List<List<CutStep>> chains = new ArrayList<>();
        List<CutStep> currentChain = null;
        double prevEndX = Double.NaN, prevEndY = Double.NaN;
        for (CutStep step : chained) {
            double sx = step.getStartX() != null ? step.getStartX() : 0.0;
            double sy = step.getStartY() != null ? step.getStartY() : 0.0;
            if (currentChain == null || Math.hypot(sx - prevEndX, sy - prevEndY) > 0.01) {
                currentChain = new ArrayList<>();
                chains.add(currentChain);
            }
            currentChain.add(step);
            prevEndX = step.getEndX() != null ? step.getEndX() : 0.0;
            prevEndY = step.getEndY() != null ? step.getEndY() : 0.0;
        }

        for (List<CutStep> chain : chains) {
            CutStep first = chain.get(0);
            double fx = first.getStartX() != null ? first.getStartX() : 0.0;
            double fy = first.getStartY() != null ? first.getStartY() : 0.0;
            Point safePierce = (opt.leadInMm() > 1e-4) ? computeSafeChainLeadIn(first, fx, fy, opt.leadInMm(), ctx) : null;
            double startX = safePierce != null ? safePierce.x() : fx;
            double startY = safePierce != null ? safePierce.y() : fy;
            cursor.airDist += Math.hypot(startX - cursor.x, startY - cursor.y);
            sb.append(String.format(Locale.ROOT, "G00 X%.3f Y%.3f Z10.000%nM03 S1%nG04 P200%n", startX, startY));

            double curX = startX, curY = startY;
            if (safePierce != null) {
                cursor.cutDist += Math.hypot(fx - curX, fy - curY);
                sb.append(String.format(Locale.ROOT, "G01 X%.3f Y%.3f Z0.000 F%.0f (Lead-In)%n", fx, fy, CUT_FEED));
                curX = fx;
                curY = fy;
            }
            for (CutStep step : chain) {
                double ex = step.getEndX() != null ? step.getEndX() : 0.0;
                double ey = step.getEndY() != null ? step.getEndY() : 0.0;
                cursor.cutDist += Math.hypot(ex - curX, ey - curY);
                sb.append(String.format(Locale.ROOT, "G01 X%.3f Y%.3f Z0.000 F%.0f%n", ex, ey, CUT_FEED));
                curX = ex;
                curY = ey;
            }

            if (opt.microJointWidthMm() <= 1e-4 && opt.overcutMm() > 1e-6) {
                boolean closedLoop = Math.hypot(curX - fx, curY - fy) <= 0.01;
                CutStep ref = closedLoop ? first : chain.get(chain.size() - 1);
                double rsx = ref.getStartX() != null ? ref.getStartX() : 0.0, rsy = ref.getStartY() != null ? ref.getStartY() : 0.0;
                double rex = ref.getEndX() != null ? ref.getEndX() : 0.0, rey = ref.getEndY() != null ? ref.getEndY() : 0.0;
                double segLen = Math.hypot(rex - rsx, rey - rsy);
                if (segLen > 1e-6) {
                    double ux = (rex - rsx) / segLen, uy = (rey - rsy) / segLen;
                    double tMax = clampRayToBounds(curX, curY, ux, uy, Math.min(opt.overcutMm(), segLen), ctx.widthMm(), ctx.bedLengthMm());
                    if (!closedLoop && tMax > 1e-6) tMax = clampRayAgainstPieces(curX, curY, ux, uy, tMax, ctx.pieces());
                    if (tMax > 1e-6) {
                        double ox = curX + ux * tMax, oy = curY + uy * tMax;
                        cursor.cutDist += Math.hypot(ox - curX, oy - curY);
                        sb.append(String.format(Locale.ROOT, "G01 X%.3f Y%.3f Z0.000 F%.0f (Overcut %.2fmm)%n", ox, oy, CUT_FEED, tMax));
                        curX = ox;
                        curY = oy;
                    }
                }
            }
            sb.append("M05\nG04 P100\n\n");
            cursor.x = curX;
            cursor.y = curY;
        }
    }

    private static double clampCircularOvercutToBounds(
            double cx, double cy, double r0, double startAngle, boolean ccw, double requestedOvercut, double maxW, double maxL
    ) {
        double lo = 0.0, hi = requestedOvercut;
        for (int iter = 0; iter < 17; iter++) {
            double tryLen = (iter == 0) ? hi : 0.5 * (lo + hi);
            double delta = tryLen / Math.max(r0, 1e-6);
            double midAng = ccw ? (startAngle + 0.5 * delta) : (startAngle - 0.5 * delta);
            double endAng = ccw ? (startAngle + delta) : (startAngle - delta);
            double mx = cx + r0 * Math.cos(midAng), my = cy + r0 * Math.sin(midAng);
            double ex = cx + r0 * Math.cos(endAng), ey = cy + r0 * Math.sin(endAng);
            boolean ok = mx >= -1e-6 && mx <= maxW + 1e-6 && my >= -1e-6 && my <= maxL + 1e-6
                    && ex >= -1e-6 && ex <= maxW + 1e-6 && ey >= -1e-6 && ey <= maxL + 1e-6;
            if (iter == 0 && ok) return hi;
            if (ok) lo = tryLen; else hi = tryLen;
        }
        return lo > 0.05 ? lo : 0.0;
    }

    private static Point computeSafeContourLeadIn(ContourLoop loop, double entryX, double entryY, CamContext ctx) {
        if (loop.leadInMm() <= 1e-4 || loop.pathPoints().size() < 3) return null;
        List<Point> pts = loop.pathPoints();
        int n = pts.size();
        double ldx = loop.pierceX() - entryX, ldy = loop.pierceY() - entryY, primaryReq = Math.hypot(ldx, ldy);
        List<double[]> candidates = new ArrayList<>(9);
        if (primaryReq > 1e-4) candidates.add(new double[]{ldx / primaryReq, ldy / primaryReq, primaryReq});
        double v1x = pts.get(n - 1).x() - entryX, v1y = pts.get(n - 1).y() - entryY, l1 = Math.hypot(v1x, v1y);
        double v2x = pts.get(1).x() - entryX, v2y = pts.get(1).y() - entryY, l2 = Math.hypot(v2x, v2y);
        if (l1 > 1e-6 && l2 > 1e-6) {
            v1x /= l1; v1y /= l1; v2x /= l2; v2y /= l2;
            double req = primaryReq > 1e-4 ? primaryReq : loop.leadInMm();
            if (loop.hole() && primaryReq > 1e-4) {
                double ux = ldx / primaryReq, uy = ldy / primaryReq;
                for (double deg : new double[]{30.0, -30.0, 45.0, -45.0}) {
                    double rad = Math.toRadians(deg), c = Math.cos(rad), s = Math.sin(rad);
                    candidates.add(new double[]{ux * c - uy * s, ux * s + uy * c, req});
                }
            } else if (!loop.hole()) {
                double s2 = 1.0 / Math.sqrt(2.0);
                for (double[] d : new double[][]{{-v2y, v2x}, {v2y, -v2x}, {-v1y, v1x}, {v1y, -v1x},
                        {-v2x, -v2y}, {-v1x, -v1y}, {(-v2x - v2y) * s2, (-v2y + v2x) * s2}, {(-v2x + v2y) * s2, (-v2y - v2x) * s2}}) {
                    candidates.add(new double[]{d[0], d[1], req});
                }
            }
        }
        return findSafeLeadRay(entryX, entryY, candidates, pts, loop.hole(), null, ctx);
    }

    private static Point computeSafeChainLeadIn(CutStep first, double fx, double fy, double requestedLeadIn, CamContext ctx) {
        double fex = first.getEndX() != null ? first.getEndX() : fx;
        double fey = first.getEndY() != null ? first.getEndY() : fy;
        double segLen = Math.hypot(fex - fx, fey - fy);
        if (segLen <= 1e-6 || requestedLeadIn < 0.2 - 1e-6) return null;
        Set<List<Point>> ownOuterRings = resolveOwnOuterRingsForChainStart(fx, fy, fex, fey, ctx.pieces());
        double tx = (fex - fx) / segLen, ty = (fey - fy) / segLen, s2 = 1.0 / Math.sqrt(2.0);
        List<double[]> candidates = List.of(
                new double[]{-ty, tx, requestedLeadIn},
                new double[]{ty, -tx, requestedLeadIn},
                new double[]{(-tx - ty) * s2, (-ty + tx) * s2, requestedLeadIn},
                new double[]{(-tx + ty) * s2, (-ty - tx) * s2, requestedLeadIn},
                new double[]{-tx, -ty, requestedLeadIn}
        );
        return findSafeLeadRay(fx, fy, candidates, null, false, ownOuterRings, ctx);
    }

    private static Set<List<Point>> resolveOwnOuterRingsForChainStart(
            double fx, double fy, double fex, double fey, List<PieceGeometry> pieces
    ) {
        Set<List<Point>> matched = Collections.newSetFromMap(new IdentityHashMap<>());
        for (PieceGeometry piece : pieces) {
            List<Point> outer = piece.outerWorld();
            for (int i = 0, n = outer.size(); i < n; i++) {
                Point a = outer.get(i), b = outer.get((i + 1) % n);
                if (Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), fx, fy) <= 1e-5
                        && Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), fex, fey) <= 1e-5) {
                    matched.add(outer);
                    break;
                }
            }
        }
        if (!matched.isEmpty()) {
            return matched;
        }
        List<Point> closestOuter = null;
        double bestDist = Double.POSITIVE_INFINITY;
        for (PieceGeometry piece : pieces) {
            List<Point> outer = piece.outerWorld();
            for (int i = 0, n = outer.size(); i < n; i++) {
                Point a = outer.get(i), b = outer.get((i + 1) % n);
                double d = Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), fx, fy);
                if (d < bestDist) {
                    bestDist = d;
                    closestOuter = outer;
                }
            }
        }
        if (closestOuter != null) {
            matched.add(closestOuter);
        }
        return matched;
    }

    private static Point findSafeLeadRay(
            double ox, double oy, List<double[]> candidates, List<Point> loopPts,
            boolean hole, Set<List<Point>> ownOuterRings, CamContext ctx
    ) {
        for (double[] cand : candidates) {
            double boundT = clampRayToBounds(ox, oy, cand[0], cand[1], cand[2], ctx.widthMm(), ctx.bedLengthMm());
            double maxT = clampRayAgainstPieces(ox, oy, cand[0], cand[1], boundT, ctx.pieces());
            if (maxT < 0.2) continue;
            if (isSafeLeadRay(ox, oy, cand[0], cand[1], maxT, loopPts, hole, ownOuterRings, ctx.pieces())) {
                return new Point(ox + cand[0] * maxT, oy + cand[1] * maxT);
            }
            if (isSafeLeadRay(ox, oy, cand[0], cand[1], 0.2, loopPts, hole, ownOuterRings, ctx.pieces())) {
                double lo = 0.2, hi = maxT;
                for (int iter = 0; iter < 12; iter++) {
                    double mid = 0.5 * (lo + hi);
                    if (isSafeLeadRay(ox, oy, cand[0], cand[1], mid, loopPts, hole, ownOuterRings, ctx.pieces())) lo = mid;
                    else hi = mid;
                }
                return new Point(ox + cand[0] * lo, oy + cand[1] * lo);
            }
        }
        return null;
    }

    private static boolean isSafeLeadRay(
            double ox, double oy, double ux, double uy, double len,
            List<Point> loopPts, boolean hole, Set<List<Point>> ownOuterRings, List<PieceGeometry> pieces
    ) {
        if (len < 0.2 - 1e-6) return false;
        Point pierce = new Point(ox + ux * len, oy + uy * len);
        Point mid = new Point(ox + ux * (0.5 * len), oy + uy * (0.5 * len));
        Point near = new Point(ox + ux * Math.min(0.2, 0.25 * len), oy + uy * Math.min(0.2, 0.25 * len));
        if (isInsideAnyPieceMaterial(pierce, pieces) || isInsideAnyPieceMaterial(mid, pieces) || isInsideAnyPieceMaterial(near, pieces)) return false;
        if (hole && loopPts != null && (!PolygonGeometry.pointStrictlyInsideRing(pierce, loopPts) || !PolygonGeometry.pointStrictlyInsideRing(mid, loopPts))) return false;
        double rsx = ox + ux * Math.min(0.05, 0.1 * len), rsy = oy + uy * Math.min(0.05, 0.1 * len);
        double csx = ox + ux * Math.min(0.2, len), csy = oy + uy * Math.min(0.2, len);
        for (PieceGeometry piece : pieces) {
            List<List<Point>> rings = new ArrayList<>(1 + piece.holeWorlds().size());
            rings.add(piece.outerWorld());
            rings.addAll(piece.holeWorlds());
            for (int ringIdx = 0; ringIdx < rings.size(); ringIdx++) {
                boolean isHoleRing = ringIdx > 0;
                List<Point> ring = rings.get(ringIdx);
                boolean ownRing = loopPts != null && ring.size() == loopPts.size() && ring.size() >= 3
                        && ring.stream().anyMatch(p -> Math.hypot(p.x() - loopPts.get(0).x(), p.y() - loopPts.get(0).y()) <= 1e-4)
                        && ring.stream().anyMatch(p -> Math.hypot(p.x() - loopPts.get(loopPts.size() / 2).x(), p.y() - loopPts.get(loopPts.size() / 2).y()) <= 1e-4);
                for (int i = 0, n = ring.size(); i < n; i++) {
                    Point a = ring.get(i), b = ring.get((i + 1) % n);
                    if (Line2D.linesIntersect(rsx, rsy, pierce.x(), pierce.y(), a.x(), a.y(), b.x(), b.y())) return false;
                    if (Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), pierce.x(), pierce.y()) <= 0.02) return false;
                    boolean adjacentEdge = loopPts == null
                            ? (!isHoleRing && ownOuterRings != null && ownOuterRings.contains(ring)
                                && Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), ox, oy) <= 1e-5)
                            : (ownRing && (Math.hypot(a.x() - ox, a.y() - oy) <= 0.25 || Math.hypot(b.x() - ox, b.y() - oy) <= 0.25));
                    if (adjacentEdge) continue;
                    double d1 = Line2D.linesIntersect(csx, csy, pierce.x(), pierce.y(), a.x(), a.y(), b.x(), b.y()) ? 0.0
                            : Math.min(Math.min(Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), csx, csy), Line2D.ptSegDist(a.x(), a.y(), b.x(), b.y(), pierce.x(), pierce.y())),
                            Math.min(Line2D.ptSegDist(csx, csy, pierce.x(), pierce.y(), a.x(), a.y()), Line2D.ptSegDist(csx, csy, pierce.x(), pierce.y(), b.x(), b.y())));
                    if (d1 < 0.205) return false;
                }
            }
        }
        return true;
    }

    private static double clampRayAgainstPieces(double ox, double oy, double ux, double uy, double maxT, List<PieceGeometry> pieces) {
        if (maxT <= 0.2 || isInsideAnyPieceMaterial(new Point(ox + ux * 0.05, oy + uy * 0.05), pieces)) return 0.0;
        double tLimit = maxT;
        for (PieceGeometry piece : pieces) {
            List<List<Point>> rings = new ArrayList<>(1 + piece.holeWorlds().size());
            rings.add(piece.outerWorld());
            rings.addAll(piece.holeWorlds());
            for (List<Point> ring : rings) {
                for (int i = 0, n = ring.size(); i < n; i++) {
                    Point a = ring.get(i), b = ring.get((i + 1) % n);
                    double vx = b.x() - a.x(), vy = b.y() - a.y(), denom = uy * vx - ux * vy;
                    if (Math.abs(denom) <= 1e-9) {
                        if (Math.abs((a.x() - ox) * uy - (a.y() - oy) * ux) < 0.05) {
                            double ta = (a.x() - ox) * ux + (a.y() - oy) * uy, tb = (b.x() - ox) * ux + (b.y() - oy) * uy;
                            double segMin = Math.min(ta, tb);
                            if (Math.max(ta, tb) > 1e-4 && segMin > 1e-4 && segMin < tLimit) tLimit = Math.min(tLimit, Math.max(0.0, segMin - 0.2));
                        }
                        continue;
                    }
                    double dx = a.x() - ox, dy = a.y() - oy;
                    double tHit = (dy * vx - dx * vy) / denom, uHit = (ux * dy - uy * dx) / denom;
                    if (tHit > 1e-4 && tHit <= tLimit && uHit >= -1e-6 && uHit <= 1.0 + 1e-6) tLimit = Math.min(tLimit, Math.max(0.0, tHit - 0.2));
                }
            }
        }
        if (tLimit <= 0.2) return 0.0;
        Point mid = new Point(ox + ux * (tLimit * 0.5), oy + uy * (tLimit * 0.5));
        Point end = new Point(ox + ux * tLimit, oy + uy * tLimit);
        return (isInsideAnyPieceMaterial(mid, pieces) || isInsideAnyPieceMaterial(end, pieces)) ? 0.0 : tLimit;
    }

    private static boolean isInsideAnyPieceMaterial(Point pt, List<PieceGeometry> pieces) {
        for (PieceGeometry piece : pieces) {
            if (piece.outerWorld().size() >= 3 && PolygonGeometry.pointStrictlyInsideRing(pt, piece.outerWorld())) {
                boolean insideHole = false;
                for (List<Point> hole : piece.holeWorlds()) {
                    if (hole.size() >= 3 && PolygonGeometry.pointStrictlyInsideRing(pt, hole)) {
                        insideHole = true;
                        break;
                    }
                }
                if (!insideHole) return true;
            }
        }
        return false;
    }

    private static double[] extendSegmentWithOvercut(double sx, double sy, double ex, double ey, double overcutMm, double maxW, double maxL) {
        double dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy);
        if (len <= 1e-6 || overcutMm <= 0.0) return new double[]{sx, sy, ex, ey};
        double ux = dx / len, uy = dy / len;
        double tStart = clampRayToBounds(sx, sy, -ux, -uy, overcutMm, maxW, maxL);
        double tEnd = clampRayToBounds(ex, ey, ux, uy, overcutMm, maxW, maxL);
        return new double[]{sx - ux * tStart, sy - uy * tStart, ex + ux * tEnd, ey + uy * tEnd};
    }

    private static double clampRayToBounds(double ox, double oy, double ux, double uy, double requestedDist, double maxW, double maxL) {
        if (requestedDist <= 0.0) return 0.0;
        double tMax = requestedDist;
        if (ux > 1e-12) tMax = Math.min(tMax, (maxW - ox) / ux);
        else if (ux < -1e-12) tMax = Math.min(tMax, (0.0 - ox) / ux);
        else if (ox < -1e-9 || ox > maxW + 1e-9) return 0.0;
        if (uy > 1e-12) tMax = Math.min(tMax, (maxL - oy) / uy);
        else if (uy < -1e-12) tMax = Math.min(tMax, (0.0 - oy) / uy);
        else if (oy < -1e-9 || oy > maxL + 1e-9) return 0.0;
        return Math.max(0.0, tMax);
    }

    private record CircleFit(double cx, double cy, double radius, boolean ccw) {}

    private static CircleFit fitCircle(List<Point> pts) {
        if (pts == null || pts.size() < 8) {
            return null;
        }
        int n = pts.size();
        Point p1 = pts.get(0);
        Point p2 = pts.get(n / 3);
        Point p3 = pts.get((2 * n) / 3);
        double d = 2.0 * (p1.x() * (p2.y() - p3.y()) + p2.x() * (p3.y() - p1.y()) + p3.x() * (p1.y() - p2.y()));
        if (Math.abs(d) < 1e-6) {
            return null;
        }
        double p1Sq = p1.x() * p1.x() + p1.y() * p1.y();
        double p2Sq = p2.x() * p2.x() + p2.y() * p2.y();
        double p3Sq = p3.x() * p3.x() + p3.y() * p3.y();
        double cx = (p1Sq * (p2.y() - p3.y()) + p2Sq * (p3.y() - p1.y()) + p3Sq * (p1.y() - p2.y())) / d;
        double cy = (p1Sq * (p3.x() - p2.x()) + p2Sq * (p1.x() - p3.x()) + p3Sq * (p2.x() - p1.x())) / d;
        double radius = Math.hypot(p1.x() - cx, p1.y() - cy);
        if (!Double.isFinite(radius) || radius < 1.0) {
            return null;
        }
        for (Point p : pts) {
            double dist = Math.hypot(p.x() - cx, p.y() - cy);
            if (Math.abs(dist - radius) > CIRCLE_FIT_TOLERANCE_MM) {
                return null;
            }
        }

        // 校验闭合角连续性：方向完全一致、单步角跨度 <= 60°、累计扫掠角接近 ±2π 且弦长均匀
        int expectedSign = 0;
        double totalSweep = 0.0;
        double sumChord = 0.0;
        double minChord = Double.MAX_VALUE;
        double maxChord = 0.0;
        double lastChord = 0.0;
        for (int i = 0; i < n; i++) {
            Point a = pts.get(i);
            Point b = pts.get((i + 1) % n);
            double chord = Math.hypot(b.x() - a.x(), b.y() - a.y());
            if (chord <= 1e-4) {
                return null;
            }
            double angA = Math.atan2(a.y() - cy, a.x() - cx);
            double angB = Math.atan2(b.y() - cy, b.x() - cx);
            double delta = normalizeAngle(angB - angA);
            double absDelta = Math.abs(delta);
            if (absDelta <= 1e-4 || absDelta > (Math.PI / 3.0) + 1e-6) {
                return null;
            }
            int sign = delta > 0 ? 1 : -1;
            if (expectedSign == 0) {
                expectedSign = sign;
            } else if (sign != expectedSign) {
                return null;
            }
            totalSweep += delta;
            sumChord += chord;
            if (chord < minChord) minChord = chord;
            if (chord > maxChord) maxChord = chord;
            if (i == n - 1) lastChord = chord;
        }
        if (Math.abs(Math.abs(totalSweep) - 2.0 * Math.PI) >= 0.15) {
            return null;
        }
        double avgChord = sumChord / n;
        if (maxChord > avgChord * 1.8 || maxChord > minChord * 2.5 || lastChord > avgChord * 1.8) {
            return null;
        }
        boolean ccw = PolygonGeometry.signedArea(pts) > 0;
        if (ccw != (totalSweep > 0)) {
            return null;
        }
        return new CircleFit(cx, cy, radius, ccw);
    }

    private static double normalizeAngle(double angle) {
        while (angle > Math.PI) angle -= 2.0 * Math.PI;
        while (angle <= -Math.PI) angle += 2.0 * Math.PI;
        return angle;
    }
}
