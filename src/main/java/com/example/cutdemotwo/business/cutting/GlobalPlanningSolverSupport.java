package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;

import java.util.*;

/**
 * 全局联合排产料头排序、母卷窗口二分试算与 {@link NestingSolver} 统一求解适配协作者。
 */
final class GlobalPlanningSolverSupport {
    private final NestingSolver nestingSolver;

    GlobalPlanningSolverSupport(NestingSolver nestingSolver) {
        this.nestingSolver = Objects.requireNonNull(nestingSolver, "nestingSolver");
    }

    List<GlobalPlanningModels.RemnantSnapshot> rankRemnants(
            List<GlobalPlanningModels.RemnantSnapshot> remnants,
            List<GlobalPlanningModels.NormalizedDemand> demands
    ) {
        List<GlobalPlanningModels.RemnantSnapshot> ranked = new ArrayList<>(remnants);
        ranked.sort((a, b) -> {
            // 1. 匹配度评分（能放下的需求行种数 + 无疵加分 + 幅宽贴合度）高者优先
            int scoreCmp = Double.compare(remnantMatchScore(b, demands), remnantMatchScore(a, demands));
            if (scoreCmp != 0) return scoreCmp;
            // 2. 同等匹配度下优先消纳较小可用面积的合适料头，避免切碎大块好料头
            int areaCmp = Double.compare(a.areaM2(), b.areaM2());
            if (areaCmp != 0) return areaCmp;
            return a.id().compareTo(b.id());
        });
        return ranked;
    }

    private double remnantMatchScore(
            GlobalPlanningModels.RemnantSnapshot rem,
            List<GlobalPlanningModels.NormalizedDemand> demands
    ) {
        int fitLines = 0;
        double bestWidthFit = 0.0;
        for (GlobalPlanningModels.NormalizedDemand d : demands) {
            boolean fitsNormal = d.width() <= rem.width() + 0.001 && d.length() <= rem.length() + 0.001;
            boolean fitsRot = d.allowRotation()
                    && d.length() <= rem.width() + 0.001 && d.width() <= rem.length() + 0.001;
            if (fitsNormal || fitsRot) {
                fitLines++;
                double usedW = fitsNormal ? d.width() : d.length();
                double ratio = Math.min(1.0, usedW / rem.width());
                bestWidthFit = Math.max(bestWidthFit, ratio);
            }
        }
        if (fitLines == 0) return -1.0;
        double defectBonus = rem.hasDefect() ? 0.0 : 2.0;
        return fitLines * 10.0 + defectBonus + bestWidthFit;
    }

    GlobalPlanningModels.RollTrialOutcome evaluateRoll(
            GlobalPlanningModels.RollSnapshot roll,
            List<GlobalPlanningModels.NormalizedDemand> demands,
            int remainingTotal,
            boolean isContour,
            double pieceGapMm,
            double trimStartMm,
            int perRollSec,
            long deadlineNanos
    ) {
        double availLen = roll.availableLengthMm();
        if (availLen <= trimStartMm + 1.0 || !canFitAny(roll.width(), availLen - trimStartMm, demands, pieceGapMm)) {
            return new GlobalPlanningModels.RollTrialOutcome(
                    roll.rollId(), roll.width(), availLen, 0.0, Double.POSITIVE_INFINITY, 0.0, 0, false,
                    roll.startY(), roll.totalLength(), List.of(), List.of(),
                    roll.materialModel(), roll.batchNo(), roll.color()
            );
        }

        double totalDemandAreaMm2 = demands.stream().mapToDouble(d -> d.areaMm2() * d.quantity()).sum();
        double maxPieceDimL = demands.stream().mapToDouble(d -> minLengthOnRollWidth(d, roll.width())).max().orElse(0.0);
        double maxRawL = demands.stream().mapToDouble(d -> {
            if (d.allowRotation() && d.width() > roll.width() + 0.001 && d.length() <= roll.width() + 0.001) {
                return d.width();
            }
            return d.length();
        }).max().orElse(0.0);
        double sumPieceLen = demands.stream().mapToDouble(d -> (Math.max(d.length(), d.width()) + pieceGapMm) * d.quantity()).sum();

        double theoreticalMinLen = Math.max(trimStartMm + maxPieceDimL, trimStartMm + totalDemandAreaMm2 / roll.width());
        double initWindowLen = Math.min(availLen, Math.max(
                trimStartMm + maxRawL + pieceGapMm,
                Math.ceil((trimStartMm + (totalDemandAreaMm2 / roll.width()) * 1.30 + maxRawL * 0.5) / 10.0) * 10.0
        ));
        initWindowLen = Math.max(initWindowLen, Math.min(availLen, trimStartMm + maxPieceDimL + 10.0));

        NestingResult best = solveForMaterial(
                roll.rollId(), roll.width(), initWindowLen,
                DefectWindowSupport.sliceForWindow(roll.defects(), roll.startY(), initWindowLen, roll.width()),
                demands, isContour, false, pieceGapMm, trimStartMm, perRollSec
        );
        int bestPlaced = countPlaced(best);
        double bestCutLen = bestPlaced > 0 ? computeOccupiedLengthMm(best, demands, isContour, pieceGapMm, trimStartMm) : 0.0;

        // 若首次紧凑窗口未能全齐套且卷上还有剩余长度，自动扩大窗口重排一次
        if (bestPlaced < remainingTotal && initWindowLen < availLen - 1.0 && System.nanoTime() < deadlineNanos) {
            double expandedLen = Math.min(availLen, Math.max(initWindowLen * 2.0, trimStartMm + sumPieceLen + 500.0));
            NestingResult expanded = solveForMaterial(
                    roll.rollId(), roll.width(), expandedLen,
                    DefectWindowSupport.sliceForWindow(roll.defects(), roll.startY(), expandedLen, roll.width()),
                    demands, isContour, false, pieceGapMm, trimStartMm, perRollSec
            );
            int expPlaced = countPlaced(expanded);
            if (expPlaced > bestPlaced) {
                best = expanded;
                bestPlaced = expPlaced;
                bestCutLen = computeOccupiedLengthMm(expanded, demands, isContour, pieceGapMm, trimStartMm);
            }
        }

        // 若已全齐套，执行最多 2 次确定性二分缩长，精确比出不同门幅的最省料真实切长
        boolean feasible = bestPlaced >= remainingTotal;
        if (feasible && bestCutLen > theoreticalMinLen + 40.0) {
            double high = bestCutLen;
            double low = theoreticalMinLen;
            for (int iter = 0; iter < 2 && high - low > 30.0 && System.nanoTime() < deadlineNanos; iter++) {
                double mid = Math.floor((high + low) * 0.5 / 10.0) * 10.0;
                if (mid <= trimStartMm + 1.0 || mid >= high - 1.0) break;
                NestingResult trial = solveForMaterial(
                        roll.rollId(), roll.width(), mid,
                        DefectWindowSupport.sliceForWindow(roll.defects(), roll.startY(), mid, roll.width()),
                        demands, isContour, false, pieceGapMm, trimStartMm, 1
                );
                if (countPlaced(trial) >= remainingTotal) {
                    double trialLen = computeOccupiedLengthMm(trial, demands, isContour, pieceGapMm, trimStartMm);
                    if (trialLen < bestCutLen) {
                        best = trial;
                        bestCutLen = trialLen;
                    }
                    high = Math.min(mid, trialLen);
                } else {
                    low = mid;
                }
            }
        }

        if (bestPlaced <= 0 || bestCutLen <= 0 || best == null || best.placements() == null || best.placements().isEmpty()) {
            return new GlobalPlanningModels.RollTrialOutcome(
                    roll.rollId(), roll.width(), availLen, 0.0, Double.POSITIVE_INFINITY, 0.0, 0, false,
                    roll.startY(), roll.totalLength(), List.of(), List.of(),
                    roll.materialModel(), roll.batchNo(), roll.color()
            );
        }

        // 保留最优切长那次求解的真实排布坐标（按剩余需求限量做防御性守恒校验，绝不重复调用求解器）
        Map<Integer, GlobalPlanningModels.NormalizedDemand> demandById = new LinkedHashMap<>();
        Map<Integer, Integer> demandLimits = new LinkedHashMap<>();
        for (GlobalPlanningModels.NormalizedDemand d : demands) {
            demandById.put(d.id(), d);
            demandLimits.put(d.id(), d.quantity());
        }
        Map<Integer, Integer> seenCounts = new LinkedHashMap<>();
        List<NestingResult.Placement> acceptedRaw = new ArrayList<>(best.placements().size());
        for (NestingResult.Placement p : best.placements()) {
            int limit = demandLimits.getOrDefault(p.demandId(), 0);
            int cur = seenCounts.getOrDefault(p.demandId(), 0);
            if (cur < limit) {
                seenCounts.put(p.demandId(), cur + 1);
                acceptedRaw.add(p);
            }
        }
        List<GlobalPlanningModels.PlacementData> placements = toPlacementDataList(
                acceptedRaw, demandById, isContour, pieceGapMm, roll.width(), availLen
        );
        int finalPlaced = placements.size();
        if (finalPlaced <= 0) {
            return new GlobalPlanningModels.RollTrialOutcome(
                    roll.rollId(), roll.width(), availLen, 0.0, Double.POSITIVE_INFINITY, 0.0, 0, false,
                    roll.startY(), roll.totalLength(), List.of(), List.of(),
                    roll.materialModel(), roll.batchNo(), roll.color()
            );
        }

        double maxSnapEndY = trimStartMm;
        for (GlobalPlanningModels.PlacementData ps : placements) {
            maxSnapEndY = Math.max(maxSnapEndY, ps.y() + ps.l());
        }
        double finalCutLen = Math.min(availLen, Math.max(bestCutLen, GlobalPlanningModels.ceil1(maxSnapEndY)));
        boolean finalFeasible = finalPlaced >= remainingTotal;
        List<Defect> windowDefects = DefectWindowSupport.sliceForWindow(roll.defects(), roll.startY(), finalCutLen, roll.width());

        double placedAreaMm2 = computePlacedAreaMm2(acceptedRaw, demandById);
        double consumedAreaMm2 = roll.width() * finalCutLen;
        double utilPct = consumedAreaMm2 > 0 ? Math.min(100.0, placedAreaMm2 / consumedAreaMm2 * 100.0) : 0.0;
        return new GlobalPlanningModels.RollTrialOutcome(
                roll.rollId(),
                roll.width(),
                availLen,
                finalCutLen,
                consumedAreaMm2,
                utilPct,
                finalPlaced,
                finalFeasible,
                roll.startY(),
                roll.totalLength(),
                placements,
                windowDefects,
                roll.materialModel(),
                roll.batchNo(),
                roll.color()
        );
    }

    NestingResult solveForMaterial(
            String materialId,
            double width,
            double length,
            List<Defect> defects,
            List<GlobalPlanningModels.NormalizedDemand> demands,
            boolean isContour,
            boolean isRemnant,
            double pieceGapMm,
            double trimStartMm,
            int timeLimitSeconds
    ) {
        double matW = GlobalPlanningModels.floor1(width);
        double matL = GlobalPlanningModels.floor1(length);
        double effTrim = isRemnant ? 0.0 : GlobalPlanningModels.ceil1(Math.max(0.0, trimStartMm));
        double effGap = GlobalPlanningModels.ceil1(Math.max(0.0, pieceGapMm));
        if (demands.isEmpty() || matW <= 0 || matL <= 0 || (!isRemnant && effTrim >= matL)) {
            return NestingResult.failure("NO_SOLUTION_FOUND", "有效加工区不足", "auto", 0);
        }

        List<NestingProblem.Exclusion> exclusions = new ArrayList<>();
        for (Defect d : defects) {
            if (d == null || d.getW() <= 0 || d.getH() <= 0) continue;
            if (isContour) {
                double x = GlobalPlanningModels.floor1(Math.max(0.0, d.getX() - d.getMargin()));
                double y = GlobalPlanningModels.floor1(Math.max(0.0, d.getY() - d.getMargin()));
                double right = Math.min(matW, GlobalPlanningModels.ceil1(d.getX() + d.getW() + d.getMargin()));
                double bottom = Math.min(matL, GlobalPlanningModels.ceil1(d.getY() + d.getH() + d.getMargin()));
                double w = GlobalPlanningModels.round1(right - x);
                double h = GlobalPlanningModels.round1(bottom - y);
                if (w > 0 && h > 0 && x < matW && y < matL) {
                    exclusions.add(new NestingProblem.Exclusion(
                            exclusions.size() + 1, x, y,
                            NestingProblem.Shape.rectangle(w, h), 0.0
                    ));
                }
            } else {
                double x = GlobalPlanningModels.floor1(Math.max(0.0, d.getX()));
                double y = GlobalPlanningModels.floor1(Math.max(0.0, d.getY()));
                double right = Math.min(matW, GlobalPlanningModels.ceil1(d.getX() + d.getW()));
                double bottom = Math.min(matL, GlobalPlanningModels.ceil1(d.getY() + d.getH()));
                double w = GlobalPlanningModels.round1(right - x);
                double h = GlobalPlanningModels.round1(bottom - y);
                double margin = GlobalPlanningModels.ceil1(Math.max(0.0, d.getMargin()));
                if (w > 0 && h > 0 && x < matW && y < matL) {
                    exclusions.add(new NestingProblem.Exclusion(
                            exclusions.size() + 1,
                            x, y, NestingProblem.Shape.rectangle(w, h), margin,
                            d.getSeverity(), d.getAvoidanceStrategy()
                    ));
                }
            }
        }

        if (isContour) {
            if (effTrim > 0 && effTrim < matL) {
                exclusions.add(new NestingProblem.Exclusion(
                        exclusions.size() + 1, 0.0, 0.0,
                        NestingProblem.Shape.rectangle(matW, effTrim), 0.0
                ));
            }
            List<NestingProblem.Part> parts = demands.stream()
                    .map(d -> new NestingProblem.Part(
                            d.id(),
                            d.name(),
                            d.shape() != null ? d.shape()
                                    : NestingProblem.Shape.rectangle(GlobalPlanningModels.ceil1(d.width()), GlobalPlanningModels.ceil1(d.length())),
                            d.quantity(),
                            d.allowRotation(),
                            d.allowHalfTurn()
                    ))
                    .toList();
            NestingProblem problem = new NestingProblem(
                    "1", "mm",
                    new NestingProblem.Material(materialId, NestingProblem.Shape.rectangle(matW, matL), exclusions, false),
                    parts,
                    new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0.0, 0.0, 0.0, 0.0,
                            "MAXIMIZE_PIECE_AREA", effGap),
                    resolveAvailableEngine(true),
                    timeLimitSeconds
            );
            try {
                return nestingSolver.solve(problem, true);
            } catch (IllegalArgumentException rejected) {
                return NestingResult.failure("NO_SOLUTION_FOUND", rejected.getMessage(), "auto", 0);
            }
        }

        // 矩形直刀（GUILLOTINE）：参照 FabricSolveAdapter 通过扩边等价实现 pieceGapMm（统一保守量化至 0.1 mm）
        double pad = effGap > 0 ? effGap : 0.0;
        List<NestingProblem.Part> parts = demands.stream()
                .map(d -> new NestingProblem.Part(
                        d.id(),
                        d.name(),
                        NestingProblem.Shape.rectangle(
                                GlobalPlanningModels.round1(GlobalPlanningModels.ceil1(d.width()) + pad),
                                GlobalPlanningModels.round1(GlobalPlanningModels.ceil1(d.length()) + pad)),
                        d.quantity(),
                        d.allowRotation()
                ))
                .toList();
        NestingProblem.Material material = new NestingProblem.Material(
                materialId,
                NestingProblem.Shape.rectangle(GlobalPlanningModels.round1(matW + pad), GlobalPlanningModels.round1(matL + pad)),
                exclusions,
                !isRemnant
        );
        NestingProblem.Process process = new NestingProblem.Process(
                "GUILLOTINE",
                isRemnant ? "SHEET" : "CONTINUOUS",
                "right-top",
                "horizontal",
                effTrim,
                200.0,
                300.0,
                0.0,
                "MAXIMIZE_PIECE_AREA",
                0.0
        );
        NestingProblem problem = new NestingProblem("1", "mm", material, parts, process,
                resolveAvailableEngine(false), timeLimitSeconds);
        try {
            return nestingSolver.solve(problem, true);
        } catch (IllegalArgumentException rejected) {
            return NestingResult.failure("NO_SOLUTION_FOUND", rejected.getMessage(), "auto", 0);
        }
    }

    /** 严格通过 NestingSolver.capabilities() 选择已就绪的可用引擎，兼容原生就绪与纯 Java 降级环境。 */
    private String resolveAvailableEngine(boolean isContour) {
        var caps = nestingSolver.capabilities();
        if (caps == null || caps.isEmpty()) return "auto";
        String requiredMode = isContour ? "CONTOUR" : "GUILLOTINE";
        String preferred = isContour ? "deepnest" : "javaguillotine";
        String nativePreferred = isContour ? "packingsolver-irregular" : "packingsolver";
        String fallbackId = null;
        for (var cap : caps) {
            if (!cap.available() || cap.modes() == null || !cap.modes().contains(requiredMode)) continue;
            if (nativePreferred.equalsIgnoreCase(cap.id())) return cap.id();
            if (preferred.equalsIgnoreCase(cap.id())) fallbackId = cap.id();
            else if (fallbackId == null) fallbackId = cap.id();
        }
        return fallbackId != null ? fallbackId : "auto";
    }

    static List<GlobalPlanningModels.NormalizedDemand> currentRemainingDemands(
            List<GlobalPlanningModels.NormalizedDemand> base,
            Map<Integer, Integer> remainingQty
    ) {
        List<GlobalPlanningModels.NormalizedDemand> active = new ArrayList<>();
        for (GlobalPlanningModels.NormalizedDemand d : base) {
            int rem = remainingQty.getOrDefault(d.id(), 0);
            if (rem > 0) {
                active.add(new GlobalPlanningModels.NormalizedDemand(
                        d.id(), d.name(), d.width(), d.length(), rem,
                        d.allowRotation(), d.allowHalfTurn(), d.shape(), d.areaMm2(),
                        d.sourceTaskId(), d.sourceLineId()
                ));
            }
        }
        return active;
    }

    static double minLengthOnRollWidth(GlobalPlanningModels.NormalizedDemand d, double rollWidth) {
        if (!d.allowRotation()) {
            return d.length();
        }
        boolean fitsNormalW = d.width() <= rollWidth + 0.001;
        boolean fitsRotatedW = d.length() <= rollWidth + 0.001;
        if (fitsNormalW && fitsRotatedW) {
            return Math.min(d.length(), d.width());
        }
        if (fitsRotatedW) {
            return d.width();
        }
        return d.length();
    }

    static boolean canFitAny(
            double matW,
            double matL,
            List<GlobalPlanningModels.NormalizedDemand> demands,
            double pieceGapMm
    ) {
        if (matW <= 0 || matL <= 0) return false;
        for (GlobalPlanningModels.NormalizedDemand d : demands) {
            if (d.width() <= matW + 0.001 && d.length() <= matL + 0.001) return true;
            if (d.allowRotation() && d.length() <= matW + 0.001 && d.width() <= matL + 0.001) return true;
        }
        return false;
    }

    static int countPlaced(NestingResult result) {
        if (result == null || !result.feasible() || result.placements() == null) return 0;
        return result.placements().size();
    }

    static double computeOccupiedLengthMm(
            NestingResult result,
            List<GlobalPlanningModels.NormalizedDemand> demands,
            boolean isContour,
            double pieceGapMm,
            double trimStartMm
    ) {
        if (result == null || !result.feasible() || result.placements() == null || result.placements().isEmpty()) {
            return 0.0;
        }
        Map<Integer, GlobalPlanningModels.NormalizedDemand> map = new HashMap<>();
        for (GlobalPlanningModels.NormalizedDemand d : demands) map.put(d.id(), d);

        double maxEndY = trimStartMm;
        double pad = (!isContour && pieceGapMm > 0) ? pieceGapMm : 0.0;
        for (NestingResult.Placement p : result.placements()) {
            double h = p.shape() != null ? p.shape().height() : 0.0;
            if (pad > 0) {
                GlobalPlanningModels.NormalizedDemand d = map.get(p.demandId());
                if (d != null) {
                    boolean rotated = (p.rotationDegrees() % 180) != 0;
                    h = rotated ? d.width() : d.length();
                } else {
                    h = Math.max(0.0, h - pad);
                }
            }
            maxEndY = Math.max(maxEndY, p.y() + h);
        }
        return maxEndY;
    }

    static double computePlacedAreaMm2(
            List<NestingResult.Placement> placements,
            Map<Integer, GlobalPlanningModels.NormalizedDemand> demandById
    ) {
        if (placements == null || placements.isEmpty()) return 0.0;
        double area = 0.0;
        for (NestingResult.Placement p : placements) {
            GlobalPlanningModels.NormalizedDemand d = demandById.get(p.demandId());
            if (d != null) {
                area += d.areaMm2();
            } else if (p.shape() != null) {
                area += p.shape().areaMm2();
            }
        }
        return area;
    }

    static List<GlobalPlanningModels.PlacementData> toPlacementDataList(
            List<NestingResult.Placement> rawPlacements,
            Map<Integer, GlobalPlanningModels.NormalizedDemand> demandById,
            boolean isContour,
            double pieceGapMm,
            double matW,
            double matL
    ) {
        if (rawPlacements == null || rawPlacements.isEmpty()) {
            return List.of();
        }
        double pad = (!isContour && pieceGapMm > 0) ? GlobalPlanningModels.ceil1(pieceGapMm) : 0.0;
        double safeMatW = GlobalPlanningModels.floor1(matW);
        double safeMatL = GlobalPlanningModels.floor1(matL);
        List<GlobalPlanningModels.PlacementData> out = new ArrayList<>(rawPlacements.size());

        for (int idx = 0; idx < rawPlacements.size(); idx++) {
            NestingResult.Placement p = rawPlacements.get(idx);
            if (p == null) continue;
            GlobalPlanningModels.NormalizedDemand d = demandById.get(p.demandId());
            int normDeg = Math.floorMod(p.rotationDegrees(), 360);
            boolean rotated = (normDeg % 180) != 0;
            String name = GlobalPlanningModels.blankToNull(p.name()) != null
                    ? p.name().trim()
                    : (d != null ? d.name() : ("裁片 #" + p.demandId()));

            double w;
            double l;
            double x;
            double y;
            if (pad > 0) {
                if (d != null) {
                    w = GlobalPlanningModels.round1(rotated ? d.length() : d.width());
                    l = GlobalPlanningModels.round1(rotated ? d.width() : d.length());
                } else {
                    w = Math.max(0.1, GlobalPlanningModels.round1((p.shape() != null ? p.shape().width() : 0.0) - pad));
                    l = Math.max(0.1, GlobalPlanningModels.round1((p.shape() != null ? p.shape().height() : 0.0) - pad));
                }
                x = GlobalPlanningModels.round1(Math.max(0.0, Math.min(Math.max(0.0, safeMatW - w), p.x())));
                y = GlobalPlanningModels.round1(Math.max(0.0, Math.min(Math.max(0.0, safeMatL - l), p.y())));
            } else {
                w = GlobalPlanningModels.round1(p.shape() != null
                        ? p.shape().width()
                        : (d != null ? (rotated ? d.length() : d.width()) : 0.0));
                l = GlobalPlanningModels.round1(p.shape() != null
                        ? p.shape().height()
                        : (d != null ? (rotated ? d.width() : d.length()) : 0.0));
                x = GlobalPlanningModels.round1(Math.max(0.0, p.x()));
                y = GlobalPlanningModels.round1(Math.max(0.0, p.y()));
            }

            List<NestingProblem.Point> polygon = null;
            if (p.shape() != null && "POLYGON".equals(p.shape().type()) && !p.shape().vertices().isEmpty()) {
                polygon = GlobalPlanningModels.sanitizePointRing(p.shape().vertices());
            }

            List<List<NestingProblem.Point>> holes = null;
            if (p.shape() != null && p.shape().hasHoles()) {
                holes = GlobalPlanningModels.sanitizeHoleRings(p.shape().holes());
            } else if (d != null && d.shape() != null && d.shape().hasHoles()) {
                NestingProblem.Shape rotatedSource = PolygonGeometry.rotate(d.shape(), normDeg);
                if (rotatedSource.hasHoles()) {
                    holes = GlobalPlanningModels.sanitizeHoleRings(rotatedSource.holes());
                }
            }

            out.add(new GlobalPlanningModels.PlacementData(
                    out.size() + 1,
                    p.demandId(),
                    name,
                    x,
                    y,
                    w,
                    l,
                    normDeg,
                    rotated,
                    polygon,
                    holes,
                    d != null ? d.sourceTaskId() : null,
                    d != null ? d.sourceLineId() : null
            ));
        }
        return List.copyOf(out);
    }
}
