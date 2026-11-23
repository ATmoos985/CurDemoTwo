package com.example.cutdemotwo.algorithm.slitting;

import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingResult;
import com.example.cutdemotwo.contracts.slitting.SlittingValidation;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 真实一维分切算例精修模式（QUALITY）可复现基准测试。
 * 运行方式：
 * .\mvnw.cmd -Dtest=SlittingQualityBenchmarkTest -DrunSlittingBenchmark=true test
 */
@EnabledIfSystemProperty(named = "runSlittingBenchmark", matches = "true")
class SlittingQualityBenchmarkTest {

    record BenchmarkCase(String name, SlittingProblem problem) {}

    @Test
    void runRealSlittingQualityBenchmark() {
        List<BenchmarkCase> cases = realCases();
        String only = System.getProperty("benchmarkCase", "").trim();

        LinearSlittingSolverEngine engine = new LinearSlittingSolverEngine();
        try {
            System.out.println("\n==================== 1D SLITTING QUALITY BENCHMARK ====================");
            System.out.printf(Locale.ROOT,
                    "%-14s | %8s | %8s | %5s | %7s | %7s | %4s | %5s | %6s%n",
                    "Case", "E2E(ms)", "Kern(ms)", "Cars", "Util%", "Waste%", "Over", "Pats", "SeqGrp");
            System.out.println("---------------------------------------------------------------------------------------");

            for (BenchmarkCase bc : cases) {
                if (!only.isEmpty() && !bc.name().equalsIgnoreCase(only)) {
                    continue;
                }
                SlittingProblem problem = bc.problem();

                // 1. 端到端耗时（含进程隔离、通信、验收）
                long e2eStart = System.nanoTime();
                SlittingResult e2eResult = null;
                String e2eErr = null;
                try {
                    e2eResult = engine.solve(problem);
                } catch (Exception ex) {
                    e2eErr = ex.getClass().getSimpleName() + ": " + ex.getMessage();
                }
                long e2eMs = (System.nanoTime() - e2eStart) / 1_000_000L;

                // 2. 内核耗时（直接进程内调用 solveKernel）
                long kernStart = System.nanoTime();
                SlittingResult kernResult = null;
                String kernErr = null;
                try {
                    kernResult = LinearSlittingSolverEngine.solveKernel(problem);
                    SlittingValidation.validateResult(problem, kernResult);
                } catch (Exception ex) {
                    kernErr = ex.getClass().getSimpleName() + ": " + ex.getMessage();
                }
                long kernMs = (System.nanoTime() - kernStart) / 1_000_000L;

                SlittingResult displayResult = e2eResult != null ? e2eResult : kernResult;
                if (displayResult == null) {
                    System.out.printf(Locale.ROOT,
                            "%-14s | %8d | %8d | FAILED (e2e=%s, kern=%s)%n",
                            bc.name(), e2eMs, kernMs, e2eErr, kernErr);
                    continue;
                }
                if (e2eResult != null) {
                    SlittingValidation.validateResult(problem, e2eResult);
                    assertEquals("FEASIBLE", e2eResult.status(), bc.name() + " must be feasible");
                    assertTrue(e2eResult.fulfillment().stream().allMatch(f -> f.missing() == 0),
                            bc.name() + " must have zero missing");
                }

                int totalCars = displayResult.patterns().stream().mapToInt(SlittingResult.Pattern::repetitions).sum();
                double utilPct = displayResult.motherAreaMm2() > 0
                        ? (100.0 * displayResult.pieceAreaMm2() / displayResult.motherAreaMm2())
                        : 0.0;
                double wastePct = 100.0 - utilPct;
                int patternsCount = displayResult.patterns().size();
                int seqGroups = countSequenceGroups(displayResult);

                System.out.printf(Locale.ROOT,
                        "%-14s | %8d | %8d | %5d | %6.2f%% | %6.2f%% | %4d | %5d | %6d%s%n",
                        bc.name(), e2eMs, kernMs, totalCars, utilPct, wastePct,
                        displayResult.totalOverproduced(), patternsCount, seqGroups,
                        e2eErr != null ? " [E2E:" + e2eErr + "]" : "");
            }
            System.out.println("=======================================================================\n");
        } finally {
            closeIfAutoCloseable(engine);
        }
    }

    private static void closeIfAutoCloseable(Object engine) {
        if (engine instanceof AutoCloseable closeable) {
            try {
                closeable.close();
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * 统计连续相同花型（宽度组合）合并后的序号组数，以及总花型/排刀段数。
     * 在 SlittingResult 中每条 Pattern 代表一个已排好顺序的指令块（序号组）。
     */
    static int countSequenceGroups(SlittingResult result) {
        int groups = 0;
        String prevSig = null;
        for (SlittingResult.Pattern p : result.patterns()) {
            StringBuilder sig = new StringBuilder();
            sig.append(p.rollWidthMm()).append('|').append(p.lengthMm()).append('|').append(p.surfaceTreatment()).append('|');
            for (SlittingResult.Station s : p.stations()) {
                sig.append(s.widthMm()).append('x').append(s.countPerRepetition()).append(',');
            }
            sig.append('|');
            for (SlittingResult.Allocation a : p.allocations()) {
                sig.append(a.orderId()).append('=').append(a.quantity()).append(',');
            }
            String current = sig.toString();
            if (!current.equals(prevSig)) {
                groups++;
                prevSig = current;
            }
        }
        return groups;
    }

    static List<BenchmarkCase> realCases() {
        List<BenchmarkCase> list = new ArrayList<>();

        // 1. 薄膜 4 订单（linear-scenarios.js: film）
        list.add(new BenchmarkCase("film", new SlittingProblem(
                "1", "mm", 4600, 100, 100, 4200, 4400, 10, 30, "QUALITY",
                List.of(
                        order("客户甲", 1250, 6_000_000L, 18, "单面处理"),
                        order("客户乙", 1520, 6_000_000L, 14, "单面处理"),
                        order("客户丙", 1630, 6_000_000L, 10, "单面处理"),
                        order("客户丁", 1380, 6_000_000L, 12, "单面处理")
                ), 60)));

        // 2. 窗帘 4 订单（linear-scenarios.js: curtain）
        list.add(new BenchmarkCase("curtain", new SlittingProblem(
                "1", "mm", 2800, 20, 20, 2660, 2760, 10, 30, "QUALITY",
                List.of(
                        order("A 户型", 900, 50_000L, 20, "涂层"),
                        order("B 户型", 1200, 50_000L, 16, "涂层"),
                        order("C 户型", 1500, 50_000L, 12, "涂层"),
                        order("D 户型", 600, 50_000L, 30, "涂层")
                ), 60)));

        // 3. 板材 4 订单（linear-scenarios.js: board）
        list.add(new BenchmarkCase("board", new SlittingProblem(
                "1", "mm", 1220, 5, 5, 1180, 1210, 5, 30, "QUALITY",
                List.of(
                        order("抽屉侧条", 280, 2440L, 30, "三聚氰胺"),
                        order("隔板条", 420, 2440L, 20, "三聚氰胺"),
                        order("门框条", 560, 2440L, 14, "三聚氰胺"),
                        order("踢脚条", 350, 2440L, 24, "三聚氰胺")
                ), 60)));

        // 4. 真实反射膜 T10 17 单（linear-scenarios.js: film-t10-17）
        list.add(new BenchmarkCase("film-t10-17", new SlittingProblem(
                "1", "mm", 4600, 100, 100, 4200, 4400, 10, 30, "QUALITY",
                t1017Orders(), 90)));

        // 5. 真实反射膜 T29 50 单（linear-scenarios.js: film-t29-50）
        list.add(new BenchmarkCase("film-t29-50", new SlittingProblem(
                "1", "mm", 4600, 100, 100, 4200, 4400, 10, 30, "QUALITY",
                t2950Orders(), 120)));

        // 6. 真实反射膜 T29 85 单（linear-scenarios.js: film-t29-85）
        list.add(new BenchmarkCase("film-t29-85", new SlittingProblem(
                "1", "mm", 4600, 100, 100, 4200, 4400, 10, 30, "QUALITY",
                t2985Orders(), 120)));

        return list;
    }

    private static SlittingProblem.Order order(String id, int widthMm, long lengthMm, int qty, String surface) {
        return new SlittingProblem.Order(id, widthMm, lengthMm, qty, surface);
    }

    private static SlittingProblem.Order film1350(String id, int widthMm, int qty) {
        return new SlittingProblem.Order(id, widthMm, 1_350_000L, qty, "不电晕/不涂布");
    }

    static List<SlittingProblem.Order> t1017Orders() {
        return List.of(
                film1350("#1 诚誉兴光电 (30011984)", 860, 10),
                film1350("#2 广东瑞捷新材 (30011984)", 860, 80),
                film1350("#3 苏州世沃电子 (30011986)", 970, 40),
                film1350("#4 诚誉兴光电 (30012543)", 990, 20),
                film1350("#5 广东瑞捷新材 (30012543)", 990, 50),
                film1350("#6 深圳左臣光电 (30011987-DF188)", 1000, 4),
                film1350("#7 深圳左臣光电 (30011987)", 1000, 6),
                film1350("#8 广东瑞捷新材 (30011987-SDY188)", 1000, 50),
                film1350("#9 深圳金光宝光电 (30012521)", 1100, 30),
                film1350("#10 绵阳谷欣电子 (30016069)", 1120, 10),
                film1350("#11 诚誉兴光电 (30011989)", 1150, 20),
                film1350("#12 广东瑞捷新材 (30011989)", 1150, 100),
                film1350("#13 南京翰邦商贸 (30012351-CSY188)", 1260, 10),
                film1350("#14 广东瑞捷新材 (30011995)", 1270, 107),
                film1350("#15 苏州日日昇新材 (30020336)", 1320, 4),
                film1350("#16 诚誉兴光电 (30011996)", 1480, 20),
                film1350("#17 广东瑞捷新材 (30011996)", 1480, 30)
        );
    }

    static List<SlittingProblem.Order> t2950Orders() {
        return List.of(
                film1350("#1 奥智高分子越南 (30011866)", 730, 4),
                film1350("#2 诚誉兴光电 (30011866)", 730, 30),
                film1350("#3 广东轩朗实业 (30011868)", 750, 60),
                film1350("#4 Samsung (30020941)", 760, 84),
                film1350("#5 香港长阳/佛山群志 (30012550)", 790, 2),
                film1350("#6 Samsung (30016459)", 840, 120),
                film1350("#7 Samsung (30016458)", 840, 930),
                film1350("#8 奥智高分子越南 (30011872)", 850, 4),
                film1350("#9 Samsung (30012811)", 850, 66),
                film1350("#10 Samsung (30012805)", 850, 78),
                film1350("#11 诚誉兴光电 (30011873)", 860, 5),
                film1350("#12 Samsung (30016456)", 890, 33),
                film1350("#13 诚誉兴光电 (30012230)", 920, 20),
                film1350("#14 青岛卓英社 (30011877)", 930, 2),
                film1350("#15 Samsung (30012427)", 940, 4),
                film1350("#16 Samsung (30012234)", 970, 36),
                film1350("#17 Samsung (30011879)", 970, 240),
                film1350("#18 诚誉兴光电 (30012679)", 970, 10),
                film1350("#19 广东轩朗实业 (30012680)", 980, 90),
                film1350("#20 青岛卓英社 (30011881)", 990, 6),
                film1350("#21 Samsung (30012806)", 990, 110),
                film1350("#22 Samsung (30012800)", 990, 158),
                film1350("#23 诚誉兴光电 (30011881)", 990, 25),
                film1350("#24 Samsung (30016450)", 1000, 12),
                film1350("#25 Samsung (30016452)", 1000, 60),
                film1350("#26 香港长阳/佛山群志 (30012763)", 1030, 2),
                film1350("#27 Samsung (30020942)", 1090, 46),
                film1350("#28 Samsung (30017109)", 1090, 80),
                film1350("#29 Samsung (30012810)", 1100, 10),
                film1350("#30 诚誉兴光电 (30012174)", 1130, 10),
                film1350("#31 青岛卓英社 (30011885)", 1140, 24),
                film1350("#32 Samsung (30016454)", 1140, 70),
                film1350("#33 Samsung (30016455)", 1140, 145),
                film1350("#34 诚誉兴光电 (30011886)", 1150, 20),
                film1350("#35 广州利辉电子 (30012696)", 1220, 6),
                film1350("#36 青岛卓英社 (30011891)", 1250, 10),
                film1350("#37 Samsung (30012809)", 1250, 70),
                film1350("#38 Samsung (30012815)", 1250, 84),
                film1350("#39 广州利辉电子 (30011891)", 1250, 20),
                film1350("#40 Samsung (30012809-B)", 1250, 50),
                film1350("#41 青岛卓英社 (30011892)", 1260, 4),
                film1350("#42 广州利辉电子 (30011892)", 1260, 50),
                film1350("#43 江苏南锦电子 (30011892)", 1260, 20),
                film1350("#44 广东轩朗实业 (30011892)", 1260, 20),
                film1350("#45 青岛卓英社 (30011893)", 1270, 30),
                film1350("#46 广东瑞捷新材 (30011893)", 1270, 38),
                film1350("#47 江苏南锦电子 (30011894)", 1280, 76),
                film1350("#48 青岛卓英社 (30011899)", 1470, 18),
                film1350("#49 诚誉兴光电 (30011899)", 1470, 14),
                film1350("#50 广东轩朗实业 (30012202)", 1480, 5)
        );
    }

    static List<SlittingProblem.Order> t2985Orders() {
        return List.of(
                film1350("#1 青岛卓英社 (30011867)", 740, 20),
                film1350("#2 广东轩朗实业 (30011868)", 750, 171),
                film1350("#3 南京福豪思新材 (30011868)", 750, 10),
                film1350("#4 广东瑞捷新材 (30011869)", 760, 20),
                film1350("#5 广州利辉电子 (30011869)", 760, 4),
                film1350("#6 江苏南锦电子 (30011869)", 760, 10),
                film1350("#7 广州利辉电子 (30012746)", 790, 8),
                film1350("#8 奥智高分子越南 (30011789)", 820, 20),
                film1350("#9 江苏南锦电子 (30011789)", 820, 40),
                film1350("#10 青岛卓英社 (30011789)", 820, 32),
                film1350("#11 广州利辉电子 (30012678)", 830, 66),
                film1350("#12 广州利辉电子 (30011871)", 840, 131),
                film1350("#13 奥智高分子越南 (30011872)", 850, 6),
                film1350("#14 广州利辉电子 (30011872)", 850, 14),
                film1350("#15 河源融创达科技 (30011872)", 850, 6),
                film1350("#16 青岛卓英社 (30011873)", 860, 2),
                film1350("#17 诚誉兴光电 (30011873)", 860, 13),
                film1350("#18 广州利辉电子 (30012224)", 870, 10),
                film1350("#19 南京福豪思新材 (30012224)", 870, 4),
                film1350("#20 广州利辉电子 (30012226)", 890, 8),
                film1350("#21 广州利辉电子 (30012711)", 900, 12),
                film1350("#22 惠州康冠科技 (30011876)", 910, 64),
                film1350("#23 江苏南锦电子 (30011876)", 910, 6),
                film1350("#24 青岛卓英社 (30011876)", 910, 51),
                film1350("#25 广东轩朗实业 (30012230)", 920, 16),
                film1350("#26 广州利辉电子 (30012230)", 920, 2),
                film1350("#27 河源融创达科技 (30012230)", 920, 10),
                film1350("#28 Samsung (30021103)", 930, 24),
                film1350("#29 广州利辉电子 (30011877)", 930, 24),
                film1350("#30 惠州康冠科技 (30011877)", 930, 20),
                film1350("#31 江苏南锦电子 (30011877)", 930, 30),
                film1350("#32 青岛卓英社 (30011877)", 930, 10),
                film1350("#33 江苏南锦电子 (30012232)", 950, 4),
                film1350("#34 广州利辉电子 (30011878)", 960, 36),
                film1350("#35 青岛卓英社 (30011878)", 960, 4),
                film1350("#36 Samsung (30011879)", 970, 20),
                film1350("#37 奥智高分子越南 (30012679)", 970, 8),
                film1350("#38 广州利辉电子 (30012679)", 970, 2),
                film1350("#39 诚誉兴光电 (30012679)", 970, 4),
                film1350("#40 苏州世沃电子 (30012679)", 970, 30),
                film1350("#41 广东轩朗实业 (30012680)", 980, 160),
                film1350("#42 广州利辉电子 (30012680)", 980, 40),
                film1350("#43 河源融创达科技 (30012680)", 980, 10),
                film1350("#44 青岛卓英社 (30012680)", 980, 40),
                film1350("#45 惠州骏通新材 (30011881)", 990, 40),
                film1350("#46 青岛卓英社 (30011881)", 990, 50),
                film1350("#47 诚誉兴光电 (30011881)", 990, 95),
                film1350("#48 广东瑞捷新材 (30011882)", 1000, 20),
                film1350("#49 广州利辉电子 (30011882)", 1000, 2),
                film1350("#50 翰邦国际 (30012169)", 1000, 6),
                film1350("#51 青岛卓英社 (30011882)", 1000, 6),
                film1350("#52 广州利辉电子 (30020388)", 1020, 2),
                film1350("#53 青岛卓英社 (30011900)", 1030, 8),
                film1350("#54 广州利辉电子 (30011883)", 1080, 4),
                film1350("#55 广州利辉电子 (30012481)", 1100, 20),
                film1350("#56 广州利辉电子 (30012681)", 1120, 6),
                film1350("#57 广州利辉电子 (30012174)", 1130, 10),
                film1350("#58 青岛卓英社 (30012174)", 1130, 16),
                film1350("#59 诚誉兴光电 (30012174)", 1130, 40),
                film1350("#60 广州利辉电子 (30011885)", 1140, 110),
                film1350("#61 河源融创达科技 (30011885)", 1140, 20),
                film1350("#62 江苏南锦电子 (30011885)", 1140, 6),
                film1350("#63 青岛卓英社 (30011885)", 1140, 66),
                film1350("#64 安徽宝彩科技 (30011886)", 1150, 10),
                film1350("#65 广东瑞捷新材 (30011886)", 1150, 50),
                film1350("#66 广东轩朗实业 (30011886)", 1150, 130),
                film1350("#67 广州利辉电子 (30011886)", 1150, 16),
                film1350("#68 嘉兴华顺光电 (30011886)", 1150, 31),
                film1350("#69 江苏南锦电子 (30011887)", 1160, 20),
                film1350("#70 安徽宝彩科技 (30011891)", 1250, 12),
                film1350("#71 广州利辉电子 (30011891)", 1250, 50),
                film1350("#72 青岛卓英社 (30011891)", 1250, 20),
                film1350("#73 广东轩朗实业 (30011892)", 1260, 150),
                film1350("#74 安徽宝彩科技 (30011893)", 1270, 10),
                film1350("#75 苏州世沃电子 (30011893)", 1270, 14),
                film1350("#76 青岛卓英社 (30012199)", 1460, 2),
                film1350("#77 安徽宝彩科技 (30011899)", 1470, 10),
                film1350("#78 青岛卓英社 (30011899)", 1470, 38),
                film1350("#79 诚誉兴光电 (30011899)", 1470, 16),
                film1350("#80 广东瑞捷新材 (30012202)", 1480, 8),
                film1350("#81 广东轩朗实业 (30012202)", 1480, 45),
                film1350("#82 江苏南锦电子 (30012202)", 1480, 10),
                film1350("#83 青岛卓英社 (30012202)", 1480, 20),
                film1350("#84 Samsung (30017109)", 1090, 80),
                film1350("#85 翰邦国际 (30011882-CSR188Y)", 1000, 10)
        );
    }
}
