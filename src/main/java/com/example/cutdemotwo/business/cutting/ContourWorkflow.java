package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.example.cutdemotwo.algorithm.solver.EngineResult;
import com.example.cutdemotwo.algorithm.solver.PolygonGeometry;
import com.example.cutdemotwo.algorithm.solver.PolygonResultValidator;
import com.example.cutdemotwo.algorithm.solver.SolverFactory;
import java.util.*;

/** Uses the same saved task/plan/report lifecycle for true part outlines. */
public final class ContourWorkflow {
    private ContourWorkflow() {}

    public static boolean isContour(SolveRequest r) {
        return r.getDemands() != null && r.getDemands().stream().anyMatch(d -> d != null && d.getShape() != null);
    }

    static NestingProblem problem(SolveRequest r, double length) {
        r.validateSettings();
        if (!Double.isFinite(r.getRollW()) || r.getRollW() <= 0 || !Double.isFinite(length) || length <= 0)
            throw new IllegalArgumentException("布幅和加工区长度必须为正数");
        if (!Double.isFinite(r.getTrimStart()) || r.getTrimStart() < 0 || r.getTrimStart() >= length)
            throw new IllegalArgumentException("修齐长度必须小于加工区长度");
        var exclusions = new ArrayList<NestingProblem.Exclusion>();
        for (var d : r.getDefects()) {
            if (d == null || !Double.isFinite(d.getX()) || !Double.isFinite(d.getY()) || !Double.isFinite(d.getW()) ||
                    !Double.isFinite(d.getH()) || !Double.isFinite(d.getMargin()) || d.getW() <= 0 || d.getH() <= 0 || d.getMargin() < 0)
                throw new IllegalArgumentException("疵点坐标和尺寸无效");
            double x = Math.max(0, d.getX()-d.getMargin()), y = Math.max(0, d.getY()-d.getMargin());
            double right = Math.min(r.getRollW(), d.getX()+d.getW()+d.getMargin());
            double bottom = Math.min(length, d.getY()+d.getH()+d.getMargin());
            if (right > x && bottom > y) exclusions.add(new NestingProblem.Exclusion(exclusions.size()+1, x, y,
                    NestingProblem.Shape.rectangle(right-x, bottom-y), 0));
        }
        if (r.getTrimStart() > 0) exclusions.add(new NestingProblem.Exclusion(exclusions.size()+1, 0, 0,
                NestingProblem.Shape.rectangle(r.getRollW(), r.getTrimStart()), 0));
        var parts = r.getDemands().stream().map(d -> {
            if (d == null || d.geometry().width() != d.getWidth() || d.geometry().height() != d.getLength())
                throw new IllegalArgumentException("需求尺寸与衣片轮廓不一致");
            PolygonGeometry.validate(d.geometry());
            // Each pattern owns its grain permission; the rectangle-wide rotation switch cannot override it.
            return new NestingProblem.Part(d.getId(), d.getName(), d.geometry(), d.getDemand(), d.isAllowRotation());
        }).toList();
        return new NestingProblem("1", "mm", new NestingProblem.Material("work-region",
                NestingProblem.Shape.rectangle(r.getRollW(), length), exclusions, false), parts,
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0,
                        "MAXIMIZE_PIECE_AREA", r.getPieceGap()), "auto", r.getTimeLimitSeconds());
    }

    static SolveResponse solve(SolverFactory factory, SolveRequest r) {
        var input = problem(r, r.getRollL());
        var best = factory.solve(input);
        if (!complete(input, best)) {
            var failed = FabricSolveAdapter.toLegacy(r, best);
            failed.setSuccess(false);
            failed.setPieces(List.of());
            if (best.feasible()) {
                failed.setStatus("INCOMPLETE_SET");
                failed.setMessage("当前区域未能齐套排入全部需求，请增加拉布长度、调整区域或核对疵点后重试");
            }
            return failed;
        }
        double high = extent(best.placements());
        double low = Math.max(r.getTrimStart(), input.parts().stream().mapToDouble(p ->
                PolygonGeometry.area(p.shape()) * p.quantity()).sum() / r.getRollW());
        // Bounded search keeps a complete incumbent; a failed trial is not a proof of impossibility.
        for (int i = 0; i < 3 && high-low > 1; i++) {
            double length = Math.floor((high+low)*5)/10;
            var trial = problem(r, length);
            var result = factory.solve(trial);
            if (complete(trial, result)) { best=result; high=extent(result.placements()); }
            else low=length;
        }
        return response(r, best.placements(), best.engine());
    }

    private static boolean complete(NestingProblem p, NestingResult r) {
        return r.feasible() && p.parts().stream().allMatch(d ->
                r.placements().stream().filter(v -> v.demandId() == d.id()).count() == d.quantity());
    }
    private static double extent(List<NestingResult.Placement> pieces) {
        return pieces.stream().mapToDouble(p -> p.y()+p.shape().height()).max().orElse(0);
    }

    static SolveResponse adjust(SolveRequest r, List<PlacedPiece> pieces) {
        var input = problem(r, r.getRollL());
        var output = new EngineResult();
        for (var p : pieces) {
            if (p.getShape() == null || p.getDemandId() == null) throw new IllegalArgumentException("调整缺少裁片轮廓或需求归属");
            output.getPlacements().add(new NestingResult.Placement(p.getId(), p.getDemandId(), p.getName(), p.getX(), p.getY(),
                    p.getShape(), p.getRotationDegrees()));
        }
        String error = PolygonResultValidator.validate(input, output);
        if (error != null) throw new IllegalArgumentException(error);
        for (var d : input.parts()) if (output.getPlacements().stream().filter(p -> p.demandId()==d.id()).count()!=d.quantity())
            throw new IllegalArgumentException("唛架调整必须保留全部需求裁片，不能漏片");
        return response(r, output.getPlacements(), "validated-contour");
    }

    private static SolveResponse response(SolveRequest r, List<NestingResult.Placement> placements, String engine) {
        var result = new SolveResponse();
        result.setSuccess(true); result.setStatus("FEASIBLE"); result.setEngine(engine); result.setRequestedEngine(engine);
        result.setMessage("已齐套排入全部裁片；沿闭合轮廓生成刀序，实切后按原流程报工");
        result.setRollW(r.getRollW()); result.setRollL(r.getRollL()); result.setDefects(r.getDefects());
        result.setFeedPortType(r.getFeedPortType()); result.setSourceRemnantId(r.getSourceRemnantId());
        var pieces = placements.stream().map(p -> {
            var piece = new PlacedPiece(p.id(), p.name(), p.x(), p.y(), p.shape().width(), p.shape().height(),
                    p.rotationDegrees()%180 != 0, p.demandId());
            piece.setShape(p.shape()); piece.setRotationDegrees(p.rotationDegrees()); return piece;
        }).toList();
        result.setPieces(pieces); result.setRemnants(List.of());
        result.setFulfillment(r.getDemands().stream().map(d -> new NestingResult.Fulfillment(d.getId(), d.getDemand(), d.getDemand(), 0, null)).toList());
        var cuts = new ArrayList<CutStep>();
        double x = r.getCutOrigin().startsWith("right") ? r.getRollW() : 0;
        double y = r.getCutOrigin().endsWith("bottom") ? r.getRollL() : 0;
        var pending = new ArrayList<>(placements);
        while (!pending.isEmpty()) {
            double cx=x, cy=y;
            var p = pending.stream().min(Comparator.comparingDouble(a -> {
                var first=PolygonGeometry.vertices(a.shape()).get(0);
                return Math.hypot(a.x()+first.x()-cx,a.y()+first.y()-cy);
            })).orElseThrow();
            pending.remove(p);
            var vertices = PolygonGeometry.vertices(p.shape());
            for (int i=0; i<vertices.size(); i++) {
                var a=vertices.get(i); var b=vertices.get((i+1)%vertices.size());
                double ax=p.x()+a.x(), ay=p.y()+a.y(), bx=p.x()+b.x(), by=p.y()+b.y();
                var cut=new CutStep(cuts.size()+1,"轮廓切",ax,ay,by,p.name()+" · 边 "+(i+1)+"/"+vertices.size());
                cut.setStartX(ax); cut.setStartY(ay); cut.setEndX(bx); cut.setEndY(by);
                cut.setAirDistance(Math.hypot(ax-x,ay-y)); cut.setStage(cuts.size()+1);
                cuts.add(cut); x=bx; y=by;
            }
        }
        result.setCuts(cuts);
        double length=extent(placements), area=pieces.stream().mapToDouble(PlacedPiece::areaMm2).sum()/1e6;
        boolean sheet="remnant".equals(r.getFeedPortType());
        result.setDeductLen(sheet?0:length); result.setPieceArea(area); result.setRemArea(0);
        result.setTotalArea(r.getRollW()*(sheet?r.getRollL():length)/1e6);
        result.setWasteArea(Math.max(0,result.getTotalArea()-area));
        return result;
    }
}
