package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Exclusion;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Material;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Part;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Point;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Process;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.List;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 4A 单元测试：扁平 AabbBvh 等价性、压紧器 200 件扩容与 60/120/200 件耗时基准。
 */
class Phase4aSpatialIndexTests {

    @Test
    void bvhMatchesLinearScanAcrossSizesRandomTouchingAndExpandedQueries() {
        int[] sizes = {0, 1, 8, 9, 64, 200};
        double[] margins = {0.0, 1e-6, 0.001, 5.0};
        Random rng = new Random(20260401L);

        for (int n : sizes) {
            double[] minX = new double[n];
            double[] minY = new double[n];
            double[] maxX = new double[n];
            double[] maxY = new double[n];

            for (int i = 0; i < n; i++) {
                if (i % 7 == 0 && i > 0) {
                    // 刻意制造与前一个矩形精确边界接触的场景
                    minX[i] = maxX[i - 1];
                    minY[i] = minY[i - 1];
                    maxX[i] = minX[i] + 10.0 + rng.nextInt(40);
                    maxY[i] = minY[i] + 10.0 + rng.nextInt(40);
                } else if (i % 11 == 0 && i > 0) {
                    // 刻意制造完全重合矩形，检验中位数 tie-break 稳定性
                    minX[i] = minX[i - 1];
                    minY[i] = minY[i - 1];
                    maxX[i] = maxX[i - 1];
                    maxY[i] = maxY[i - 1];
                } else {
                    double x = rng.nextDouble() * 1000.0;
                    double y = rng.nextDouble() * 1000.0;
                    minX[i] = x;
                    minY[i] = y;
                    maxX[i] = x + 5.0 + rng.nextDouble() * 80.0;
                    maxY[i] = y + 5.0 + rng.nextDouble() * 80.0;
                }
            }

            AabbBvh bvh = AabbBvh.build(minX, minY, maxX, maxY, n);
            assertEquals(n, bvh.size());
            assertEquals(n == 0, bvh.isEmpty());

            // 构造随机查询框 + 精确贴边查询框
            for (int q = 0; q < 80; q++) {
                double qMinX, qMinY, qMaxX, qMaxY;
                if (q < n && q % 2 == 0) {
                    // 精确边界接触查询（右边紧贴第 q 个矩形左边界）
                    qMaxX = minX[q];
                    qMinX = qMaxX - 25.0;
                    qMinY = minY[q];
                    qMaxY = maxY[q];
                } else {
                    qMinX = rng.nextDouble() * 1050.0 - 25.0;
                    qMinY = rng.nextDouble() * 1050.0 - 25.0;
                    qMaxX = qMinX + rng.nextDouble() * 120.0;
                    qMaxY = qMinY + rng.nextDouble() * 120.0;
                }

                for (double margin : margins) {
                    BitSet expected = new BitSet(n);
                    for (int i = 0; i < n; i++) {
                        if (ContourGeometrySupport.aabbOverlaps(
                                qMinX, qMaxX, qMinY, qMaxY,
                                minX[i], maxX[i], minY[i], maxY[i], margin)) {
                            expected.set(i);
                        }
                    }

                    BitSet actual = new BitSet(n);
                    if (margin == 0.0) {
                        bvh.query(qMinX, qMinY, qMaxX, qMaxY, actual::set);
                    } else {
                        bvh.queryExpanded(qMinX, qMinY, qMaxX, qMaxY, margin, actual::set);
                    }
                    assertEquals(expected, actual,
                            "BVH 查询结果与线性扫描不一致: n=" + n + ", q=" + q + ", margin=" + margin);

                    // 验证 queryAny / queryAnyExpanded 早停短路语义
                    AtomicInteger visited = new AtomicInteger();
                    boolean any = (margin == 0.0)
                            ? bvh.queryAny(qMinX, qMinY, qMaxX, qMaxY, idx -> {
                                visited.incrementAndGet();
                                return true;
                            })
                            : bvh.queryAnyExpanded(qMinX, qMinY, qMaxX, qMaxY, margin, idx -> {
                                visited.incrementAndGet();
                                return true;
                            });
                    assertEquals(!expected.isEmpty(), any);
                    if (any) {
                        assertEquals(1, visited.get(), "早停查询命中首个目标后应立即终止");
                    } else {
                        assertEquals(0, visited.get());
                    }
                }
            }
        }
    }

    @Test
    void markerCompactorCompactsOver100IrregularPiecesAndEnforces200Cap() {
        // 构造 108 件异形梯形排样初始解（12 行 x 9 列，行间留 4mm 缝隙，验证 >80 件不再被跳过且成功压紧）
        Shape trapezoid = new Shape("POLYGON", 20, 12, List.of(
                new Point(0, 0), new Point(20, 0), new Point(17, 12), new Point(3, 12)
        ));
        int cols = 9;
        int rows = 12;
        int totalPieces = cols * rows; // 108 > 80
        double sheetW = cols * 22.0 + 10.0;
        double sheetH = rows * 18.0 + 40.0;

        List<Placement> seed = new ArrayList<>(totalPieces);
        int id = 1;
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                seed.add(new Placement(id++, 1, "trap", c * 22.0, r * 16.0 + 4.0, trapezoid, 0));
            }
        }

        NestingProblem problem = new NestingProblem(
                "1", "mm",
                new Material("cloth", Shape.rectangle(sheetW, sheetH), List.of(), false),
                List.of(new Part(1, "trap", trapezoid, totalPieces, false, true)),
                new Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA"),
                "auto", 10
        );

        assertTrue(MarkerCompactor.supports(problem, seed), "108 件应在 200 件压紧上限内");
        assertTrue(MarkerCompactor.supportsGapSearch(problem));

        double beforeLen = layoutLength(seed);
        List<Placement> compacted = MarkerCompactor.compact(problem, seed, System.nanoTime() + 3_000_000_000L);
        double afterLen = layoutLength(compacted);

        assertEquals(totalPieces, compacted.size());
        assertTrue(afterLen < beforeLen - 1.0,
                "108 件异形排样应被成功压紧: before=" + beforeLen + ", after=" + afterLen);

        EngineResult check = new EngineResult();
        check.setSuccess(true);
        check.setPlacements(compacted);
        assertNull(PolygonResultValidator.validate(problem, check), "压紧结果必须零容忍通过 PolygonResultValidator");

        // 超过 200 件上限（201 件）应受上限保护
        List<Placement> overCap = new ArrayList<>(201);
        for (int i = 0; i < 201; i++) {
            overCap.add(new Placement(i + 1, 1, "trap", (i % 10) * 21.0, (i / 10) * 13.0, trapezoid, 0));
        }
        assertFalse(MarkerCompactor.supports(problem, overCap), "超过 200 件应返回 supports=false");
    }

    @Test
    void axisMarkerCompactorCompactsOver100DensePolygonPieces() {
        // 构造顶点数 > 48 的高密多边形，强制走 AxisMarkerCompactor 路径，件数 105 (> 80)
        List<Point> denseVerts = new ArrayList<>(52);
        for (int i = 0; i <= 25; i++) {
            denseVerts.add(new Point(i * 0.8, 0.0));
        }
        for (int i = 25; i >= 0; i--) {
            denseVerts.add(new Point(i * 0.8, 10.0));
        }
        Shape denseShape = new Shape("POLYGON", 20.0, 10.0, denseVerts);

        int cols = 7;
        int rows = 15;
        int totalPieces = cols * rows; // 105 > 80
        double sheetW = cols * 22.0 + 10.0;
        double sheetH = rows * 16.0 + 40.0;

        List<Placement> seed = new ArrayList<>(totalPieces);
        int id = 1;
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                seed.add(new Placement(id++, 1, "dense", c * 22.0, r * 14.0 + 5.0, denseShape, 0));
            }
        }

        NestingProblem problem = new NestingProblem(
                "1", "mm",
                new Material("cloth", Shape.rectangle(sheetW, sheetH), List.of(), false),
                List.of(new Part(1, "dense", denseShape, totalPieces, false)),
                new Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA"),
                "auto", 10
        );

        assertTrue(MarkerCompactor.supports(problem, seed));
        assertFalse(MarkerCompactor.supportsGapSearch(problem), "高顶点数应走 AxisMarkerCompactor 路径");

        double beforeLen = layoutLength(seed);
        List<Placement> compacted = MarkerCompactor.compact(problem, seed, System.nanoTime() + 3_000_000_000L);
        double afterLen = layoutLength(compacted);

        assertEquals(totalPieces, compacted.size());
        assertTrue(afterLen < beforeLen - 1.0,
                "105 件高密多边形应由 AxisMarkerCompactor 成功压紧: before=" + beforeLen + ", after=" + afterLen);
        assertEquals(rows * 10.0, afterLen, 1e-4);

        EngineResult check = new EngineResult();
        check.setSuccess(true);
        check.setPlacements(compacted);
        assertNull(PolygonResultValidator.validate(problem, check));
    }

    @Test
    void benchmarkSpatialIndexAndValidatorAt60_120_200Pieces() {
        int[] counts = {60, 120, 200};
        Shape poly = new Shape("POLYGON", 30, 20, List.of(
                new Point(0, 0), new Point(30, 0), new Point(26, 20), new Point(4, 20)
        ));

        for (int count : counts) {
            int cols = 10;
            int rows = (count + cols - 1) / cols;
            double pitchX = 34.0;
            double pitchY = 24.0;
            double sheetW = cols * pitchX + 20.0;
            double sheetH = rows * pitchY + 20.0;

            double[] minX = new double[count];
            double[] minY = new double[count];
            double[] maxX = new double[count];
            double[] maxY = new double[count];
            List<Placement> placements = new ArrayList<>(count);

            for (int i = 0; i < count; i++) {
                double x = (i % cols) * pitchX;
                double y = (i / cols) * pitchY;
                minX[i] = x;
                minY[i] = y;
                maxX[i] = x + 30.0;
                maxY[i] = y + 20.0;
                placements.add(new Placement(i + 1, 1, "bench", x, y, poly, 0));
            }

            List<Exclusion> defects = List.of(
                    new Exclusion(1, sheetW - 15.0, sheetH - 15.0, Shape.rectangle(10, 10), 1.0)
            );
            NestingProblem problem = new NestingProblem(
                    "1", "mm",
                    new Material("cloth", Shape.rectangle(sheetW, sheetH), defects, false),
                    List.of(new Part(1, "bench", poly, count, false)),
                    new Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", 2.0),
                    "auto", 10
            );
            EngineResult engineResult = new EngineResult();
            engineResult.setSuccess(true);
            engineResult.setPlacements(placements);

            // 预热
            AabbBvh warmupBvh = AabbBvh.build(minX, minY, maxX, maxY, count);
            for (int i = 0; i < count; i++) {
                warmupBvh.queryExpanded(minX[i], minY[i], maxX[i], maxY[i], 2.001, idx -> {});
            }
            assertNull(PolygonResultValidator.validate(problem, engineResult));

            // 基准 1：BVH 构建 + 批量膨胀查询 vs 暴力线性查询（重复 200 轮消除计时抖动）
            int rounds = 200;
            long linearHits = 0;
            long t0 = System.nanoTime();
            for (int r = 0; r < rounds; r++) {
                for (int i = 0; i < count; i++) {
                    for (int j = i + 1; j < count; j++) {
                        if (ContourGeometrySupport.aabbOverlaps(
                                minX[i], maxX[i], minY[i], maxY[i],
                                minX[j], maxX[j], minY[j], maxY[j], 2.001)) {
                            linearHits++;
                        }
                    }
                }
            }
            long linearNanos = System.nanoTime() - t0;

            long[] bvhHits = {0};
            long t1 = System.nanoTime();
            for (int r = 0; r < rounds; r++) {
                AabbBvh bvh = AabbBvh.build(minX, minY, maxX, maxY, count);
                for (int i = 0; i < count; i++) {
                    int self = i;
                    bvh.queryExpanded(minX[i], minY[i], maxX[i], maxY[i], 2.001, j -> {
                        if (j > self) bvhHits[0]++;
                    });
                }
            }
            long bvhNanos = System.nanoTime() - t1;
            assertEquals(linearHits, bvhHits[0], "基准测试中 BVH 与线性命中次数必须完全一致");

            // 基准 2：PolygonResultValidator 全流程校验（含 pieceGap = 2.0）
            long t2 = System.nanoTime();
            String err = PolygonResultValidator.validate(problem, engineResult);
            long validateNanos = System.nanoTime() - t2;
            assertNull(err);

            System.out.printf(
                    "[Phase4A-Benchmark] N=%3d | Linear(%d rounds)=%.2f ms | BVH(build+query, %d rounds)=%.2f ms | Validate(1x, gap=2mm)=%.2f ms | hits=%d%n",
                    count, rounds, linearNanos / 1_000_000.0, rounds, bvhNanos / 1_000_000.0,
                    validateNanos / 1_000_000.0, bvhHits[0]
            );
        }
    }

    private static double layoutLength(List<Placement> placements) {
        return placements.stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElse(0.0);
    }
}
