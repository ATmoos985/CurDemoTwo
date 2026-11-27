package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.algorithm.api.ToolpathOptimizer;
import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.CutStep;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.contracts.geometry.RemnantPiece;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;

import java.awt.geom.Area;
import java.awt.geom.Line2D;
import java.util.*;

/**
 * 排程方案 2D 几何校验、旋转许可审查、内孔洞透传与无副作用手调刀路重建协作者。
 */
final class StudioLayoutValidator {
    private final NestingSolver solverFactory;
    private final ToolpathOptimizer toolpathOptimizer;

    StudioLayoutValidator(NestingSolver solverFactory, ToolpathOptimizer toolpathOptimizer) {
        this.solverFactory = solverFactory;
        this.toolpathOptimizer = toolpathOptimizer;
    }

    /**
     * 虚拟母卷 2D 几何四重校验：
     * 1. 画布尺寸、修边 trimStartMm 与片间距 pieceGapMm 合法性；
     * 2. 每片坐标有限、尺寸正数、不越画布边界、不侵占卷头修边区 trimStartMm；
     * 3. 异形多边形轮廓合法性（PolygonGeometry.validate）；
     * 4. 两两裁片碰撞重叠与最小间距 pieceGapMm 真实校验（矩形 AABB + 异形布尔交集与多边形边距离）。
     */
    void validateVirtual2DGeometry(
            SchedulingScheme.Layout2DPayload layout,
            double widthMm,
            double heightMm,
            double trimStartMm,
            double pieceGapMm
    ) {
        List<String> errors = collect2DGeometryErrors(layout == null ? List.of() : layout.placements(), widthMm, heightMm, trimStartMm, pieceGapMm);
        if (!errors.isEmpty()) {
            throw new IllegalArgumentException(errors.get(0));
        }
    }

    /**
     * 无副作用手调几何校验与刀路/余料重建（纯计算只读，绝不写库存）：
     * 校验裁片越界、修边侵入、两两重叠、间距不足、疵点碰撞、旋转许可，合法时通过 NestingSolver / ToolpathOptimizer 重建刀路与余料。
     */
    Map<String, Object> validateManualLayout(
            CuttingStatePort.ReadView tx,
            StudioCommandContracts.ValidateLayoutInput req
    ) {
        List<String> errors = new ArrayList<>();
        if (req == null) {
            return invalidLayoutResult(List.of("校验请求体不能为空"));
        }
        double widthMm = req.materialWidthMm();
        double heightMm = req.materialLengthMm();
        double trimStartMm = Math.max(0.0, req.trimStartMm());
        double pieceGapMm = Math.max(0.0, req.pieceGapMm());
        boolean avoidDefects = req.avoidDefects() == null || req.avoidDefects();

        if (!Double.isFinite(widthMm) || widthMm <= 0 || !Double.isFinite(heightMm) || heightMm <= 0) {
            errors.add("材料幅宽与长度必须为有效正数");
        }
        if (!Double.isFinite(req.trimStartMm()) || req.trimStartMm() < 0 || (Double.isFinite(heightMm) && trimStartMm >= heightMm)) {
            errors.add("卷头修边长度不能为负且必须小于材料长度");
        }
        try {
            SolveRequest.validatePieceGap(pieceGapMm);
        } catch (IllegalArgumentException e) {
            errors.add(e.getMessage());
        }
        List<SchedulingScheme.PlacementItem> placements = req.placements() == null ? List.of() : req.placements();
        if (placements.isEmpty()) {
            errors.add("至少需要包含 1 件有效裁片");
        }
        if (!errors.isEmpty()) {
            return invalidLayoutResult(errors);
        }

        // 1. 解析真实材料与窗口疵点（只读）
        boolean remnantMode = req.remnantId() != null && !req.remnantId().isBlank();
        boolean rollMode = !remnantMode && req.rollId() != null && !req.rollId().isBlank();
        double windowStartY = req.windowStartY() != null && Double.isFinite(req.windowStartY()) ? Math.max(0.0, req.windowStartY()) : 0.0;
        List<Defect> effectiveDefects = new ArrayList<>();
        if (remnantMode) {
            Optional<RemnantStock> remOpt = tx.findRemnant(req.remnantId().trim());
            if (remOpt.isEmpty()) {
                errors.add("指定料头不存在: " + req.remnantId());
                return invalidLayoutResult(errors);
            }
            RemnantStock rem = remOpt.get();
            if (avoidDefects && rem.getDefects() != null) {
                effectiveDefects.addAll(DefectWindowSupport.sliceForWindow(rem.getDefects(), 0, heightMm, widthMm));
            }
        } else if (rollMode) {
            Optional<MotherRollInfo> rollOpt = tx.findRoll(req.rollId().trim());
            if (rollOpt.isEmpty()) {
                errors.add("指定母卷不存在: " + req.rollId());
                return invalidLayoutResult(errors);
            }
            MotherRollInfo roll = rollOpt.get();
            if (avoidDefects && roll.getDefects() != null) {
                effectiveDefects.addAll(DefectWindowSupport.sliceForWindow(roll.getDefects(), windowStartY, heightMm, widthMm));
            }
        } else if (avoidDefects && req.defects() != null) {
            effectiveDefects.addAll(DefectWindowSupport.sliceForWindow(req.defects(), 0, heightMm, widthMm));
        }

        // 2. 几何边界、修边、重叠、间距检查
        errors.addAll(collect2DGeometryErrors(placements, widthMm, heightMm, trimStartMm, pieceGapMm));

        // 3. 旋转许可与需求一致性检查
        Map<Integer, StudioCommandContracts.DemandLineView> demandMap = new LinkedHashMap<>();
        if (req.demands() != null) {
            int fallbackId = 1;
            for (StudioCommandContracts.DemandLineView d : req.demands()) {
                if (d == null) continue;
                int id = (d.id() != null && d.id() > 0) ? d.id() : fallbackId++;
                demandMap.put(id, d);
            }
        }

        boolean isContour = placements.stream().anyMatch(p -> p != null && p.shape() != null && "POLYGON".equals(p.shape().type()))
                || demandMap.values().stream().anyMatch(d -> d.shape() != null && "POLYGON".equals(d.shape().type()));

        for (SchedulingScheme.PlacementItem p : placements) {
            if (p == null) continue;
            StudioCommandContracts.DemandLineView dem = demandMap.get(p.demandId());
            if (dem != null) {
                double pw = p.shape() != null ? p.shape().width() : p.w();
                double pl = p.shape() != null ? p.shape().height() : p.l();
                try {
                    validatePlacementRotation(
                            dem.name() != null ? dem.name() : p.name(),
                            dem.width(), dem.length(),
                            Boolean.TRUE.equals(dem.allowRotation()),
                            dem.allowHalfTurn(),
                            p.rotationDegrees(), pw, pl, isContour
                    );
                } catch (IllegalArgumentException rotErr) {
                    errors.add(rotErr.getMessage());
                }
            }
        }

        // 4. 疵点碰撞检查
        if (avoidDefects && !effectiveDefects.isEmpty()) {
            for (SchedulingScheme.PlacementItem p : placements) {
                if (p == null) continue;
                NestingProblem.Shape shape = effectiveShape(p);
                if (shape == null) continue;
                boolean poly = "POLYGON".equals(shape.type());
                Area pieceArea = poly ? PolygonGeometry.region(shape, p.x(), p.y()) : null;
                for (Defect d : effectiveDefects) {
                    if ("PENETRABLE".equalsIgnoreCase(d.getAvoidanceStrategy())) continue;
                    double dx0 = Math.max(0, d.getX() - d.getMargin());
                    double dy0 = Math.max(0, d.getY() - d.getMargin());
                    double dx1 = Math.min(widthMm, d.getX() + d.getW() + d.getMargin());
                    double dy1 = Math.min(heightMm, d.getY() + d.getH() + d.getMargin());
                    if (dx1 <= dx0 || dy1 <= dy0) continue;
                    boolean hit;
                    if (!poly) {
                        hit = p.x() < dx1 - 0.001 && p.x() + shape.width() > dx0 + 0.001
                                && p.y() < dy1 - 0.001 && p.y() + shape.height() > dy0 + 0.001;
                    } else {
                        Area inter = new Area(pieceArea);
                        inter.intersect(PolygonGeometry.region(NestingProblem.Shape.rectangle(dx1 - dx0, dy1 - dy0), dx0, dy0));
                        hit = PolygonGeometry.area(inter) > 1e-3;
                    }
                    if (hit) {
                        errors.add("裁片「" + Objects.toString(p.name(), "#" + p.id()) + "」与疵点 #" + d.getId() + " 发生碰撞");
                    }
                }
            }
        }

        if (!errors.isEmpty()) {
            return invalidLayoutResult(errors);
        }

        // 5. 构造标准 SolveRequest 并通过 NestingSolver / ToolpathOptimizer 重建权威刀路与余料
        try {
            Map<Integer, Integer> countByDemand = new LinkedHashMap<>();
            Map<Integer, SchedulingScheme.PlacementItem> sampleByDemand = new LinkedHashMap<>();
            for (SchedulingScheme.PlacementItem p : placements) {
                countByDemand.merge(p.demandId(), 1, Integer::sum);
                sampleByDemand.putIfAbsent(p.demandId(), p);
            }

            List<PieceDemand> reqDemands = new ArrayList<>();
            for (Map.Entry<Integer, Integer> e : countByDemand.entrySet()) {
                int did = e.getKey();
                StudioCommandContracts.DemandLineView dem = demandMap.get(did);
                SchedulingScheme.PlacementItem sample = sampleByDemand.get(did);
                String name = dem != null && dem.name() != null && !dem.name().isBlank()
                        ? dem.name() : Objects.toString(sample.name(), "裁片#" + did);
                NestingProblem.Shape baseShape = dem != null && dem.shape() != null
                        ? dem.shape()
                        : (isContour ? effectiveShape(sample) : null);
                double dw = dem != null && dem.width() > 0 ? dem.width() : (baseShape != null ? baseShape.width() : sample.w());
                double dl = dem != null && dem.length() > 0 ? dem.length() : (baseShape != null ? baseShape.height() : sample.l());
                boolean allowRot = dem != null && Boolean.TRUE.equals(dem.allowRotation());
                PieceDemand pd = new PieceDemand(did, name, dw, dl, e.getValue(), allowRot);
                if (isContour) {
                    if (baseShape == null || !"POLYGON".equals(baseShape.type())) {
                        baseShape = new NestingProblem.Shape("POLYGON", dw, dl, List.of(
                                new NestingProblem.Point(0, 0),
                                new NestingProblem.Point(dw, 0),
                                new NestingProblem.Point(dw, dl),
                                new NestingProblem.Point(0, dl)
                        ));
                    }
                    pd.setShape(baseShape);
                    if (dem != null && dem.allowHalfTurn() != null) pd.setAllowHalfTurn(dem.allowHalfTurn());
                }
                reqDemands.add(pd);
            }

            List<PlacedPiece> placedPieces = new ArrayList<>();
            Set<Integer> usedIds = new HashSet<>();
            int nextPid = 1;
            for (SchedulingScheme.PlacementItem p : placements) {
                int pid = p.id();
                if (pid <= 0 || !usedIds.add(pid)) {
                    while (!usedIds.add(nextPid)) nextPid++;
                    pid = nextPid;
                }
                nextPid = Math.max(nextPid, pid + 1);
                int normDeg = Math.floorMod(p.rotationDegrees(), 360);
                if (isContour) {
                    NestingProblem.Shape placedShape = effectiveShape(p);
                    if (!"POLYGON".equals(placedShape.type())) {
                        placedShape = new NestingProblem.Shape("POLYGON", placedShape.width(), placedShape.height(), List.of(
                                new NestingProblem.Point(0, 0),
                                new NestingProblem.Point(placedShape.width(), 0),
                                new NestingProblem.Point(placedShape.width(), placedShape.height()),
                                new NestingProblem.Point(0, placedShape.height())
                        ));
                    }
                    PlacedPiece pp = new PlacedPiece(pid, Objects.toString(p.name(), "裁片#" + pid),
                            p.x(), p.y(), placedShape.width(), placedShape.height(), normDeg % 180 != 0, p.demandId());
                    pp.setShape(placedShape);
                    pp.setRotationDegrees(normDeg);
                    placedPieces.add(pp);
                } else {
                    StudioCommandContracts.DemandLineView dem = demandMap.get(p.demandId());
                    boolean rotated = (normDeg % 180 != 0)
                            || (dem != null && Math.abs(p.w() - dem.length()) < 0.01 && Math.abs(p.l() - dem.width()) < 0.01 && Math.abs(dem.width() - dem.length()) > 0.01);
                    double pw = dem != null ? (rotated ? dem.length() : dem.width()) : p.w();
                    double pl = dem != null ? (rotated ? dem.width() : dem.length()) : p.l();
                    placedPieces.add(new PlacedPiece(pid, Objects.toString(p.name(), "裁片#" + pid),
                            round1(p.x()), round1(p.y()), round1(pw), round1(pl), rotated, p.demandId()));
                }
            }

            SolveRequest solveReq = new SolveRequest();
            solveReq.setFeedPortType(remnantMode ? "remnant" : "roll");
            solveReq.setRollId(rollMode ? req.rollId().trim() : "VIRTUAL-VALIDATE");
            solveReq.setSourceRemnantId(remnantMode ? req.remnantId().trim() : null);
            solveReq.setRollW(widthMm);
            solveReq.setRollL(heightMm);
            solveReq.setTotalRollL(heightMm);
            solveReq.setWindowStartY(0);
            solveReq.setTrimStart(isContour ? 0 : trimStartMm);
            solveReq.setPieceGap(pieceGapMm);
            solveReq.setCutOrigin("left-top");
            solveReq.setFirstStageOrientation("horizontal");
            solveReq.setAllowLongitudinal(true);
            solveReq.setAllowRotation(!reqDemands.isEmpty() && reqDemands.stream().allMatch(PieceDemand::isAllowRotation));
            solveReq.setMinRemnantWidth(150);
            solveReq.setMinRemnantLength(150);
            solveReq.setTimeLimitSeconds(5);
            solveReq.setDemands(reqDemands);
            solveReq.setDefects(effectiveDefects);

            SolveResponse validated;
            if (isContour) {
                validated = FabricSolveAdapter.adjust(solverFactory, solveReq, placedPieces);
            } else {
                try {
                    validated = FabricSolveAdapter.adjust(solverFactory, solveReq, placedPieces);
                } catch (IllegalArgumentException horizErr) {
                    // 直刀布局若水平首刀无法贯通分割，尝试垂直首刀以支持合理手调
                    solveReq.setFirstStageOrientation("vertical");
                    try {
                        validated = FabricSolveAdapter.adjust(solverFactory, solveReq, placedPieces);
                    } catch (IllegalArgumentException vertErr) {
                        throw horizErr;
                    }
                }
            }

            if (!validated.isSuccess()) {
                return invalidLayoutResult(List.of(Objects.toString(validated.getMessage(), "手调布局未通过几何与刀路校验")));
            }

            List<CutStep> cutSteps = validated.getCuts() == null ? List.of() : validated.getCuts();
            if (!isContour && toolpathOptimizer != null && !cutSteps.isEmpty()) {
                cutSteps = toolpathOptimizer.optimizeAndChain(cutSteps, 0, 0, true);
            }

            List<Map<String, Object>> cutsOut = new ArrayList<>();
            int seq = 1;
            for (CutStep c : cutSteps) {
                String kind = "横切".equals(c.getType()) ? "HORIZONTAL"
                        : "纵切".equals(c.getType()) ? "VERTICAL"
                        : "CONTOUR";
                double sx = c.getStartX() != null ? c.getStartX() : ("HORIZONTAL".equals(kind) ? c.getStart() : c.getPos());
                double sy = c.getStartY() != null ? c.getStartY() : ("HORIZONTAL".equals(kind) ? c.getPos() : c.getStart());
                double ex = c.getEndX() != null ? c.getEndX() : ("HORIZONTAL".equals(kind) ? c.getEnd() : c.getPos());
                double ey = c.getEndY() != null ? c.getEndY() : ("HORIZONTAL".equals(kind) ? c.getPos() : c.getEnd());
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("sequence", seq++);
                row.put("kind", kind);
                row.put("startX", round1(sx));
                row.put("startY", round1(sy));
                row.put("endX", round1(ex));
                row.put("endY", round1(ey));
                if (c.getDesc() != null) row.put("description", c.getDesc());
                if (c.getAirDistance() != null) row.put("airDistanceMm", round1(c.getAirDistance()));
                row.put("stage", c.getStage());
                cutsOut.add(row);
            }

            List<Map<String, Object>> leftoversOut = new ArrayList<>();
            if (validated.getRemnants() != null) {
                for (RemnantPiece rm : validated.getRemnants()) {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("id", rm.getId());
                    item.put("x", round1(rm.getX()));
                    item.put("y", round1(rm.getY()));
                    item.put("w", round1(rm.getW()));
                    item.put("l", round1(rm.getL()));
                    item.put("hasDefect", rm.isHasDefect());
                    leftoversOut.add(item);
                }
            }

            Map<String, Object> ok = new LinkedHashMap<>();
            ok.put("feasible", true);
            ok.put("errors", List.of());
            ok.put("cuts", cutsOut);
            ok.put("leftovers", leftoversOut);
            return ok;
        } catch (IllegalArgumentException e) {
            return invalidLayoutResult(List.of(e.getMessage()));
        }
    }

    static void validatePlacementRotation(
            String pieceName,
            double lineW,
            double lineL,
            boolean allowRotation,
            Boolean allowHalfTurn,
            int rotationDegrees,
            double placedW,
            double placedL,
            boolean isContour
    ) {
        int normDeg = Math.floorMod(rotationDegrees, 360);
        if (isContour) {
            if (normDeg == 0) return;
            if (normDeg == 180) {
                if (!allowRotation && !Boolean.TRUE.equals(allowHalfTurn)) {
                    throw new IllegalArgumentException("裁片「" + pieceName + "」需求未允许 180° 掉头旋转，拒绝越权排布");
                }
                return;
            }
            if (!allowRotation) {
                throw new IllegalArgumentException("裁片「" + pieceName + "」需求禁止旋转（当前角度 " + normDeg + "°），拒绝越权排布");
            }
            return;
        }
        if (normDeg != 0 && normDeg != 90 && normDeg != 180 && normDeg != 270) {
            throw new IllegalArgumentException("矩形裁片「" + pieceName + "」仅支持正交旋转角度（当前 " + normDeg + "°）");
        }
        boolean swappedDims = Math.abs(placedW - lineL) < 0.01 && Math.abs(placedL - lineW) < 0.01 && Math.abs(lineW - lineL) > 0.01;
        boolean rotated90 = (normDeg % 180 != 0) || swappedDims;
        if (rotated90 && !allowRotation) {
            throw new IllegalArgumentException("裁片「" + pieceName + "」需求禁止 90° 旋转，拒绝越权排布");
        }
    }

    /**
     * 方案落库与物理物化时兜底透传内孔洞 {@code shape.holes}：
     * 若放置图形已自带孔洞则原样保留；若放置图形缺失孔洞但源需求行包含孔洞，
     * 按对应旋转角度同步旋转源需求图形并补回孔洞（外接尺寸匹配时），防止全链路任一环节丢失内孔。
     */
    static NestingProblem.Shape preserveLineHoles(
            NestingProblem.Shape placedShape,
            NestingProblem.Shape lineShape,
            int rotationDegrees
    ) {
        int normDeg = Math.floorMod(rotationDegrees, 360);
        if (placedShape == null) {
            if (lineShape == null) return null;
            return normDeg == 0 ? lineShape : PolygonGeometry.rotate(lineShape, normDeg);
        }
        if (placedShape.hasHoles() || lineShape == null || !lineShape.hasHoles()) {
            return placedShape;
        }
        NestingProblem.Shape rotated = normDeg == 0 ? lineShape : PolygonGeometry.rotate(lineShape, normDeg);
        if (Math.abs(rotated.width() - placedShape.width()) <= 0.25
                && Math.abs(rotated.height() - placedShape.height()) <= 0.25) {
            return new NestingProblem.Shape(
                    placedShape.type(),
                    placedShape.width(),
                    placedShape.height(),
                    placedShape.vertices(),
                    rotated.holes()
            );
        }
        return placedShape;
    }

    private List<String> collect2DGeometryErrors(
            List<SchedulingScheme.PlacementItem> placements,
            double widthMm,
            double heightMm,
            double trimStartMm,
            double pieceGapMm
    ) {
        List<String> errors = new ArrayList<>();
        if (!Double.isFinite(widthMm) || widthMm <= 0 || !Double.isFinite(heightMm) || heightMm <= 0) {
            errors.add("画布门幅与长度必须为正数");
            return errors;
        }
        if (!Double.isFinite(trimStartMm) || trimStartMm < 0 || trimStartMm >= heightMm) {
            errors.add("卷头修边长度无效或大于等于画布长度");
            return errors;
        }
        try {
            SolveRequest.validatePieceGap(pieceGapMm);
        } catch (IllegalArgumentException e) {
            errors.add(e.getMessage());
            return errors;
        }

        record GeomEntry(SchedulingScheme.PlacementItem item, NestingProblem.Shape shape, double x, double y, double w, double h,
                         boolean polygon, Area area, List<NestingProblem.Point> worldVerts) {}
        List<GeomEntry> validItems = new ArrayList<>();

        for (SchedulingScheme.PlacementItem p : placements) {
            if (p == null) {
                errors.add("存在空的裁片位置项");
                continue;
            }
            NestingProblem.Shape shape = effectiveShape(p);
            double pw = shape != null ? shape.width() : p.w();
            double ph = shape != null ? shape.height() : p.l();
            String label = Objects.toString(p.name(), "#" + p.id());

            if (!Double.isFinite(p.x()) || !Double.isFinite(p.y()) || !Double.isFinite(pw) || !Double.isFinite(ph) || pw <= 0 || ph <= 0) {
                errors.add("裁片「" + label + "」坐标或尺寸无效");
                continue;
            }
            boolean isPoly = shape != null && "POLYGON".equals(shape.type());
            if (isPoly) {
                try {
                    PolygonGeometry.validate(shape);
                } catch (RuntimeException polyErr) {
                    errors.add("裁片「" + label + "」轮廓无效：" + polyErr.getMessage());
                    continue;
                }
            }
            if (p.x() < -0.001 || p.x() + pw > widthMm + 0.001 || p.y() + ph > heightMm + 0.001) {
                errors.add("裁片「" + label + "」超出画布边界（" + round1(widthMm) + "×" + round1(heightMm) + "mm）");
            }
            if (p.y() < trimStartMm - 0.001) {
                errors.add("裁片「" + label + "」侵入卷头修边区（Y=" + round1(p.y()) + "mm < trimStart=" + round1(trimStartMm) + "mm）");
            }
            Area area = isPoly ? PolygonGeometry.region(shape, p.x(), p.y()) : null;
            List<NestingProblem.Point> worldVerts = isPoly
                    ? PolygonGeometry.vertices(shape).stream().map(v -> new NestingProblem.Point(v.x() + p.x(), v.y() + p.y())).toList()
                    : List.of(
                            new NestingProblem.Point(p.x(), p.y()),
                            new NestingProblem.Point(p.x() + pw, p.y()),
                            new NestingProblem.Point(p.x() + pw, p.y() + ph),
                            new NestingProblem.Point(p.x(), p.y() + ph)
                    );
            validItems.add(new GeomEntry(p, shape, p.x(), p.y(), pw, ph, isPoly, area, worldVerts));
        }

        // 两两碰撞与最小片间距检查
        for (int i = 0; i < validItems.size(); i++) {
            GeomEntry a = validItems.get(i);
            for (int j = i + 1; j < validItems.size(); j++) {
                GeomEntry b = validItems.get(j);
                boolean aabbGapHit = a.x + a.w + pieceGapMm > b.x + 0.001
                        && b.x + b.w + pieceGapMm > a.x + 0.001
                        && a.y + a.h + pieceGapMm > b.y + 0.001
                        && b.y + b.h + pieceGapMm > a.y + 0.001;
                if (!aabbGapHit) continue;

                String nameA = Objects.toString(a.item.name(), "#" + a.item.id());
                String nameB = Objects.toString(b.item.name(), "#" + b.item.id());
                if (!a.polygon && !b.polygon) {
                    boolean directOverlap = a.x + a.w > b.x + 0.001 && b.x + b.w > a.x + 0.001
                            && a.y + a.h > b.y + 0.001 && b.y + b.h > a.y + 0.001;
                    if (directOverlap) {
                        errors.add("裁片「" + nameA + "」与「" + nameB + "」发生几何重叠");
                    } else if (pieceGapMm > 0) {
                        errors.add("裁片「" + nameA + "」与「" + nameB + "」间距不足（须保留至少 " + round1(pieceGapMm) + "mm）");
                    }
                } else {
                    Area areaA = a.area != null ? a.area : PolygonGeometry.region(NestingProblem.Shape.rectangle(a.w, a.h), a.x, a.y);
                    Area areaB = b.area != null ? b.area : PolygonGeometry.region(NestingProblem.Shape.rectangle(b.w, b.h), b.x, b.y);
                    Area inter = new Area(areaA);
                    inter.intersect(areaB);
                    if (PolygonGeometry.area(inter) > 1e-3) {
                        errors.add("异形裁片「" + nameA + "」与「" + nameB + "」发生几何重叠");
                    } else if (pieceGapMm > 0) {
                        double minDist = minPolygonEdgeDistance(a.worldVerts, b.worldVerts);
                        if (minDist < pieceGapMm - 0.001) {
                            errors.add("异形裁片「" + nameA + "」与「" + nameB + "」间距不足（当前 " + round1(minDist)
                                    + "mm，须至少 " + round1(pieceGapMm) + "mm）");
                        }
                    }
                }
            }
        }
        return errors;
    }

    private static double minPolygonEdgeDistance(List<NestingProblem.Point> polyA, List<NestingProblem.Point> polyB) {
        double min = Double.POSITIVE_INFINITY;
        int nA = polyA.size();
        int nB = polyB.size();
        for (int i = 0; i < nA; i++) {
            NestingProblem.Point p = polyA.get(i);
            for (int j = 0; j < nB; j++) {
                NestingProblem.Point b1 = polyB.get(j);
                NestingProblem.Point b2 = polyB.get((j + 1) % nB);
                double d = Line2D.ptSegDist(b1.x(), b1.y(), b2.x(), b2.y(), p.x(), p.y());
                if (d < min) min = d;
            }
        }
        for (int j = 0; j < nB; j++) {
            NestingProblem.Point p = polyB.get(j);
            for (int i = 0; i < nA; i++) {
                NestingProblem.Point a1 = polyA.get(i);
                NestingProblem.Point a2 = polyA.get((i + 1) % nA);
                double d = Line2D.ptSegDist(a1.x(), a1.y(), a2.x(), a2.y(), p.x(), p.y());
                if (d < min) min = d;
            }
        }
        return min;
    }

    private static NestingProblem.Shape effectiveShape(SchedulingScheme.PlacementItem p) {
        if (p == null) return null;
        if (p.shape() != null) return p.shape();
        if (Double.isFinite(p.w()) && p.w() > 0 && Double.isFinite(p.l()) && p.l() > 0) {
            return NestingProblem.Shape.rectangle(p.w(), p.l());
        }
        return null;
    }

    private static Map<String, Object> invalidLayoutResult(List<String> errors) {
        Map<String, Object> res = new LinkedHashMap<>();
        res.put("feasible", false);
        res.put("errors", List.copyOf(errors));
        res.put("cuts", List.of());
        res.put("leftovers", List.of());
        return res;
    }

    private static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }
}
