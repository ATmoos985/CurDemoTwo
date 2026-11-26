package com.example.cutdemotwo.algorithm.nesting;

import java.util.Arrays;
import java.util.function.IntConsumer;
import java.util.function.IntPredicate;

/**
 * 扁平原始数组实现的零装箱二维 AABB-BVH 空间索引（包级私有）。
 *
 * <p>设计要点：
 * <ul>
 *   <li>全部节点坐标与拓扑结构采用扁平原始数组（{@code double[]} / {@code int[]}），构建与查询零装箱；</li>
 *   <li>小规模（{@code count <= LINEAR_THRESHOLD}）自动退化为紧凑线性循环，避免建树与栈遍历开销；</li>
 *   <li>自顶向下中位数划分构建，保证绝对确定性与平衡树深（{@code O(log N)}），查询使用固定长度显式整型栈非递归遍历；</li>
 *   <li>膨胀查询使用与 {@link ContourGeometrySupport#aabbOverlaps} 逐比特一致的边界判定公式，零漏报、零误报。</li>
 * </ul>
 */
final class AabbBvh {
    /** 小规模退化为紧凑线性循环的元素数量阈值。 */
    static final int LINEAR_THRESHOLD = 8;

    static final AabbBvh EMPTY = new AabbBvh(
            0, true, 0,
            new double[0], new double[0], new double[0], new double[0],
            new int[0], new int[0], new int[0]
    );

    private final int itemCount;
    private final boolean linear;
    private final int maxStackDepth;
    private final double[] minX;
    private final double[] minY;
    private final double[] maxX;
    private final double[] maxY;
    private final int[] left;
    private final int[] right;
    private final int[] itemIndex;

    private AabbBvh(int itemCount, boolean linear, int maxStackDepth,
                    double[] minX, double[] minY, double[] maxX, double[] maxY,
                    int[] left, int[] right, int[] itemIndex) {
        this.itemCount = itemCount;
        this.linear = linear;
        this.maxStackDepth = maxStackDepth;
        this.minX = minX;
        this.minY = minY;
        this.maxX = maxX;
        this.maxY = maxY;
        this.left = left;
        this.right = right;
        this.itemIndex = itemIndex;
    }

    /**
     * 自顶向下静态构建扁平 AABB-BVH。
     *
     * @param minX  各元素最小 X 数组
     * @param minY  各元素最小 Y 数组
     * @param maxX  各元素最大 X 数组
     * @param maxY  各元素最大 Y 数组
     * @param count 有效元素数量（取各数组前缀 {@code [0, count)}）
     */
    static AabbBvh build(double[] minX, double[] minY, double[] maxX, double[] maxY, int count) {
        if (count <= 0) {
            return EMPTY;
        }
        if (count <= LINEAR_THRESHOLD) {
            return new AabbBvh(
                    count, true, 0,
                    Arrays.copyOf(minX, count),
                    Arrays.copyOf(minY, count),
                    Arrays.copyOf(maxX, count),
                    Arrays.copyOf(maxY, count),
                    null, null, null
            );
        }

        int maxNodes = 2 * count - 1;
        double[] nodeMinX = new double[maxNodes];
        double[] nodeMinY = new double[maxNodes];
        double[] nodeMaxX = new double[maxNodes];
        double[] nodeMaxY = new double[maxNodes];
        int[] nodeLeft = new int[maxNodes];
        int[] nodeRight = new int[maxNodes];
        int[] nodeItem = new int[maxNodes];

        int[] order = new int[count];
        double[] cx = new double[count];
        double[] cy = new double[count];
        for (int i = 0; i < count; i++) {
            order[i] = i;
            cx[i] = (minX[i] + maxX[i]) * 0.5;
            cy[i] = (minY[i] + maxY[i]) * 0.5;
        }

        Builder builder = new Builder(minX, minY, maxX, maxY, cx, cy, order,
                nodeMinX, nodeMinY, nodeMaxX, nodeMaxY, nodeLeft, nodeRight, nodeItem);
        builder.buildNode(0, count, 1);

        // 平衡中位数切分的树深至多 ceil(log2(count)) + 2，显式栈深度取 maxDepth + 4 确保永不越界
        return new AabbBvh(
                count, false, builder.maxDepth + 4,
                nodeMinX, nodeMinY, nodeMaxX, nodeMaxY,
                nodeLeft, nodeRight, nodeItem
        );
    }

    int size() {
        return itemCount;
    }

    boolean isEmpty() {
        return itemCount == 0;
    }

    /** 精确 AABB 重叠查询，对每个命中的元素原始索引调用 {@code visitor}。 */
    void query(double qMinX, double qMinY, double qMaxX, double qMaxY, IntConsumer visitor) {
        queryExpanded(qMinX, qMinY, qMaxX, qMaxY, 0.0, visitor);
    }

    /**
     * 膨胀 AABB 重叠查询（边界判定与 {@link ContourGeometrySupport#aabbOverlaps} 完全一致）。
     * 对每个命中的元素原始索引调用 {@code visitor}。
     */
    void queryExpanded(double qMinX, double qMinY, double qMaxX, double qMaxY,
                       double margin, IntConsumer visitor) {
        if (itemCount == 0) {
            return;
        }
        if (linear) {
            for (int i = 0; i < itemCount; i++) {
                if (qMaxX >= minX[i] - margin && qMinX <= maxX[i] + margin
                        && qMaxY >= minY[i] - margin && qMinY <= maxY[i] + margin) {
                    visitor.accept(i);
                }
            }
            return;
        }

        if (!(qMaxX >= minX[0] - margin && qMinX <= maxX[0] + margin
                && qMaxY >= minY[0] - margin && qMinY <= maxY[0] + margin)) {
            return;
        }

        int[] stack = new int[maxStackDepth];
        int top = 0;
        stack[top++] = 0;

        while (top > 0) {
            int node = stack[--top];
            int item = itemIndex[node];
            if (item >= 0) {
                visitor.accept(item);
                continue;
            }
            int r = right[node];
            if (qMaxX >= minX[r] - margin && qMinX <= maxX[r] + margin
                    && qMaxY >= minY[r] - margin && qMinY <= maxY[r] + margin) {
                stack[top++] = r;
            }
            int l = left[node];
            if (qMaxX >= minX[l] - margin && qMinX <= maxX[l] + margin
                    && qMaxY >= minY[l] - margin && qMinY <= maxY[l] + margin) {
                stack[top++] = l;
            }
        }
    }

    /** 精确 AABB 重叠早停查询：一旦 {@code stopper.test(index)} 返回 {@code true} 立即终止并返回 {@code true}。 */
    boolean queryAny(double qMinX, double qMinY, double qMaxX, double qMaxY, IntPredicate stopper) {
        return queryAnyExpanded(qMinX, qMinY, qMaxX, qMaxY, 0.0, stopper);
    }

    /**
     * 膨胀 AABB 重叠早停查询：一旦 {@code stopper.test(index)} 返回 {@code true} 立即终止并返回 {@code true}。
     */
    boolean queryAnyExpanded(double qMinX, double qMinY, double qMaxX, double qMaxY,
                             double margin, IntPredicate stopper) {
        if (itemCount == 0) {
            return false;
        }
        if (linear) {
            for (int i = 0; i < itemCount; i++) {
                if (qMaxX >= minX[i] - margin && qMinX <= maxX[i] + margin
                        && qMaxY >= minY[i] - margin && qMinY <= maxY[i] + margin) {
                    if (stopper.test(i)) {
                        return true;
                    }
                }
            }
            return false;
        }

        if (!(qMaxX >= minX[0] - margin && qMinX <= maxX[0] + margin
                && qMaxY >= minY[0] - margin && qMinY <= maxY[0] + margin)) {
            return false;
        }

        int[] stack = new int[maxStackDepth];
        int top = 0;
        stack[top++] = 0;

        while (top > 0) {
            int node = stack[--top];
            int item = itemIndex[node];
            if (item >= 0) {
                if (stopper.test(item)) {
                    return true;
                }
                continue;
            }
            int r = right[node];
            if (qMaxX >= minX[r] - margin && qMinX <= maxX[r] + margin
                    && qMaxY >= minY[r] - margin && qMinY <= maxY[r] + margin) {
                stack[top++] = r;
            }
            int l = left[node];
            if (qMaxX >= minX[l] - margin && qMinX <= maxX[l] + margin
                    && qMaxY >= minY[l] - margin && qMinY <= maxY[l] + margin) {
                stack[top++] = l;
            }
        }
        return false;
    }

    private static final class Builder {
        private final double[] srcMinX, srcMinY, srcMaxX, srcMaxY;
        private final double[] cx, cy;
        private final int[] order;
        private final double[] nodeMinX, nodeMinY, nodeMaxX, nodeMaxY;
        private final int[] nodeLeft, nodeRight, nodeItem;
        private int nextNode = 0;
        private int maxDepth = 0;

        Builder(double[] srcMinX, double[] srcMinY, double[] srcMaxX, double[] srcMaxY,
                double[] cx, double[] cy, int[] order,
                double[] nodeMinX, double[] nodeMinY, double[] nodeMaxX, double[] nodeMaxY,
                int[] nodeLeft, int[] nodeRight, int[] nodeItem) {
            this.srcMinX = srcMinX;
            this.srcMinY = srcMinY;
            this.srcMaxX = srcMaxX;
            this.srcMaxY = srcMaxY;
            this.cx = cx;
            this.cy = cy;
            this.order = order;
            this.nodeMinX = nodeMinX;
            this.nodeMinY = nodeMinY;
            this.nodeMaxX = nodeMaxX;
            this.nodeMaxY = nodeMaxY;
            this.nodeLeft = nodeLeft;
            this.nodeRight = nodeRight;
            this.nodeItem = nodeItem;
        }

        int buildNode(int start, int end, int depth) {
            if (depth > maxDepth) {
                maxDepth = depth;
            }
            int nodeIdx = nextNode++;
            int span = end - start;
            if (span == 1) {
                int idx = order[start];
                nodeMinX[nodeIdx] = srcMinX[idx];
                nodeMinY[nodeIdx] = srcMinY[idx];
                nodeMaxX[nodeIdx] = srcMaxX[idx];
                nodeMaxY[nodeIdx] = srcMaxY[idx];
                nodeLeft[nodeIdx] = -1;
                nodeRight[nodeIdx] = -1;
                nodeItem[nodeIdx] = idx;
                return nodeIdx;
            }

            double cMinX = Double.POSITIVE_INFINITY, cMaxX = Double.NEGATIVE_INFINITY;
            double cMinY = Double.POSITIVE_INFINITY, cMaxY = Double.NEGATIVE_INFINITY;
            for (int i = start; i < end; i++) {
                int idx = order[i];
                double x = cx[idx];
                double y = cy[idx];
                if (x < cMinX) cMinX = x;
                if (x > cMaxX) cMaxX = x;
                if (y < cMinY) cMinY = y;
                if (y > cMaxY) cMaxY = y;
            }

            double[] axisKeys = (cMaxX - cMinX) >= (cMaxY - cMinY) ? cx : cy;
            int mid = (start + end) >>> 1;
            nthElement(start, end - 1, mid, axisKeys);

            int l = buildNode(start, mid, depth + 1);
            int r = buildNode(mid, end, depth + 1);

            nodeMinX[nodeIdx] = Math.min(nodeMinX[l], nodeMinX[r]);
            nodeMinY[nodeIdx] = Math.min(nodeMinY[l], nodeMinY[r]);
            nodeMaxX[nodeIdx] = Math.max(nodeMaxX[l], nodeMaxX[r]);
            nodeMaxY[nodeIdx] = Math.max(nodeMaxY[l], nodeMaxY[r]);
            nodeLeft[nodeIdx] = l;
            nodeRight[nodeIdx] = r;
            nodeItem[nodeIdx] = -1;
            return nodeIdx;
        }

        /**
         * 确定性快速选择（三数取中枢轴 + 原始索引二级打破平局），
         * 确保 {@code order[k]} 处于精确中位数位置且划分结果 100% 确定。
         */
        private void nthElement(int lo, int hi, int k, double[] keys) {
            while (lo < hi) {
                int mid = (lo + hi) >>> 1;
                if (less(order[mid], order[lo], keys)) swap(lo, mid);
                if (less(order[hi], order[lo], keys)) swap(lo, hi);
                if (less(order[mid], order[hi], keys)) swap(mid, hi);
                int pivotItem = order[hi];

                int store = lo;
                for (int i = lo; i < hi; i++) {
                    if (less(order[i], pivotItem, keys)) {
                        swap(store, i);
                        store++;
                    }
                }
                swap(store, hi);

                if (k == store) {
                    return;
                } else if (k < store) {
                    hi = store - 1;
                } else {
                    lo = store + 1;
                }
            }
        }

        private boolean less(int a, int b, double[] keys) {
            double ka = keys[a];
            double kb = keys[b];
            return ka < kb || (ka == kb && a < b);
        }

        private void swap(int i, int j) {
            int tmp = order[i];
            order[i] = order[j];
            order[j] = tmp;
        }
    }
}
