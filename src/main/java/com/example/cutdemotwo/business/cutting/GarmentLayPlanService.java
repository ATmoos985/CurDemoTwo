package com.example.cutdemotwo.business.cutting;

import org.springframework.stereotype.Service;

import java.util.*;

/**
 * 服装订单颜色×尺码多床自动分床服务（Cut Plan / Lay Planning，纯计算零库存读写）：
 * <p>采用「多策略整数配比贪心上界构造 + 确定性有界分支定界（Branch and Bound）精修」：
 * <ul>
 *   <li>严格守恒：对每个尺码保证 {@code sum(lay.plies * lay.ratio[size]) >= sizeQuantities[size]}；</li>
 *   <li>严格控超裁：总超裁比例不超过 {@code allowOvercutPct}（默认 0%，零超裁）；</li>
 *   <li>兼顾约束：每床铺布层数 {@code <= maxPliesPerLay}，每版总件数 {@code <= maxGarmentsPerMarker}，
 *       若给定裁床台长 {@code maxLayLengthMm}，则每床预估唛架长度严格满足 {@code <= maxLayLengthMm}；</li>
 *   <li>分层寻优：优先最小化床数（减少换版与铺床次数），其次最小化总用布面积（含端头拉布损耗）与超裁件数，最大化满层效率。</li>
 * </ul>
 */
@Service
public class GarmentLayPlanService {
    private static final double DEFAULT_END_ALLOWANCE_MM = 40.0;
    private static final double DEFAULT_UNIT_AREA_M2 = 1.45;
    private static final double DEFAULT_TARGET_UTILIZATION_PCT = 82.0;
    private static final double DEFAULT_ALLOW_OVERCUT_PCT = 0.0;
    private static final int MAX_BNB_NODES = 6000;
    private static final int MAX_BRANCHES_PER_NODE = 12;
    private static final long BNB_TIME_LIMIT_NANOS = 180_000_000L; // 180ms 确定性响应护栏

    // ==================== 请求与响应契约 ====================

    public record CutPlanRequest(
            String styleName,
            String colorName,
            double fabricWidthMm,
            int maxPliesPerLay,
            int maxGarmentsPerMarker,
            Double maxLayLengthMm,
            Double endAllowanceMm,
            Double grammageGsm,
            Map<String, Integer> sizeQuantities,
            Map<String, Double> sizeUnitAreaM2,
            Double defaultUnitAreaM2,
            Double targetUtilizationPct,
            Double allowOvercutPct
    ) {}

    public record LayItem(
            int layNo,
            int plies,
            Map<String, Integer> ratio,
            int garmentsPerMarker,
            int layGarments,
            double estimatedMarkerLengthMm,
            double fabricLengthM,
            double fabricAreaM2
    ) {}

    public record SizeAuditItem(
            String size,
            int ordered,
            int planned,
            int delta
    ) {}

    public record CutPlanResult(
            String styleName,
            String colorName,
            int totalOrderedGarments,
            int totalPlannedGarments,
            int overcutGarments,
            int layCount,
            int totalPlies,
            double totalFabricLengthM,
            double totalFabricAreaM2,
            double estimatedWeightKg,
            double averageEfficiencyPct,
            List<LayItem> lays,
            List<SizeAuditItem> sizeAudit
    ) {}

    // ==================== 内部求解模型 ====================

    private record LayCandidate(int plies, int[] ratio, int garmentsPerMarker, double markerLengthMm, double fabricLengthM, int covered, int overcut) {}

    private static final class SolverConfig {
        final String[] sizes;
        final int[] ordered;
        final double[] unitAreas;
        final int sizeCount;
        final int totalOrdered;
        final double fabricWidthMm;
        final int maxPlies;
        final int maxGarments;
        final double maxLayLengthMm; // <=0 表示不限制
        final double endAllowanceMm;
        final double targetUtilPct;
        final int maxOvercut;
        final int maxPossibleGarmentsPerMarker;
        final double minUnitArea;

        SolverConfig(String[] sizes, int[] ordered, double[] unitAreas, double fabricWidthMm,
                     int maxPlies, int maxGarments, double maxLayLengthMm, double endAllowanceMm,
                     double targetUtilPct, int maxOvercut) {
            this.sizes = sizes;
            this.ordered = ordered;
            this.unitAreas = unitAreas;
            this.sizeCount = sizes.length;
            int sum = 0;
            double minArea = Double.POSITIVE_INFINITY;
            for (int i = 0; i < sizes.length; i++) {
                sum += ordered[i];
                if (ordered[i] > 0) minArea = Math.min(minArea, unitAreas[i]);
            }
            this.totalOrdered = sum;
            this.fabricWidthMm = fabricWidthMm;
            this.maxPlies = maxPlies;
            this.maxGarments = maxGarments;
            this.maxLayLengthMm = maxLayLengthMm;
            this.endAllowanceMm = endAllowanceMm;
            this.targetUtilPct = targetUtilPct;
            this.maxOvercut = maxOvercut;
            this.minUnitArea = Double.isFinite(minArea) ? minArea : DEFAULT_UNIT_AREA_M2;
            if (maxLayLengthMm > 0) {
                double singleMinLen = estimateMarkerLengthMm(this.minUnitArea, 1, fabricWidthMm, targetUtilPct);
                int byLen = singleMinLen > 0 ? (int) Math.floor(maxLayLengthMm / Math.max(1e-6, estimateSingleMarginalLenMm(this.minUnitArea, fabricWidthMm, targetUtilPct))) : maxGarments;
                this.maxPossibleGarmentsPerMarker = Math.max(1, Math.min(maxGarments, Math.max(1, byLen)));
            } else {
                this.maxPossibleGarmentsPerMarker = maxGarments;
            }
        }

        double markerLengthMm(int[] ratio, int gpm) {
            double areaSum = 0.0;
            for (int i = 0; i < sizeCount; i++) {
                if (ratio[i] > 0) areaSum += ratio[i] * unitAreas[i];
            }
            return estimateMarkerLengthMm(areaSum, gpm, fabricWidthMm, targetUtilPct);
        }

        boolean fitsLength(int[] ratio, int gpm) {
            if (maxLayLengthMm <= 0) return true;
            return markerLengthMm(ratio, gpm) <= maxLayLengthMm + 1e-6;
        }
    }

    private static final class BestSolution {
        List<LayCandidate> lays;
        int layCount = Integer.MAX_VALUE;
        double totalFabricLengthM = Double.POSITIVE_INFINITY;
        int totalOvercut = Integer.MAX_VALUE;
        int totalPlies = Integer.MAX_VALUE;

        void consider(SolverConfig cfg, List<LayCandidate> candidate) {
            List<LayCandidate> merged = consolidateLays(cfg, candidate);
            int lc = merged.size();
            double len = 0.0;
            int ov = 0;
            int plies = 0;
            for (LayCandidate l : merged) {
                len += l.fabricLengthM();
                ov += l.overcut();
                plies += l.plies();
            }
            if (isBetter(lc, len, ov, plies)) {
                this.lays = new ArrayList<>(merged);
                this.layCount = lc;
                this.totalFabricLengthM = len;
                this.totalOvercut = ov;
                this.totalPlies = plies;
            }
        }

        private boolean isBetter(int lc, double len, int ov, int plies) {
            if (lc != this.layCount) return lc < this.layCount;
            if (Math.abs(len - this.totalFabricLengthM) > 1e-4) return len < this.totalFabricLengthM;
            if (ov != this.totalOvercut) return ov < this.totalOvercut;
            return plies < this.totalPlies;
        }
    }

    // ==================== 主入口 ====================

    public CutPlanResult generateCutPlan(CutPlanRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("服装分床请求不能为空");
        }
        if (!Double.isFinite(request.fabricWidthMm()) || request.fabricWidthMm() <= 0) {
            throw new IllegalArgumentException("有效门幅 fabricWidthMm 必须为正数");
        }
        if (request.maxPliesPerLay() < 1 || request.maxPliesPerLay() > 10000) {
            throw new IllegalArgumentException("单床最大铺布层数 maxPliesPerLay 必须在 1 至 10000 之间");
        }
        if (request.maxGarmentsPerMarker() < 1 || request.maxGarmentsPerMarker() > 100) {
            throw new IllegalArgumentException("单版最多件数 maxGarmentsPerMarker 必须在 1 至 100 之间");
        }
        double maxLayLen = request.maxLayLengthMm() == null ? 0.0 : request.maxLayLengthMm();
        if (!Double.isFinite(maxLayLen) || maxLayLen < 0) {
            throw new IllegalArgumentException("裁床最大台长 maxLayLengthMm 不能为负数");
        }
        double endAllowance = request.endAllowanceMm() == null ? DEFAULT_END_ALLOWANCE_MM : request.endAllowanceMm();
        if (!Double.isFinite(endAllowance) || endAllowance < 0 || endAllowance > 2000) {
            throw new IllegalArgumentException("拉布端头损耗 endAllowanceMm 应在 0 至 2000 mm 之间");
        }
        double grammage = request.grammageGsm() == null ? 0.0 : request.grammageGsm();
        if (!Double.isFinite(grammage) || grammage < 0) {
            throw new IllegalArgumentException("面料克重 grammageGsm 不能为负数");
        }
        double defaultUnitArea = request.defaultUnitAreaM2() == null ? DEFAULT_UNIT_AREA_M2 : request.defaultUnitAreaM2();
        if (!Double.isFinite(defaultUnitArea) || defaultUnitArea <= 0) {
            throw new IllegalArgumentException("默认单件净纸样面积 defaultUnitAreaM2 必须为正数");
        }
        double targetUtil = request.targetUtilizationPct() == null ? DEFAULT_TARGET_UTILIZATION_PCT : request.targetUtilizationPct();
        if (!Double.isFinite(targetUtil) || targetUtil <= 10.0 || targetUtil > 100.0) {
            throw new IllegalArgumentException("目标排料利用率 targetUtilizationPct 应在 (10, 100] 范围内");
        }
        double allowOvercutPct = request.allowOvercutPct() == null ? DEFAULT_ALLOW_OVERCUT_PCT : request.allowOvercutPct();
        if (!Double.isFinite(allowOvercutPct) || allowOvercutPct < 0.0 || allowOvercutPct > 50.0) {
            throw new IllegalArgumentException("允许超裁率 allowOvercutPct 应在 0 至 50 之间");
        }
        if (request.sizeQuantities() == null || request.sizeQuantities().isEmpty()) {
            throw new IllegalArgumentException("尺码数量表 sizeQuantities 不能为空");
        }

        // 保留输入尺码顺序
        List<String> sizeList = new ArrayList<>();
        List<Integer> qtyList = new ArrayList<>();
        List<Double> areaList = new ArrayList<>();
        int totalOrdered = 0;

        for (Map.Entry<String, Integer> entry : request.sizeQuantities().entrySet()) {
            String sz = entry.getKey() == null ? "" : entry.getKey().trim();
            if (sz.isEmpty()) throw new IllegalArgumentException("尺码名称不能为空");
            int q = entry.getValue() == null ? 0 : entry.getValue();
            if (q < 0) throw new IllegalArgumentException("尺码「" + sz + "」件数不能为负数");
            double unitArea = defaultUnitArea;
            if (request.sizeUnitAreaM2() != null && request.sizeUnitAreaM2().containsKey(entry.getKey())) {
                Double custom = request.sizeUnitAreaM2().get(entry.getKey());
                if (custom != null) {
                    if (!Double.isFinite(custom) || custom <= 0) {
                        throw new IllegalArgumentException("尺码「" + sz + "」单件面积必须为正数");
                    }
                    unitArea = custom;
                }
            }
            sizeList.add(sz);
            qtyList.add(q);
            areaList.add(unitArea);
            totalOrdered += q;
        }
        if (totalOrdered <= 0) {
            throw new IllegalArgumentException("订单总件数必须大于 0");
        }

        int n = sizeList.size();
        String[] sizes = sizeList.toArray(new String[0]);
        int[] ordered = new int[n];
        double[] unitAreas = new double[n];
        for (int i = 0; i < n; i++) {
            ordered[i] = qtyList.get(i);
            unitAreas[i] = areaList.get(i);
            if (ordered[i] > 0 && maxLayLen > 0) {
                int[] single = new int[n];
                single[i] = 1;
                double singleLen = estimateMarkerLengthMm(unitAreas[i], 1, request.fabricWidthMm(), targetUtil);
                if (singleLen > maxLayLen + 1e-6) {
                    throw new IllegalArgumentException(
                            "尺码「" + sizes[i] + "」单件预估唛架长度 " + round1(singleLen)
                                    + " mm 超过最大裁床台长 " + round1(maxLayLen) + " mm");
                }
            }
        }

        int maxOvercut = (int) Math.floor(totalOrdered * allowOvercutPct / 100.0 + 1e-9);
        SolverConfig cfg = new SolverConfig(
                sizes, ordered, unitAreas, request.fabricWidthMm(),
                request.maxPliesPerLay(), request.maxGarmentsPerMarker(),
                maxLayLen, endAllowance, targetUtil, maxOvercut
        );

        // 1. 先处理超大规模订单：如果理论最少床数超过 10 床，先确定性剥离整满床主干，保证毫秒级完成
        List<LayCandidate> prefixLays = new ArrayList<>();
        int[] workingRem = ordered.clone();
        int minLaysEst = lowerBoundLays(cfg, workingRem);
        if (minLaysEst > 10) {
            prefixLays.addAll(peelFullBulkLays(cfg, workingRem, 8));
        }

        // 2. 多策略贪心构解得到高质量初始上界
        BestSolution best = new BestSolution();
        best.consider(cfg, concat(prefixLays, greedyPlan(cfg, workingRem, cfg.maxOvercut, false)));
        best.consider(cfg, concat(prefixLays, greedyPlan(cfg, workingRem, cfg.maxOvercut, true)));
        if (cfg.maxOvercut > 0) {
            best.consider(cfg, concat(prefixLays, greedyPlan(cfg, workingRem, 0, false)));
        }

        // 3. 确定性有界分支定界精修（在节点与时间预算内寻找更少床数、更省布料的精确解）
        int[] nodesVisited = new int[]{0};
        long deadlineNanos = System.nanoTime() + BNB_TIME_LIMIT_NANOS;
        double prefixFabricLen = prefixLays.stream().mapToDouble(LayCandidate::fabricLengthM).sum();
        List<LayCandidate> currentPath = new ArrayList<>(prefixLays);
        branchAndBound(cfg, workingRem, cfg.maxOvercut, currentPath, prefixFabricLen, best, nodesVisited, deadlineNanos);

        // 4. 组装响应与尺码守恒核对
        return buildResult(request, cfg, best.lays, grammage);
    }

    // ==================== 确定性分支定界 + 贪心引擎 ====================

    private void branchAndBound(
            SolverConfig cfg,
            int[] rem,
            int remOvercut,
            List<LayCandidate> path,
            double currentFabricLenM,
            BestSolution best,
            int[] nodesVisited,
            long deadlineNanos
    ) {
        int remTotal = sum(rem);
        if (remTotal == 0) {
            best.consider(cfg, path);
            return;
        }
        int lb = lowerBoundLays(cfg, rem);
        if (path.size() + lb > best.layCount) {
            return;
        }
        // 如果床数已达当前最优，但仅算理想净面积折算米数都超过最优用布米数，剪枝
        if (path.size() + lb == best.layCount) {
            double remMinLenM = lowerBoundFabricLengthM(cfg, rem, lb);
            if (currentFabricLenM + remMinLenM > best.totalFabricLengthM + 1e-4) {
                return;
            }
        }
        if (nodesVisited[0] >= MAX_BNB_NODES || System.nanoTime() >= deadlineNanos) {
            return;
        }
        nodesVisited[0]++;

        List<LayCandidate> candidates = generateCandidates(cfg, rem, remOvercut, MAX_BRANCHES_PER_NODE);
        for (LayCandidate cand : candidates) {
            if (nodesVisited[0] >= MAX_BNB_NODES || System.nanoTime() >= deadlineNanos) {
                break;
            }
            int[] nextRem = new int[cfg.sizeCount];
            for (int i = 0; i < cfg.sizeCount; i++) {
                nextRem[i] = Math.max(0, rem[i] - cand.plies() * cand.ratio()[i]);
            }
            int nextRemTotal = sum(nextRem);
            int nextLb = nextRemTotal == 0 ? 0 : lowerBoundLays(cfg, nextRem);
            if (path.size() + 1 + nextLb > best.layCount) {
                continue;
            }
            path.add(cand);
            branchAndBound(cfg, nextRem, remOvercut - cand.overcut(), path,
                    currentFabricLenM + cand.fabricLengthM(), best, nodesVisited, deadlineNanos);
            path.remove(path.size() - 1);
        }
    }

    /** 超大订单主干剥离：保留至少 keepResidualLays 床的尾数空间交给分支定界精修。 */
    private List<LayCandidate> peelFullBulkLays(SolverConfig cfg, int[] rem, int keepResidualLays) {
        List<LayCandidate> peeled = new ArrayList<>();
        while (lowerBoundLays(cfg, rem) > keepResidualLays) {
            LayCandidate bestFull = buildRatioForPlies(cfg, rem, cfg.maxPlies, 0, false);
            if (bestFull == null || bestFull.covered() <= 0) break;
            // 仅在能够完整推进一层满床且剩余仍高于阈值时剥离
            peeled.add(bestFull);
            for (int i = 0; i < cfg.sizeCount; i++) {
                rem[i] = Math.max(0, rem[i] - bestFull.plies() * bestFull.ratio()[i]);
            }
            if (peeled.size() > 5000) break; // 防御性上限
        }
        return peeled;
    }

    private List<LayCandidate> greedyPlan(SolverConfig cfg, int[] initialRem, int maxOvercut, boolean proportionalMode) {
        int[] rem = initialRem.clone();
        int remOvercut = maxOvercut;
        List<LayCandidate> lays = new ArrayList<>();
        int guard = 0;
        while (sum(rem) > 0 && guard++ < 10000) {
            List<LayCandidate> cands = generateCandidates(cfg, rem, remOvercut, proportionalMode ? 8 : 16);
            LayCandidate chosen = null;
            if (proportionalMode) {
                LayCandidate prop = buildProportionalCandidate(cfg, rem);
                if (prop != null) chosen = prop;
            }
            if (chosen == null && !cands.isEmpty()) {
                chosen = cands.get(0);
            }
            if (chosen == null) {
                chosen = buildFallbackSingleLay(cfg, rem);
            }
            lays.add(chosen);
            for (int i = 0; i < cfg.sizeCount; i++) {
                rem[i] = Math.max(0, rem[i] - chosen.plies() * chosen.ratio()[i]);
            }
            remOvercut = Math.max(0, remOvercut - chosen.overcut());
        }
        return lays;
    }

    private List<LayCandidate> generateCandidates(SolverConfig cfg, int[] rem, int remOvercut, int limit) {
        TreeSet<Integer> plySet = new TreeSet<>(Comparator.reverseOrder());
        int maxRem = 0;
        for (int r : rem) maxRem = Math.max(maxRem, r);
        if (maxRem <= 0) return List.of();

        plySet.add(Math.min(cfg.maxPlies, maxRem));
        // 枚举每个尺码的整除断点层数（保证能发现类似 150 = 50*3 的单床精确整除解）
        for (int r : rem) {
            if (r <= 0) continue;
            if (r <= cfg.maxPlies) plySet.add(r);
            int maxK = Math.min(cfg.maxPossibleGarmentsPerMarker, r);
            for (int k = 1; k <= maxK; k++) {
                int pFloor = Math.min(cfg.maxPlies, r / k);
                if (pFloor >= 1) plySet.add(pFloor);
                if (remOvercut > 0) {
                    int pCeil = Math.min(cfg.maxPlies, (r + k - 1) / k);
                    if (pCeil >= 1) plySet.add(pCeil);
                }
            }
        }
        // 加入常见整十/满层半层锚点
        if (cfg.maxPlies > 1) {
            plySet.add(Math.max(1, cfg.maxPlies / 2));
        }

        Map<String, LayCandidate> unique = new LinkedHashMap<>();
        int remTotal = sum(rem);
        for (int p : plySet) {
            LayCandidate exact = buildRatioForPlies(cfg, rem, p, 0, false);
            if (exact != null) {
                unique.putIfAbsent(candidateKey(exact), exact);
            }
            if (remOvercut > 0) {
                LayCandidate withOver = buildRatioForPlies(cfg, rem, p, remOvercut, true);
                if (withOver != null) {
                    unique.putIfAbsent(candidateKey(withOver), withOver);
                }
            }
            // 若只剩一床就能清空，优先尝试清尾配比
            if (p <= cfg.maxPlies && remTotal <= p * cfg.maxPossibleGarmentsPerMarker) {
                LayCandidate finish = buildFinishAllCandidate(cfg, rem, p, remOvercut);
                if (finish != null) {
                    unique.putIfAbsent(candidateKey(finish), finish);
                }
            }
        }

        LayCandidate prop = buildProportionalCandidate(cfg, rem);
        if (prop != null) {
            unique.putIfAbsent(candidateKey(prop), prop);
        }

        List<LayCandidate> list = new ArrayList<>(unique.values());
        list.sort((a, b) -> {
            // 优先一步清零的方案
            boolean aClears = a.covered() >= remTotal;
            boolean bClears = b.covered() >= remTotal;
            if (aClears != bClears) return aClears ? -1 : 1;
            // 比较覆盖后的理论剩余床数下界
            int aRemLb = lowerBoundLaysAfter(cfg, rem, a);
            int bRemLb = lowerBoundLaysAfter(cfg, rem, b);
            if (aRemLb != bRemLb) return Integer.compare(aRemLb, bRemLb);
            // 优先覆盖更多有效需求件数
            if (a.covered() != b.covered()) return Integer.compare(b.covered(), a.covered());
            // 优先单位件数耗布更低（满层更少端头浪费）
            double aPerPiece = a.fabricLengthM() / Math.max(1, a.covered());
            double bPerPiece = b.fabricLengthM() / Math.max(1, b.covered());
            if (Math.abs(aPerPiece - bPerPiece) > 1e-6) return Double.compare(aPerPiece, bPerPiece);
            if (a.overcut() != b.overcut()) return Integer.compare(a.overcut(), b.overcut());
            return Integer.compare(b.plies(), a.plies());
        });

        if (list.size() > limit) {
            return list.subList(0, limit);
        }
        return list;
    }

    /** 给定层数 p，构造该层数下的最优整数配比（先塞满无超裁件，允许时再评估清尾超裁）。 */
    private LayCandidate buildRatioForPlies(SolverConfig cfg, int[] rem, int p, int allowOvercut, boolean tryOvercutFinish) {
        int[] ratio = new int[cfg.sizeCount];
        int gpm = 0;

        // 阶段1：不产生任何超裁，按剩余件数/可放份数优先填满配比
        Integer[] order = sortedSizeIndicesDesc(rem);
        // 轮询填充（先让有需求的尺码按最大整除份填充，保持台长与件数不超限）
        boolean progress = true;
        while (progress && gpm < cfg.maxGarments) {
            progress = false;
            int bestIdx = -1;
            int bestRemAfter = -1;
            for (int idx : order) {
                int already = ratio[idx] * p;
                int left = rem[idx] - already;
                if (left >= p) {
                    ratio[idx]++;
                    boolean fits = cfg.fitsLength(ratio, gpm + 1);
                    ratio[idx]--;
                    if (fits && left > bestRemAfter) {
                        bestRemAfter = left;
                        bestIdx = idx;
                    }
                }
            }
            if (bestIdx >= 0) {
                ratio[bestIdx]++;
                gpm++;
                progress = true;
            }
        }

        // 阶段2：如果允许超裁，尝试把尾数接近 p 的尺码凑整清尾（仅当超裁增量 <= 剩余额度）
        int usedOvercut = 0;
        if (tryOvercutFinish && allowOvercut > 0 && gpm < cfg.maxGarments) {
            while (gpm < cfg.maxGarments) {
                int bestIdx = -1;
                int bestNeedOver = Integer.MAX_VALUE;
                int bestRemLeft = -1;
                for (int i = 0; i < cfg.sizeCount; i++) {
                    int left = rem[i] - ratio[i] * p;
                    if (left > 0 && left < p) {
                        int needOver = p - left;
                        if (usedOvercut + needOver <= allowOvercut) {
                            ratio[i]++;
                            boolean fits = cfg.fitsLength(ratio, gpm + 1);
                            ratio[i]--;
                            if (fits && (needOver < bestNeedOver || (needOver == bestNeedOver && left > bestRemLeft))) {
                                bestNeedOver = needOver;
                                bestRemLeft = left;
                                bestIdx = i;
                            }
                        }
                    }
                }
                if (bestIdx < 0) break;
                ratio[bestIdx]++;
                gpm++;
                usedOvercut += bestNeedOver;
            }
        }

        if (gpm == 0) return null;
        return buildCandidate(cfg, rem, p, ratio, gpm);
    }

    /** 尝试用层数 p 一次性覆盖全部剩余尺码（如果件数、台长和超裁均在允许范围内）。 */
    private LayCandidate buildFinishAllCandidate(SolverConfig cfg, int[] rem, int p, int remOvercut) {
        int[] ratio = new int[cfg.sizeCount];
        int gpm = 0;
        int overcut = 0;
        for (int i = 0; i < cfg.sizeCount; i++) {
            if (rem[i] <= 0) continue;
            int r = (rem[i] + p - 1) / p;
            ratio[i] = r;
            gpm += r;
            overcut += r * p - rem[i];
            if (gpm > cfg.maxGarments || overcut > remOvercut) return null;
        }
        if (gpm == 0 || !cfg.fitsLength(ratio, gpm)) return null;
        return buildCandidate(cfg, rem, p, ratio, gpm);
    }

    /** 按剩余需求比例分配单版配比，并反推最大无超裁铺布层数。 */
    private LayCandidate buildProportionalCandidate(SolverConfig cfg, int[] rem) {
        int total = sum(rem);
        if (total <= 0) return null;
        int targetGpm = Math.min(cfg.maxPossibleGarmentsPerMarker, total);
        int[] ratio = new int[cfg.sizeCount];
        int gpm = 0;

        // 先按比例向下取整
        double[] frac = new double[cfg.sizeCount];
        for (int i = 0; i < cfg.sizeCount; i++) {
            if (rem[i] <= 0) continue;
            double exact = (double) rem[i] / total * targetGpm;
            int base = (int) Math.floor(exact);
            if (base > rem[i]) base = rem[i];
            ratio[i] = base;
            gpm += base;
            frac[i] = exact - base;
        }

        // 若因向下取整超出台长，递减最大面积尺码直至合规
        while (gpm > 0 && !cfg.fitsLength(ratio, gpm)) {
            int drop = -1;
            for (int i = 0; i < cfg.sizeCount; i++) {
                if (ratio[i] > 0 && (drop < 0 || cfg.unitAreas[i] > cfg.unitAreas[drop])) drop = i;
            }
            if (drop < 0) break;
            ratio[drop]--;
            gpm--;
        }

        // 用余数最大的尺码补足剩余空位
        while (gpm < cfg.maxGarments) {
            int pick = -1;
            for (int i = 0; i < cfg.sizeCount; i++) {
                if (rem[i] <= ratio[i]) continue;
                ratio[i]++;
                boolean fits = cfg.fitsLength(ratio, gpm + 1);
                ratio[i]--;
                if (!fits) continue;
                if (pick < 0 || frac[i] > frac[pick] || (Math.abs(frac[i] - frac[pick]) < 1e-9 && rem[i] > rem[pick])) {
                    pick = i;
                }
            }
            if (pick < 0) break;
            ratio[pick]++;
            gpm++;
            frac[pick] = -1.0;
        }
        if (gpm == 0) return null;

        int maxExactPlies = cfg.maxPlies;
        for (int i = 0; i < cfg.sizeCount; i++) {
            if (ratio[i] > 0) {
                maxExactPlies = Math.min(maxExactPlies, rem[i] / ratio[i]);
            }
        }
        if (maxExactPlies < 1) return null;
        return buildCandidate(cfg, rem, maxExactPlies, ratio, gpm);
    }

    private LayCandidate buildFallbackSingleLay(SolverConfig cfg, int[] rem) {
        int pick = -1;
        for (int i = 0; i < cfg.sizeCount; i++) {
            if (rem[i] > 0 && (pick < 0 || rem[i] > rem[pick])) pick = i;
        }
        int[] ratio = new int[cfg.sizeCount];
        ratio[pick] = 1;
        int plies = Math.min(cfg.maxPlies, rem[pick]);
        return buildCandidate(cfg, rem, plies, ratio, 1);
    }

    private LayCandidate buildCandidate(SolverConfig cfg, int[] rem, int plies, int[] ratio, int gpm) {
        int covered = 0;
        int overcut = 0;
        for (int i = 0; i < cfg.sizeCount; i++) {
            int prod = plies * ratio[i];
            covered += Math.min(rem[i], prod);
            overcut += Math.max(0, prod - rem[i]);
        }
        double markerLenMm = cfg.markerLengthMm(ratio, gpm);
        double fabricLenM = plies * (markerLenMm + cfg.endAllowanceMm) / 1000.0;
        return new LayCandidate(plies, ratio, gpm, markerLenMm, fabricLenM, covered, overcut);
    }

    private int lowerBoundLays(SolverConfig cfg, int[] rem) {
        int remTotal = sum(rem);
        if (remTotal <= 0) return 0;
        int maxPerLay = Math.max(1, cfg.maxPlies * cfg.maxPossibleGarmentsPerMarker);
        int byCount = (remTotal + maxPerLay - 1) / maxPerLay;
        if (cfg.maxLayLengthMm > 0) {
            double remArea = 0.0;
            for (int i = 0; i < cfg.sizeCount; i++) remArea += rem[i] * cfg.unitAreas[i];
            double maxUtil = Math.min(98.0, cfg.targetUtilPct + 2.0) / 100.0;
            double maxAreaPerMarker = (cfg.fabricWidthMm / 1000.0) * (cfg.maxLayLengthMm / 1000.0) * maxUtil;
            double maxAreaPerLay = Math.max(1e-6, maxAreaPerMarker * cfg.maxPlies);
            int byArea = (int) Math.ceil(remArea / maxAreaPerLay - 1e-9);
            return Math.max(byCount, byArea);
        }
        return byCount;
    }

    private int lowerBoundLaysAfter(SolverConfig cfg, int[] rem, LayCandidate cand) {
        int[] next = new int[cfg.sizeCount];
        for (int i = 0; i < cfg.sizeCount; i++) {
            next[i] = Math.max(0, rem[i] - cand.plies() * cand.ratio()[i]);
        }
        return lowerBoundLays(cfg, next);
    }

    private double lowerBoundFabricLengthM(SolverConfig cfg, int[] rem, int lbLays) {
        double remArea = 0.0;
        for (int i = 0; i < cfg.sizeCount; i++) remArea += rem[i] * cfg.unitAreas[i];
        double bestUtil = Math.min(98.0, cfg.targetUtilPct + 2.0) / 100.0;
        double netLenM = remArea / ((cfg.fabricWidthMm / 1000.0) * bestUtil);
        double minPlies = Math.ceil((double) sum(rem) / Math.max(1, cfg.maxPossibleGarmentsPerMarker));
        return netLenM + Math.max(lbLays, minPlies) * (cfg.endAllowanceMm / 1000.0);
    }

    // ==================== 结果合并与指标核算 ====================

    private static List<LayCandidate> consolidateLays(SolverConfig cfg, List<LayCandidate> raw) {
        List<LayCandidate> consolidated = new ArrayList<>();
        for (LayCandidate cand : raw) {
            boolean merged = false;
            for (int i = 0; i < consolidated.size(); i++) {
                LayCandidate ex = consolidated.get(i);
                if (Arrays.equals(ex.ratio(), cand.ratio()) && ex.plies() + cand.plies() <= cfg.maxPlies) {
                    int newPlies = ex.plies() + cand.plies();
                    double newFabLen = newPlies * (ex.markerLengthMm() + cfg.endAllowanceMm) / 1000.0;
                    consolidated.set(i, new LayCandidate(
                            newPlies, ex.ratio(), ex.garmentsPerMarker(), ex.markerLengthMm(),
                            newFabLen, ex.covered() + cand.covered(), ex.overcut() + cand.overcut()
                    ));
                    merged = true;
                    break;
                }
            }
            if (!merged) consolidated.add(cand);
        }
        return consolidated;
    }

    private CutPlanResult buildResult(CutPlanRequest req, SolverConfig cfg, List<LayCandidate> solution, double grammageGsm) {
        List<LayCandidate> consolidated = consolidateLays(cfg, solution);

        // 按铺布层数降序、单床件数降序排列，呈现规范车间裁床作业顺序
        consolidated.sort(Comparator
                .comparingInt(LayCandidate::plies).reversed()
                .thenComparing(Comparator.comparingInt((LayCandidate l) -> l.plies() * l.garmentsPerMarker()).reversed())
                .thenComparing(Comparator.comparingInt(LayCandidate::garmentsPerMarker).reversed()));

        int[] plannedBySize = new int[cfg.sizeCount];
        List<LayItem> lays = new ArrayList<>(consolidated.size());
        int totalPlies = 0;
        int totalPlanned = 0;
        double totalFabricLenM = 0.0;
        double totalFabricAreaM2 = 0.0;
        double totalNetPatternAreaM2 = 0.0;

        for (int idx = 0; idx < consolidated.size(); idx++) {
            LayCandidate c = consolidated.get(idx);
            Map<String, Integer> ratioMap = new LinkedHashMap<>();
            double markerPatternAreaM2 = 0.0;
            for (int s = 0; s < cfg.sizeCount; s++) {
                ratioMap.put(cfg.sizes[s], c.ratio()[s]);
                plannedBySize[s] += c.plies() * c.ratio()[s];
                markerPatternAreaM2 += c.ratio()[s] * cfg.unitAreas[s];
            }
            int layGarments = c.plies() * c.garmentsPerMarker();
            double fabLenM = c.plies() * (c.markerLengthMm() + cfg.endAllowanceMm) / 1000.0;
            double fabAreaM2 = fabLenM * (cfg.fabricWidthMm / 1000.0);

            totalPlies += c.plies();
            totalPlanned += layGarments;
            totalFabricLenM += fabLenM;
            totalFabricAreaM2 += fabAreaM2;
            totalNetPatternAreaM2 += c.plies() * markerPatternAreaM2;

            lays.add(new LayItem(
                    idx + 1,
                    c.plies(),
                    Collections.unmodifiableMap(ratioMap),
                    c.garmentsPerMarker(),
                    layGarments,
                    round1(c.markerLengthMm()),
                    round3(fabLenM),
                    round3(fabAreaM2)
            ));
        }

        List<SizeAuditItem> sizeAudit = new ArrayList<>(cfg.sizeCount);
        for (int s = 0; s < cfg.sizeCount; s++) {
            sizeAudit.add(new SizeAuditItem(
                    cfg.sizes[s],
                    cfg.ordered[s],
                    plannedBySize[s],
                    plannedBySize[s] - cfg.ordered[s]
            ));
        }

        int overcut = totalPlanned - cfg.totalOrdered;
        double estWeightKg = grammageGsm > 0 ? totalFabricAreaM2 * grammageGsm / 1000.0 : 0.0;
        double avgEffPct = totalFabricAreaM2 > 0
                ? Math.min(100.0, totalNetPatternAreaM2 / totalFabricAreaM2 * 100.0)
                : 0.0;

        return new CutPlanResult(
                req.styleName() == null || req.styleName().isBlank() ? "默认款式" : req.styleName().trim(),
                req.colorName() == null || req.colorName().isBlank() ? "默认色号" : req.colorName().trim(),
                cfg.totalOrdered,
                totalPlanned,
                overcut,
                lays.size(),
                totalPlies,
                round3(totalFabricLenM),
                round3(totalFabricAreaM2),
                round3(estWeightKg),
                round2(avgEffPct),
                List.copyOf(lays),
                List.copyOf(sizeAudit)
        );
    }

    // ==================== 唛架长度与辅助计算 ====================

    /**
     * 结合多件合排效率曲线估算唛架净长度：
     * 单件小版比目标基准略低（多缝隙难以嵌套），多件混码略优于基准，封顶在 [50%, 98%]。
     */
    private static double effectiveMarkerEfficiency(int garmentsPerMarker, double targetUtilPct) {
        double delta = garmentsPerMarker <= 1 ? -1.5 : Math.min(1.5, (garmentsPerMarker - 2) * 0.4);
        double pct = Math.max(50.0, Math.min(98.0, targetUtilPct + delta));
        return pct / 100.0;
    }

    private static double estimateMarkerLengthMm(double patternAreaSumM2, int gpm, double fabricWidthMm, double targetUtilPct) {
        if (patternAreaSumM2 <= 0 || gpm <= 0) return 0.0;
        double eff = effectiveMarkerEfficiency(gpm, targetUtilPct);
        return (patternAreaSumM2 / ((fabricWidthMm / 1000.0) * eff)) * 1000.0;
    }

    private static double estimateSingleMarginalLenMm(double unitAreaM2, double fabricWidthMm, double targetUtilPct) {
        double maxEff = Math.min(98.0, targetUtilPct + 1.5) / 100.0;
        return (unitAreaM2 / ((fabricWidthMm / 1000.0) * maxEff)) * 1000.0;
    }

    private static String candidateKey(LayCandidate c) {
        return c.plies() + ":" + Arrays.toString(c.ratio());
    }

    private static Integer[] sortedSizeIndicesDesc(int[] rem) {
        Integer[] idx = new Integer[rem.length];
        for (int i = 0; i < rem.length; i++) idx[i] = i;
        Arrays.sort(idx, (a, b) -> {
            int cmp = Integer.compare(rem[b], rem[a]);
            return cmp != 0 ? cmp : Integer.compare(a, b);
        });
        return idx;
    }

    private static List<LayCandidate> concat(List<LayCandidate> a, List<LayCandidate> b) {
        List<LayCandidate> out = new ArrayList<>(a.size() + b.size());
        out.addAll(a);
        out.addAll(b);
        return out;
    }

    private static int sum(int[] arr) {
        int s = 0;
        for (int v : arr) s += v;
        return s;
    }

    private static double round1(double v) {
        return Math.rint(v * 10.0) / 10.0;
    }

    private static double round2(double v) {
        return Math.rint(v * 100.0) / 100.0;
    }

    private static double round3(double v) {
        return Math.rint(v * 1000.0) / 1000.0;
    }
}
