package com.example.cutdemotwo.algorithm.solver;

import changyang.cut.apsmodule.generator.NewSolver.CuttingSolver;
import changyang.cut.apsmodule.service.*;
import changyang.cut.apsmodule.solver.kernel.*;
import changyang.cut.apsmodule.solver.kernel.execution.SolverExecutionContext;
import com.example.cutdemotwo.contracts.slitting.*;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Pure legacy-kernel adapter. A separate JVM owns all native threads for each computation. */
@Service
public class LinearSlittingSolverEngine implements ISlittingSolverEngine {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    @Override public String getEngineType(){return "ortools-1d";}
    @Override public boolean isAvailable(){return Files.isExecutable(javaExecutable());}
    private static Path javaExecutable(){return Path.of(System.getProperty("java.home"),"bin","java");}

    @Override public SlittingResult solve(SlittingProblem problem) {
        SlittingValidation.validateProblem(problem);
        Path directory=null;Process process=null;
        try {
            if(Thread.currentThread().isInterrupted())throw new CancellationException("计算开始前已取消");
            directory=Files.createTempDirectory("cutdemo-slitting-");
            Path input=directory.resolve("input.json"),output=directory.resolve("output.json");
            Files.write(input,JSON.writeValueAsBytes(problem));
            var command=command(input,output,ProcessHandle.current().pid());
            process=new ProcessBuilder(command).redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD).start();
            if(!process.waitFor(problem.timeLimitSeconds(),TimeUnit.SECONDS))
                throw new ComputationTimeout();
            if(process.exitValue()==124)throw new ComputationTimeout();
            if(process.exitValue()==2)throw new SlittingValidation.ValidationException("INVALID_RESULT","内核候选结果未通过独立验收，未发布结果");
            if(process.exitValue()!=0 || !Files.isRegularFile(output) || Files.size(output)>8_388_608)
                throw new IllegalStateException("一维计算进程失败或输出超限，exit="+process.exitValue());
            var result=JSON.readValue(Files.readAllBytes(output),SlittingResult.class);
            SlittingValidation.validateResult(problem,result);
            return result;
        } catch(InterruptedException interrupted) {
            Thread.currentThread().interrupt();throw new CancellationException("一维计算已取消");
        } catch(java.io.IOException error) {throw new IllegalStateException("一维计算进程启动或结果读取失败",error);}
        finally {
            // Keep the worker permit until the JVM and all its native solver threads are gone.
            boolean interrupted=Thread.interrupted();
            if(process!=null && process.isAlive()) {
                process.destroyForcibly();
                for(;;)try {process.waitFor();break;}catch(InterruptedException again){interrupted=true;}
            }
            if(directory!=null)try {
                Files.deleteIfExists(directory.resolve("input.json"));Files.deleteIfExists(directory.resolve("output.json"));
                Files.deleteIfExists(directory);
            }catch(java.io.IOException cleanup){org.slf4j.LoggerFactory.getLogger(getClass()).warn("Cannot remove computation directory {}",directory);}
            if(interrupted)Thread.currentThread().interrupt();
        }
    }
    public static final class ComputationTimeout extends RuntimeException {
        public ComputationTimeout(){super("一维计算达到时限；计算进程已退出");}
    }
    static List<String> command(Path input,Path output,long parentPid) throws java.io.IOException {
        String cp=System.getProperty("surefire.test.class.path",System.getProperty("java.class.path"));
        var args=new ArrayList<>(List.of(javaExecutable().toString(),"-Xmx512m","-XX:ActiveProcessorCount=2",
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
        var config=new SolverConfig(p.minWidthMm(),p.maxWidthMm(),p.widthStepMm(),p.motherWidthMm());
        config.setTotalOverCap(p.totalOverCap());config.setTimeoutMs(p.timeLimitSeconds()*1000L);config.setUseNewSolver(true);
        var items=new ArrayList<SolverOrderItem>();
        for(var o:p.orders()) {
            var item=new SolverOrderItem();item.setMessageText(o.id());item.setWidth(o.widthMm());item.setDemand(o.quantity());
            item.setLength(Math.toIntExact(o.lengthMm()/1000));item.setSurfaceTreatment(o.surfaceTreatment());
            item.setGroupKey(item.getLength()+"m+"+o.surfaceTreatment());items.add(item);
        }
        boolean fast="FAST".equals(p.profile());
        var options=new HashMap<String,String>();
        options.put("cutting.fast.preview",Boolean.toString(fast));options.put("cutting.quality.enabled",Boolean.toString(!fast));
        options.put("cutting.fast.budgetMs",Long.toString(p.timeLimitSeconds()*1000L));
        options.put("cutting.aLayerParityPenalties",fast?"0":"0,0.1");
        options.put("cutting.aLayerAlignmentLambdas","0");options.put("cutting.nestedWidthCandidateSteps","0");
        options.put("cutting.candidateOrders","1");options.put("cutting.spr.maxIterations","1");
        for(String key:List.of("cutting.lns.enabled","cutting.phase2.enabled","cutting.demandPeak.enabled",
                "cutting.demandPeak.smallPolish.enabled","cutting.parallel.aLayer.enabled","cutting.parallel.candidates.enabled",
                "cutting.parallel.sprCandidates.enabled","cutting.spr.parallel","cutting.lns.parallel","cutting.portfolio.enabled"))options.put(key,"false");
        options.put("cutting.spr.enabled",Boolean.toString(!fast));options.put("cutting.spr.reverseTiePass","true");
        var raw=new CurrentNewSolverKernelAdapter(new CuttingSolver()).solve(SolverKernelRequest.from(items,config,SolverExecutionContext.of(options)));
        if(!Set.of(SolverKernelStatus.SUCCEEDED,SolverKernelStatus.FEASIBLE,SolverKernelStatus.OPTIMAL).contains(raw.status()))
            throw new IllegalStateException("内核未返回候选结果："+raw.status());
        return convert(p,raw.instructions());
    }
    static SlittingResult convert(SlittingProblem p,List<CuttingInstruction> instructions) {
        var orders=new LinkedHashMap<String,SlittingProblem.Order>();p.orders().forEach(o->orders.put(o.id(),o));
        var patterns=new ArrayList<SlittingResult.Pattern>();var counts=new HashMap<String,Integer>();
        long mother=0,usable=0,piece=0;
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
            long length=Math.multiplyExact((long)i.getLength(),1000);
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
