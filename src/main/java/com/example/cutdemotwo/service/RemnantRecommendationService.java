package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;
import java.util.*;
import java.util.concurrent.Semaphore;

/** Independent alternatives for the next remnant, not an allocation across multiple stocks. */
@Service
public class RemnantRecommendationService {
    public static final int MAX_CANDIDATES = 8;
    private final RemnantService inventory;
    private final SolverFactory solver;
    private final ObjectMapper json = new ObjectMapper();
    private final Semaphore running = new Semaphore(1);

    public RemnantRecommendationService(RemnantService inventory, SolverFactory solver) {
        this.inventory = inventory; this.solver = solver;
    }
    public record Request(SolveRequest input, Map<String, Integer> completedBaseline) {}
    public record Line(int demandId, String name, double width, double length, int requested, int placed, int remaining) {}
    public record Recommendation(RemnantStock stock, int pieceCount, double pieceArea, double utilization,
                                 int cutCount, List<Line> lines) {}
    public record Unavailable(String id, String status, String message) {}
    public record Analysis(int candidateCount, int evaluatedCount, int deferredCount, long inventoryVersion,
                           List<Recommendation> recommendations, List<Unavailable> unavailable) {}
    public static class Busy extends RuntimeException {
        public Busy() { super("已有料头推荐正在计算，请稍后重试"); }
    }

    public Analysis recommend(Request body) {
        if (body == null || body.input() == null) throw new IllegalArgumentException("请填写材料型号与剩余需求");
        var input = body.input();
        input.validateSettings();
        validateDemands(input);
        if (!running.tryAcquire()) throw new Busy();
        try {
            var snapshot = inventory.recommendationSnapshot(input, body.completedBaseline());
            var recommendations = new ArrayList<Recommendation>();
            var unavailable = new ArrayList<Unavailable>();
            int evaluated = Math.min(MAX_CANDIDATES, snapshot.stocks().size());
            for (var stock : snapshot.stocks().subList(0, evaluated)) {
                if (stock.isHasDefect() && (stock.getDefects() == null || stock.getDefects().isEmpty())) {
                    unavailable.add(new Unavailable(stock.getId(), "DEFECTS_UNLOCATED", "带疵料头尚未登记疵点位置，无法验证可切范围"));
                    continue;
                }
                SolveRequest trial = json.readValue(json.writeValueAsBytes(input), SolveRequest.class);
                trial.setTaskId(null); trial.setTaskRevision(0);
                trial.setFeedPortType("remnant"); trial.setSourceRemnantId(stock.getId());
                trial.setRollId(stock.getSourceRollId()); trial.setRollW(stock.getWidth());
                trial.setRollL(stock.getLength()); trial.setTotalRollL(stock.getLength()); trial.setWindowStartY(0);
                trial.setDefects(stock.getDefects() == null ? List.of() : stock.getDefects());
                trial.setTimeLimitSeconds(1);
                if (!trial.isAllowLongitudinal() && trial.getDemands().stream().noneMatch(d -> Math.abs(d.getWidth() - stock.getWidth()) < .001)) {
                    unavailable.add(new Unavailable(stock.getId(), "PROCESS_MISMATCH", "仅横切需要裁片原始宽度等于料头幅宽，不能旋转后替代"));
                    continue;
                }
                var result = FabricSolveAdapter.solve(solver, trial);
                if (!result.isSuccess() || result.getPieces().isEmpty()) {
                    unavailable.add(new Unavailable(stock.getId(), result.getStatus(), result.getMessage()));
                    continue;
                }
                var counts = new HashMap<Integer, Integer>();
                result.getPieces().forEach(p -> counts.merge(p.getDemandId(), 1, Integer::sum));
                var lines = input.getDemands().stream().map(d -> new Line(d.getId(), d.getName(), d.getWidth(), d.getLength(),
                        d.getDemand(), counts.getOrDefault(d.getId(), 0), d.getDemand() - counts.getOrDefault(d.getId(), 0))).toList();
                double area = result.getPieces().stream().mapToDouble(p -> p.getW() * p.getL() / 1_000_000).sum();
                recommendations.add(new Recommendation(stock, result.getPieces().size(), area,
                        area / stock.getArea() * 100, result.getCuts().size(), lines));
            }
            recommendations.sort(Comparator.comparingDouble(Recommendation::pieceArea).reversed()
                    .thenComparing(Comparator.comparingDouble(Recommendation::utilization).reversed())
                    .thenComparingInt(Recommendation::cutCount).thenComparing(r -> r.stock().getId()));
            inventory.verifyRecommendationRevision(snapshot.revision());
            return new Analysis(snapshot.stocks().size(), evaluated, snapshot.stocks().size() - evaluated,
                    snapshot.revision(), List.copyOf(recommendations), List.copyOf(unavailable));
        } finally { running.release(); }
    }

    private void validateDemands(SolveRequest input) {
        if (input.getRollModel() == null || input.getRollModel().isBlank() || input.getDemands() == null || input.getDemands().isEmpty())
            throw new IllegalArgumentException("请填写材料型号与剩余需求");
        var ids = new HashSet<Integer>(); long count = 0;
        for (var d : input.getDemands()) {
            if (d == null || !ids.add(d.getId()) || !Double.isFinite(d.getWidth()) || d.getWidth() <= 0
                    || !Double.isFinite(d.getLength()) || d.getLength() <= 0 || d.getDemand() <= 0)
                throw new IllegalArgumentException("需求编号须唯一，尺寸须为正数，剩余件数须为正整数");
            count += d.getDemand();
        }
        if (count > 10000) throw new IllegalArgumentException("一次料头推荐最多处理 10000 件剩余需求");
    }
}
