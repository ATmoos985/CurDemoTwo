package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.model.nesting.NestingProblem;
import java.util.*;

/** Rebuilds an executable guillotine subdivision without moving the supplied pieces. No inventory state. */
public final class ManualLayoutValidator {
    private static final double EPS = .001;
    private record Region(double x, double y, double w, double h, List<PlacedPiece> pieces, boolean first) {}
    private record Split(boolean horizontal, double position) {}

    public static EngineResult validate(NestingProblem problem, List<PlacedPiece> pieces) {
        NestingValidation.validate(problem);
        if (!Set.of("CROSSCUT", "GUILLOTINE").contains(problem.process().mode()))
            throw new IllegalArgumentException("手调校验当前支持矩形横切与贯通切割");
        if (pieces == null || pieces.isEmpty()) throw new IllegalArgumentException("至少保留一件裁片，清空方案请使用取消方案");
        EngineResult result = new EngineResult(); result.setPieces(pieces);
        String invalid = RectangularResultValidator.validate(problem, result);
        if (invalid != null) throw new IllegalArgumentException(invalid);
        for (PlacedPiece piece : pieces) {
            if (piece.getY() < problem.process().trimStart() - EPS) throw new IllegalArgumentException("裁片进入卷头修边区域");
            for (double value : new double[]{piece.getX(), piece.getY(), piece.getW(), piece.getL()})
                if (Math.abs(value * 10 - Math.rint(value * 10)) > .000001)
                    throw new IllegalArgumentException("调整位置与尺寸须精确到 0.1 mm，不能静默舍入");
            if ("CROSSCUT".equals(problem.process().mode()) && (Math.abs(piece.getX()) > EPS || Math.abs(piece.getW() - problem.width()) > EPS))
                throw new IllegalArgumentException("仅横切要求裁片保持整幅宽度");
        }
        List<CutStep> cuts = new ArrayList<>();
        List<RemnantPiece> remnants = new ArrayList<>();
        Deque<Region> regions = new ArrayDeque<>();
        regions.push(new Region(0, 0, problem.width(), problem.height(), pieces, true));
        while (!regions.isEmpty()) {
            Region region = regions.pop();
            if (region.pieces().isEmpty()) { addRemnant(problem, region, remnants); continue; }
            if (region.pieces().size() == 1) {
                var p = region.pieces().get(0);
                if (Math.abs(p.getW() - region.w()) < EPS && Math.abs(p.getL() - region.h()) < EPS) continue;
            }
            Split split = findSplit(region, problem);
            if (split == null) throw new IllegalArgumentException("当前调整不能按所选首刀方向完成贯通切割，请移动裁片留出贯通分割线");
            double position = split.position();
            boolean h = split.horizontal();
            cuts.add(new CutStep(cuts.size()+1, h ? "横切" : "纵切", position, h ? region.x() : region.y(),
                    h ? region.x()+region.w() : region.y()+region.h(), "调整版贯通分割"));
            List<PlacedPiece> before = new ArrayList<>(), after = new ArrayList<>();
            for (var piece : region.pieces()) {
                if ((h ? piece.getY()+piece.getL() : piece.getX()+piece.getW()) <= position + EPS) before.add(piece);
                else after.add(piece);
            }
            // Depth-first order ensures that every cut acts on a region produced by an earlier cut.
            regions.push(h ? new Region(region.x(), position, region.w(), region.y()+region.h()-position, after, false)
                    : new Region(position, region.y(), region.x()+region.w()-position, region.h(), after, false));
            regions.push(h ? new Region(region.x(), region.y(), region.w(), position-region.y(), before, false)
                    : new Region(region.x(), region.y(), position-region.x(), region.h(), before, false));
        }
        double usedHeight = problem.sheet() ? problem.height() : pieces.stream().mapToDouble(p -> p.getY() + p.getL()).max().orElseThrow();
        for (var cut : cuts) usedHeight = Math.max(usedHeight, "横切".equals(cut.getType()) ? cut.getPos() : cut.getEnd());
        for (var remnant : remnants) usedHeight = Math.max(usedHeight, remnant.getY()+remnant.getL());
        if (!problem.sheet() && problem.material().continuesAfterRegion() && usedHeight >= problem.height()-EPS)
            cuts.add(new CutStep(cuts.size()+1, "横切", usedHeight, 0, problem.width(), "分离本工位与后续连续母卷"));
        // ponytail: keep the validated order; explicit parent dependencies can later unlock independent subregions.
        cuts.forEach(c -> c.setStage(c.getStep()));
        result.setCuts(cuts); result.setRemnants(remnants); result.setSuggestedFeedLength(usedHeight);
        result.setSuccess(true); result.setMessage("手动调整已通过几何与贯通切割校验");
        invalid = RectangularResultValidator.validate(problem, result);
        if (invalid != null) throw new IllegalArgumentException(invalid);
        return result;
    }

    private static Split findSplit(Region region, NestingProblem problem) {
        boolean horizontal = "horizontal".equals(problem.process().firstStageOrientation());
        for (boolean h : new boolean[]{horizontal, !horizontal}) {
            if ((!h && "CROSSCUT".equals(problem.process().mode())) || (region.first() && h != horizontal)) continue;
            TreeSet<Double> candidates = new TreeSet<>();
            for (var piece : region.pieces()) {
                candidates.add(h ? piece.getY() : piece.getX());
                candidates.add(h ? piece.getY()+piece.getL() : piece.getX()+piece.getW());
            }
            double start = h ? region.y() : region.x(), end = start + (h ? region.h() : region.w());
            for (double position : candidates) {
                if (position <= start + EPS || position >= end - EPS) continue;
                boolean crosses = region.pieces().stream().anyMatch(p -> {
                    double a = h ? p.getY() : p.getX(), b = a + (h ? p.getL() : p.getW());
                    return a < position - EPS && b > position + EPS;
                });
                if (!crosses) return new Split(h, position);
            }
        }
        return null;
    }

    private static void addRemnant(NestingProblem problem, Region r, List<RemnantPiece> remnants) {
        // A whole-width uncut tail stays on the roll; partial-width tail regions have already been slit.
        if (!problem.sheet() && Math.abs(r.x()) < EPS && Math.abs(r.w()-problem.width()) < EPS && Math.abs(r.y()+r.h()-problem.height()) < EPS) return;
        if (r.w() + EPS < problem.process().minReusableWidth() || r.h() + EPS < problem.process().minReusableHeight()) return;
        boolean defect = problem.material().exclusions().stream().anyMatch(d -> r.x() < d.x()+d.shape().width()+d.clearance()
                && r.x()+r.w() > d.x()-d.clearance() && r.y() < d.y()+d.shape().height()+d.clearance() && r.y()+r.h() > d.y()-d.clearance());
        remnants.add(new RemnantPiece("REM-ADJUST-"+(remnants.size()+1), defect ? "带疵料头" : "可用料头",
                r.x(), r.y(), r.w(), r.h(), r.w()*r.h()/1_000_000, defect));
    }
}
