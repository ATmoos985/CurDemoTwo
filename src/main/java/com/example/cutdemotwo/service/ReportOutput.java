package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.solver.EngineGeometry;
import java.util.*;

/** Validated dispositions of saved plan pieces. Does not mutate a plan or inventory. */
record ReportOutput(List<ReportedPiece> details, List<PlacedPiece> qualified, List<PlacedPiece> rejected, List<PlacedPiece> uncut) {
    record ReportedPiece(int pieceId, Integer demandId, String name, double x, double y, double w, double l, String outcome, String reason) {}

    static ReportOutput resolve(SolveResponse plan, CutReport report) {
        var supplied = report.pieceResults() == null ? plan.getPieces().stream()
                .map(p -> new CutReport.PieceResult(p.getId(), "QUALIFIED", "")).toList() : report.pieceResults();
        Map<Integer, CutReport.PieceResult> rows = new HashMap<>();
        for (var row : supplied) {
            if (row == null || row.outcome() == null || !Set.of("QUALIFIED", "REJECTED", "UNCUT").contains(row.outcome())
                    || rows.putIfAbsent(row.pieceId(), row) != null)
                throw new IllegalArgumentException("裁片报工编号重复、结果缺失或无效");
            if (("REJECTED".equals(row.outcome()) && (row.reason() == null || row.reason().isBlank()))
                    || (row.reason() != null && row.reason().length() > 500))
                throw new IllegalArgumentException("异常裁片请填写 1 至 500 字原因");
        }
        if (rows.size() != plan.getPieces().size()) throw new IllegalArgumentException("请逐件核对当前方案的全部裁片结果");
        var details = new ArrayList<ReportedPiece>();
        var qualified = new ArrayList<PlacedPiece>(); var rejected = new ArrayList<PlacedPiece>(); var uncut = new ArrayList<PlacedPiece>();
        for (var p : plan.getPieces()) {
            var row = rows.get(p.getId());
            if (row == null) throw new IllegalArgumentException("报工裁片不属于当前方案");
            switch (row.outcome()) { case "QUALIFIED" -> qualified.add(p); case "REJECTED" -> rejected.add(p); default -> uncut.add(p); }
            details.add(new ReportedPiece(p.getId(), p.getDemandId(), p.getName(), p.getX(), p.getY(), p.getW(), p.getL(),
                    row.outcome(), row.reason() == null ? "" : row.reason().trim()));
        }
        if (report.finishedPieceCount() != qualified.size() || plan.getPieces().isEmpty())
            throw new IllegalArgumentException("合格产出数量与逐件结果不一致");
        return new ReportOutput(details, qualified, rejected, uncut);
    }

    List<PlacedPiece> cutPieces() { var all = new ArrayList<>(qualified); all.addAll(rejected); return all; }
    double qualifiedArea() { return area(qualified); }
    double rejectedArea() { return area(rejected); }
    private static double area(List<PlacedPiece> pieces) { return pieces.stream().mapToDouble(p -> p.getW()*p.getL()/1_000_000).sum(); }

    Map<String, RemnantPiece> recoveryCandidates(SolveResponse plan, double sourceLength) {
        Map<String, RemnantPiece> candidates = new LinkedHashMap<>();
        plan.getRemnants().forEach(r -> candidates.put(r.getId(), r));
        for (var p : uncut) {
            double length = Math.min(p.getY()+p.getL(), sourceLength) - p.getY();
            if (length <= 0) continue; // The unseparated tail stays on the roll.
            String id = "UNCUT-" + p.getId();
            if (candidates.containsKey(id)) throw new IllegalArgumentException("方案料头编号与未切区域冲突，请重新排料");
            candidates.put(id, new RemnantPiece(id, "未切区域毛料", p.getX(), p.getY(), p.getW(), length,
                    p.getW()*length/1_000_000, false));
        }
        // Old saved plans may contain near-zero coordinates. Normalize copies so validation,
        // defect clipping and the receipt use the same geometry without rewriting the plan.
        candidates.replaceAll((id, r) -> new RemnantPiece(r.getId(), r.getStatus(),
                EngineGeometry.normalizeZero(r.getX()), EngineGeometry.normalizeZero(r.getY()),
                r.getW(), r.getL(), r.getArea(), r.isHasDefect()));
        return candidates;
    }
}
