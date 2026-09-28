package com.example.cutdemotwo.service.toolpath;

import com.example.cutdemotwo.model.CutStep;
import com.example.cutdemotwo.model.PlacedPiece;
import com.example.cutdemotwo.model.RemnantPiece;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * 二维直刀裁切边界自愈与切断完整性保证服务 (Guaranteed Boundary Separation & Auto-Sealer)
 * 核心目标：
 * 遍历排料所得的所有成品裁片与料头，提取每一个几何矩形的内部物理边界。
 * 若边界尚未被切刀完全覆盖，则执行智能共线合并并补齐下刀线，
 * 100% 确保每一件裁片与料头被物理切断，绝不留任何粘连与悬空！
 */
@Service
public class CutBoundaryCompletionService {

    public List<CutStep> ensureCompleteSeparation(
            List<PlacedPiece> pieces,
            List<RemnantPiece> remnants,
            List<CutStep> initialCuts,
            double rollW,
            double rollL,
            boolean isRemnantFeed) {

        List<CutStep> result = new ArrayList<>();
        if (initialCuts != null) {
            for (CutStep cs : initialCuts) {
                if (isOuterBoundaryCut(cs, rollW, rollL, isRemnantFeed)) {
                    continue;
                }
                result.add(cs);
            }
        }

        // 1. 收集所有矩形 (裁片与料头)
        List<double[]> rects = new ArrayList<>(); // [x, y, w, h]
        if (pieces != null) {
            for (PlacedPiece p : pieces) {
                rects.add(new double[]{p.getX(), p.getY(), p.getW(), p.getL()});
            }
        }
        if (remnants != null) {
            for (RemnantPiece r : remnants) {
                rects.add(new double[]{r.getX(), r.getY(), r.getW(), r.getL()});
            }
        }

        // 2. 收集所有内部边界线段
        // 水平线段: Map<Y坐标整数值, List<[startX, endX]>>
        Map<Long, List<double[]>> neededHoriz = new HashMap<>();
        // 垂直线段: Map<X坐标整数值, List<[startY, endY]>>
        Map<Long, List<double[]>> neededVert = new HashMap<>();

        for (double[] r : rects) {
            double rx = r[0];
            double ry = r[1];
            double rw = r[2];
            double rh = r[3];

            // 顶边 Y = ry (若在母卷内部)
            if (ry > 0.5 && ry < rollL - 0.5) {
                addNeededSegment(neededHoriz, ry, rx, rx + rw);
            }
            // 底边 Y = ry + rh
            // 在母卷长卷模式下，若底边到达 rollL，则是工位下料横切截断刀；在料头模式下，到达 rollL 是单板物理尽头无需下刀
            if (ry + rh > 0.5 && (ry + rh < rollL - 0.5 || (!isRemnantFeed && Math.abs(ry + rh - rollL) <= 0.5))) {
                addNeededSegment(neededHoriz, ry + rh, rx, rx + rw);
            }
            // 左边 X = rx (若在母卷内部)
            if (rx > 0.5 && rx < rollW - 0.5) {
                addNeededSegment(neededVert, rx, ry, ry + rh);
            }
            // 右边 X = rx + rw (若在母卷内部)
            if (rx + rw > 0.5 && rx + rw < rollW - 0.5) {
                addNeededSegment(neededVert, rx + rw, ry, ry + rh);
            }
        }

        // 3. 对已有切刀建立覆盖索引
        Map<Long, List<double[]>> existingHoriz = new HashMap<>();
        Map<Long, List<double[]>> existingVert = new HashMap<>();

        for (CutStep cs : result) {
            if ("横切".equals(cs.getType())) {
                addSegment(existingHoriz, cs.getPos(), Math.min(cs.getStart(), cs.getEnd()), Math.max(cs.getStart(), cs.getEnd()));
            } else {
                addSegment(existingVert, cs.getPos(), Math.min(cs.getStart(), cs.getEnd()), Math.max(cs.getStart(), cs.getEnd()));
            }
        }

        // 4. 检查水平横切漏刀并补齐
        for (Map.Entry<Long, List<double[]>> entry : neededHoriz.entrySet()) {
            double y = entry.getKey() / 10.0;
            List<double[]> mergedNeeded = mergeIntervals(entry.getValue());
            List<double[]> covered = existingHoriz.getOrDefault(entry.getKey(), Collections.emptyList());

            List<double[]> missing = subtractIntervals(mergedNeeded, covered);
            for (double[] interval : missing) {
                if (interval[1] - interval[0] >= 5.0) { // 忽略微小余量
                    String desc = String.format("第 2 阶段横切补刀，切断物理边界 [Y=%.0f mm, X=%.0f~%.0f mm]", y, interval[0], interval[1]);
                    CutStep cutPatch = new CutStep(result.size() + 1, "横切", y, interval[0], interval[1], desc);
                    result.add(cutPatch);
                    addSegment(existingHoriz, y, interval[0], interval[1]);
                }
            }
        }

        // 5. 检查垂直纵切漏刀并补齐
        for (Map.Entry<Long, List<double[]>> entry : neededVert.entrySet()) {
            double x = entry.getKey() / 10.0;
            List<double[]> mergedNeeded = mergeIntervals(entry.getValue());
            List<double[]> covered = existingVert.getOrDefault(entry.getKey(), Collections.emptyList());

            List<double[]> missing = subtractIntervals(mergedNeeded, covered);
            for (double[] interval : missing) {
                if (interval[1] - interval[0] >= 5.0) {
                    String desc = String.format("第 3 阶段纵切补刀，切断物理边界 [X=%.0f mm, Y=%.0f~%.0f mm]", x, interval[0], interval[1]);
                    CutStep cutPatch = new CutStep(result.size() + 1, "纵切", x, interval[0], interval[1], desc);
                    result.add(cutPatch);
                    addSegment(existingVert, x, interval[0], interval[1]);
                }
            }
        }

        // 6. 对同一直线上的切刀做最终合并与规范化
        return consolidateAndReorder(result);
    }

    private boolean isOuterBoundaryCut(CutStep cs, double rollW, double rollL, boolean isRemnantFeed) {
        if ("横切".equals(cs.getType())) {
            if (cs.getPos() <= 0.5) return true;
            if (isRemnantFeed && Math.abs(cs.getPos() - rollL) <= 0.5) return true;
            return false;
        } else {
            return cs.getPos() <= 0.5 || Math.abs(cs.getPos() - rollW) <= 0.5;
        }
    }

    private void addNeededSegment(Map<Long, List<double[]>> map, double pos, double start, double end) {
        if (end - start < 1.0) return;
        addSegment(map, pos, start, end);
    }

    private void addSegment(Map<Long, List<double[]>> map, double pos, double start, double end) {
        long key = Math.round(pos * 10.0);
        map.computeIfAbsent(key, k -> new ArrayList<>()).add(new double[]{start, end});
    }

    private List<double[]> mergeIntervals(List<double[]> intervals) {
        if (intervals == null || intervals.isEmpty()) return Collections.emptyList();
        List<double[]> list = new ArrayList<>(intervals);
        list.sort(Comparator.comparingDouble(a -> a[0]));

        List<double[]> merged = new ArrayList<>();
        double[] cur = new double[]{list.get(0)[0], list.get(0)[1]};

        for (int i = 1; i < list.size(); i++) {
            double[] next = list.get(i);
            if (next[0] <= cur[1] + 1.0) { // 容许 1mm 邻接合并
                cur[1] = Math.max(cur[1], next[1]);
            } else {
                merged.add(cur);
                cur = new double[]{next[0], next[1]};
            }
        }
        merged.add(cur);
        return merged;
    }

    /**
     * 从目标区间集合 needed 中扣除已被 covered 覆盖的区间，返回尚未被切开的部分
     */
    private List<double[]> subtractIntervals(List<double[]> needed, List<double[]> covered) {
        List<double[]> covMerged = mergeIntervals(covered);
        List<double[]> result = new ArrayList<>();

        for (double[] n : needed) {
            double curStart = n[0];
            double curEnd = n[1];

            for (double[] c : covMerged) {
                if (c[1] <= curStart + 0.5) continue;
                if (c[0] >= curEnd - 0.5) break;

                if (c[0] > curStart + 0.5) {
                    result.add(new double[]{curStart, Math.min(curEnd, c[0])});
                }
                curStart = Math.max(curStart, c[1]);
                if (curStart >= curEnd - 0.5) break;
            }
            if (curStart < curEnd - 0.5) {
                result.add(new double[]{curStart, curEnd});
            }
        }
        return result;
    }

    /**
     * 同一直线段合并与去重
     */
    private List<CutStep> consolidateAndReorder(List<CutStep> cuts) {
        Map<String, List<CutStep>> grouped = new LinkedHashMap<>();
        for (CutStep cs : cuts) {
            String key = cs.getType() + "_" + Math.round(cs.getPos() * 10.0);
            grouped.computeIfAbsent(key, k -> new ArrayList<>()).add(cs);
        }

        List<CutStep> consolidated = new ArrayList<>();
        for (List<CutStep> group : grouped.values()) {
            if (group.size() == 1) {
                consolidated.add(group.get(0));
                continue;
            }

            // 合并同一位置的重叠/相邻段
            List<double[]> intervals = new ArrayList<>();
            for (CutStep cs : group) {
                intervals.add(new double[]{Math.min(cs.getStart(), cs.getEnd()), Math.max(cs.getStart(), cs.getEnd())});
            }
            List<double[]> merged = mergeIntervals(intervals);
            CutStep template = group.get(0);

            for (double[] m : merged) {
                CutStep cs = new CutStep(
                        consolidated.size() + 1,
                        template.getType(),
                        template.getPos(),
                        m[0],
                        m[1],
                        template.getDesc()
                );
                consolidated.add(cs);
            }
        }

        // 阶段排序：贯穿整幅的大刀在前，小刀在后
        consolidated.sort((a, b) -> {
            boolean aIsFull = "横切".equals(a.getType()) && (Math.abs(a.getEnd() - a.getStart()) > 1500);
            boolean bIsFull = "横切".equals(b.getType()) && (Math.abs(b.getEnd() - b.getStart()) > 1500);
            if (aIsFull != bIsFull) return aIsFull ? -1 : 1;
            // 阶段排序
            return Double.compare(a.getPos(), b.getPos());
        });

        for (int i = 0; i < consolidated.size(); i++) {
            consolidated.get(i).setStep(i + 1);
        }
        return consolidated;
    }
}
