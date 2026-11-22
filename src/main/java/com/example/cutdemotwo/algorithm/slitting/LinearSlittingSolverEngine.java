package com.example.cutdemotwo.algorithm.slitting;

import com.example.cutdemotwo.algorithm.ComputationCancellation;
import com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine;
import com.example.cutdemotwo.algorithm.api.ComputationTimeout;
import com.example.cutdemotwo.algorithm.runtime.IsolatedProcessRunner;

import changyang.cut.apsmodule.generator.NewSolver.CuttingSolver;
import changyang.cut.apsmodule.service.*;
import changyang.cut.apsmodule.solver.kernel.*;
import changyang.cut.apsmodule.solver.kernel.execution.SolverExecutionContext;
import com.example.cutdemotwo.contracts.slitting.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Pure legacy-kernel adapter. A separate JVM owns all native threads for each computation. */
@Service
public class LinearSlittingSolverEngine implements ISlittingSolverEngine {
    static final String DEFAULT_CHILD_XMX = "768m";
    private static final JsonMapper JSON=JsonMapper.builder().build();
    private final String childXmx;

    public LinearSlittingSolverEngine() {
        this(DEFAULT_CHILD_XMX);
    }

    @Autowired
    public LinearSlittingSolverEngine(@Value("${cutdemo.slitting.child-xmx:" + DEFAULT_CHILD_XMX + "}") String childXmx) {
        this.childXmx = normalizeChildXmx(childXmx);
    }

    static String normalizeChildXmx(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (!value.matches("[1-9][0-9]{1,4}[mMgG]")) {
            throw new IllegalArgumentException("无效的一维子进程堆上限配置 cutdemo.slitting.child-xmx: " + raw);
        }
        return value;
    }

    @Override public String getEngineType(){return "ortools-1d";}
    @Override public boolean isAvailable(){return Files.isExecutable(javaExecutable());}
    private static Path javaExecutable() {
        String launcher = System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java";
        return Path.of(System.getProperty("java.home"), "bin", launcher);
    }

    @Override public SlittingResult solve(SlittingProblem problem) {
        SlittingValidation.validateProblem(problem);
        Path directory = null;
        try {
            ComputationCancellation.check();
            directory = Files.createTempDirectory("cutdemo-slitting-");
            Path input = directory.resolve("input.json"), output = directory.resolve("output.json");
            Files.write(input, JSON.writeValueAsBytes(problem));
            var command = command(input, output, ProcessHandle.current().pid(), childXmx);
            ProcessBuilder pb = new ProcessBuilder(command)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD);
            // Keep the worker permit until the JVM and all its native solver threads are gone.
            var run = IsolatedProcessRunner.run(pb, TimeUnit.SECONDS.toMillis(problem.timeLimitSeconds()),
                    IsolatedProcessRunner.DEFAULT_POLL_MILLIS, true);
            if (run.timedOut() || run.exitCode() == 124) throw new ComputationTimeout();
            if (run.exitCode() == 2) throw new SlittingValidation.ValidationException("INVALID_RESULT", "内核候选结果未通过独立验收，未发布结果");
            if (run.exitCode() != 0 || !Files.isRegularFile(output) || Files.size(output) > 8_388_608)
                throw new IllegalStateException("一维计算进程失败或输出超限，exit=" + run.exitCode());
            var result = JSON.readValue(Files.readAllBytes(output), SlittingResult.class);
            SlittingValidation.validateResult(problem, result);
            return result;
        } catch (java.io.IOException error) {
            throw new IllegalStateException("一维计算进程启动或结果读取失败", error);
        } finally {
            IsolatedProcessRunner.deleteTempDirectory(directory);
        }
    }
    static List<String> command(Path input,Path output,long parentPid) throws java.io.IOException {
        return command(input,output,parentPid,DEFAULT_CHILD_XMX);
    }
    static List<String> command(Path input,Path output,long parentPid,String childXmx) throws java.io.IOException {
        String cp=System.getProperty("surefire.test.class.path",System.getProperty("java.class.path"));
        var args=new ArrayList<>(List.of(javaExecutable().toString(),"-Xmx"+normalizeChildXmx(childXmx),"-XX:ActiveProcessorCount=2",
                "-Dcutting.parallel.globalThreads=1"));
        boolean boot=false;
        if(!cp.contains(java.io.File.pathSeparator) && Files.isRegularFile(Path.of(cp)))
            try(var jar=new java.util.zip.ZipFile(cp)){boot=jar.getEntry("BOOT-INF/classes/")!=null;}
        if(boot)args.add("-Dloader.main="+LinearSlittingSolverEngine.class.getName());
        args.addAll(List.of("-cp",cp,boot?"org.springframework.boot.loader.launch.PropertiesLauncher":LinearSlittingSolverEngine.class.getName(),
                input.toString(),output.toString(),Long.toString(parentPid)));
        return args;
    }

    /** Child entry point deliberately starts no HTTP server, inventory service or Spring context. */
    public static void main(String[] args) throws Exception {
        var p=JSON.readValue(Files.readAllBytes(Path.of(args[0])),SlittingProblem.class);
        SlittingValidation.validateProblem(p);
        long parent=Long.parseLong(args[2]),deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(p.timeLimitSeconds());
        var watchdog=new Thread(()->{
            for(;;) {
                if(System.nanoTime()>=deadline || ProcessHandle.of(parent).filter(ProcessHandle::isAlive).isEmpty())Runtime.getRuntime().halt(124);
                try{Thread.sleep(100);}catch(InterruptedException ignored){return;}
            }
        },"slitting-parent-watch");watchdog.setDaemon(true);watchdog.start();
        try {
            var result=solveKernel(p);
            Files.write(Path.of(args[1]),JSON.writeValueAsBytes(result));
        } catch(SlittingValidation.ValidationException rejected) { System.exit(2); }
        System.exit(0);
    }
    static SlittingResult solveKernel(SlittingProblem p) {
        SlittingValidation.validateProblem(p);
        boolean fast = "FAST".equals(p.profile());
        var config = new SolverConfig(p.minWidthMm(), p.maxWidthMm(), p.widthStepMm(), p.motherWidthMm());
        config.setMode(p.minWidthMm() == p.maxWidthMm() ? "fixed" : "variable");

        long totalMs = p.timeLimitSeconds() * 1000L;
        long startupMarginMs = Math.min(4500L, Math.max(1500L, totalMs / 4));
        long internalBudgetMs = Math.max(500L, totalMs - startupMarginMs);
        long stageLimitMs = p.stageTimeLimitMs() != null ? p.stageTimeLimitMs() : 120_000L;
        // 隔离进程内多阶段串行共享总时限：按档位拆分单阶段帽，避免首阶段耗尽全部预算导致进程被强制终止。
        long effectiveStageMs = fast
                ? Math.max(1_000L, Math.min(stageLimitMs, internalBudgetMs))
                : Math.max(2_000L, Math.min(stageLimitMs, internalBudgetMs / 5));
        long effectiveStage4Ms = fast
                ? Math.max(1_000L, Math.min(30_000L, effectiveStageMs / 2))
                : Math.max(1_500L, Math.min(30_000L, effectiveStageMs / 2));
        long effectiveFastBudgetMs = fast
                ? internalBudgetMs
                : Math.min(10_000L, effectiveStageMs);

        config.setTotalOverCap(p.totalOverCap());
        config.setTimeoutMs(effectiveStageMs);
        config.setNewSolverStage4TimeLimit(effectiveStage4Ms);
        config.setUseNewSolver(true);
        config.setNewSolverTopK(p.topK() != null ? p.topK() : 3);
        config.setMaxIterations(p.maxIterations() != null ? p.maxIterations() : 300);
        config.setNewSolverMaxPatterns(p.maxPatterns() != null ? p.maxPatterns() : 800);
        int requestedDistinct = p.maxDistinctWidths() != null ? p.maxDistinctWidths() : 4;
        config.setNewSolverMaxDistinctWidths(fast ? requestedDistinct : Math.max(requestedDistinct, 5));
        if (p.useOptimizedAssignment() != null) {
            config.setNewSolverUseOptimizedAssignment(p.useOptimizedAssignment());
        }
        if (p.underPenalty() != null) {
            config.setNewSolverUnderPenalty(p.underPenalty());
        }
        if (p.seqGroupAlpha() != null) {
            config.setNewSolverSeqGroupAlpha(p.seqGroupAlpha());
        }
        if (p.seqGroupBeta() != null) {
            config.setNewSolverSeqGroupBeta(p.seqGroupBeta());
        }

        var items = new ArrayList<SolverOrderItem>();
        long lengthUnit = lengthUnitMm(p);
        for (var o : p.orders()) {
            var item = new SolverOrderItem();
            item.setMessageText(o.id());
            item.setWidth(o.widthMm());
            item.setDemand(o.quantity());
            item.setLength(Math.toIntExact(o.lengthMm() / lengthUnit));
            item.setSurfaceTreatment(o.surfaceTreatment());
            item.setGroupKey(item.getLength() + "m+" + o.surfaceTreatment());
            items.add(item);
        }

        boolean enableLns = !fast && Boolean.TRUE.equals(p.lnsEnabled());
        var options = new HashMap<String, String>();
        options.put("cutting.fast.preview", Boolean.toString(fast));
        options.put("cutting.quality", Boolean.toString(!fast));
        options.put("cutting.quality.legacyPipeline", "false");
        options.put("cutting.fast.budgetMs", Long.toString(effectiveFastBudgetMs));
        options.put("cutting.quality.budgetMs", Long.toString(internalBudgetMs));
        options.put("cutting.aLayerParityPenalties", fast ? "0" : "0,0.1");
        options.put("cutting.aLayerAlignmentLambdas", "0");
        options.put("cutting.nestedWidthCandidateSteps", "0");
        options.put("cutting.candidateOrders", "1");
        options.put("cutting.spr.enabled", "false");
        options.put("cutting.lns.enabled", Boolean.toString(enableLns));
        options.put("cutting.lns.enrichPatterns", "false");
        for (String key : List.of(
                "cutting.phase2.enabled",
                "cutting.demandPeak.enabled",
                "cutting.demandPeak.smallPolish.enabled",
                "cutting.parallel.aLayer.enabled",
                "cutting.parallel.candidates.enabled",
                "cutting.parallel.sprCandidates.enabled",
                "cutting.spr.parallel",
                "cutting.lns.parallel",
                "cutting.portfolio.enabled")) {
            options.put(key, "false");
        }
        var raw = new CurrentNewSolverKernelAdapter(new CuttingSolver())
                .solve(SolverKernelRequest.from(items, config, SolverExecutionContext.of(options)));
        if (!Set.of(SolverKernelStatus.SUCCEEDED, SolverKernelStatus.FEASIBLE, SolverKernelStatus.OPTIMAL).contains(raw.status()))
            throw new IllegalStateException("内核未返回候选结果：" + raw.status());
        return convert(p, raw.instructions());
    }
    // 内核按整数长度分组并透传；共用精确尺度，不改变整米请求原有编码，不舍入非整米长度。
    private static long lengthUnitMm(SlittingProblem p) {
        long unit=1000;
        for(var order:p.orders()) {
            long value=order.lengthMm();
            while(value!=0) {long remainder=unit%value;unit=value;value=remainder;}
        }
        return unit;
    }
    static SlittingResult convert(SlittingProblem p,List<CuttingInstruction> instructions) {
        var orders=new LinkedHashMap<String,SlittingProblem.Order>();p.orders().forEach(o->orders.put(o.id(),o));
        var patterns=new ArrayList<SlittingResult.Pattern>();var counts=new HashMap<String,Integer>();
        long mother=0,usable=0,piece=0;
        long lengthUnit=lengthUnitMm(p);
        for(var i:instructions) {
            var allocations=new LinkedHashMap<String,Integer>();
            for(var a:i.getStationAssignments()) {
                var o=orders.get(a.getMessageText());
                if(o==null || a.getWidth()!=o.widthMm())throw new SlittingValidation.ValidationException("INVALID_RESULT","内核订单身份或工位宽度不匹配");
                allocations.merge(o.id(),1,Math::addExact);counts.merge(o.id(),1,Math::addExact);
            }
            var stations=i.getSubRolls().entrySet().stream().sorted(Map.Entry.comparingByKey())
                    .map(e->new SlittingResult.Station(e.getKey(),e.getValue())).toList();
            int width=Math.toIntExact(stations.stream().mapToLong(s->Math.multiplyExact((long)s.widthMm(),s.countPerRepetition())).sum());
            long length=Math.multiplyExact((long)i.getLength(),lengthUnit);
            patterns.add(new SlittingResult.Pattern("PAT-"+(patterns.size()+1),i.getRollWidth(),width,length,
                    i.getSurfaceTreatment(),i.getUsageCount(),stations,
                    allocations.entrySet().stream().map(e->new SlittingResult.Allocation(e.getKey(),e.getValue())).toList()));
            long repeated=Math.multiplyExact(length,i.getUsageCount());
            mother=Math.addExact(mother,Math.multiplyExact((long)p.motherWidthMm(),repeated));
            usable=Math.addExact(usable,Math.multiplyExact((long)p.motherWidthMm()-p.leftTrimMm()-p.rightTrimMm(),repeated));
            piece=Math.addExact(piece,Math.multiplyExact((long)width,repeated));
        }
        var fulfillment=p.orders().stream().map(o->{int n=counts.getOrDefault(o.id(),0);return new SlittingResult.Fulfillment(
                o.id(),o.quantity(),n,Math.max(0,o.quantity()-n),Math.max(0,n-o.quantity()));}).toList();
        var result=new SlittingResult("1","mm","ortools-1d","newsolver-ortools-9.10",patterns.isEmpty()?"NO_SOLUTION_FOUND":"FEASIBLE",false,
                patterns,fulfillment,piece,mother,usable,fulfillment.stream().mapToInt(SlittingResult.Fulfillment::overproduced).sum());
        SlittingValidation.validateResult(p,result);return result;
    }
}
